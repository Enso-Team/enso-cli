import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/index.js";
import * as skillAgents from "../../src/skill-agents.js";
import { run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();
beforeEach(() => vi.spyOn(skillAgents, "discoverSkillAgents").mockReturnValue({ agents: ["codex", "claude-code"], skippedAgents: [] }));

function mockInstaller(stdout?: string, exitCode = 0, failedAgent?: string): string {
  const executable = join(tempDir, "mock-npx.js");
  const argsFile = join(tempDir, "mock-npx-args.json");
  writeFileSync(argsFile, "[]");
  writeFileSync(executable, [
    "#!/usr/bin/env node",
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const calls = JSON.parse(readFileSync(process.env.MOCK_NPX_ARGS_FILE, 'utf8'));",
    "calls.push(args); writeFileSync(process.env.MOCK_NPX_ARGS_FILE, JSON.stringify(calls));",
    "const agent = args.at(-1);",
    `const failed = agent === ${JSON.stringify(failedAgent)};`,
    "const results = [{ name: 'enso', status: failed ? 'failed' : 'installed', path: '/skills/' + agent + '/enso', ...(failed ? { error: 'Permission denied' } : {}) }];",
    `process.stdout.write(${stdout === undefined ? "JSON.stringify(results)" : JSON.stringify(stdout)});`,
    `process.exitCode = ${exitCode};`
  ].join("\n"), "utf8");
  chmodSync(executable, 0o755);
  process.env.ENSO_CLI_SKILL_INSTALLER_BIN = executable;
  process.env.MOCK_NPX_ARGS_FILE = argsFile;
  return argsFile;
}

describe("skill", () => {
  it("does not expose the raw apply command", () => {
    expect(buildProgram().commands.map(command => command.name())).not.toContain("apply");
  });
  it("bundles the references linked from the skill", () => {
    const skillPath = join(process.cwd(), "skills/enso/SKILL.md");
    const skill = readFileSync(skillPath, "utf8");
    expect(skill).toMatch(/^---\nname: enso\ndescription: .+\n---\n/);
    const references = [...skill.matchAll(/\]\((references\/[^)]+\.md)\)/g)];
    expect(references.length).toBeGreaterThan(0);
    for (const [, reference] of references) expect(existsSync(resolve(dirname(skillPath), reference)), reference).toBe(true);
  });
  it("installs to every detected global agent using explicit targets", async () => {
    vi.mocked(skillAgents.discoverSkillAgents).mockReturnValue({ agents: ["codex", "claude-code", "gemini-cli"], skippedAgents: ["promptscript"] });
    const argsFile = mockInstaller();
    const result = await run(["skill", "install"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      installed: true,
      results: [
        { agent: "codex", status: "installed" },
        { agent: "claude-code", status: "installed" },
        { agent: "gemini-cli", status: "installed" }
      ],
      skippedAgents: [{ agent: "promptscript", reason: "project_only" }]
    });
    const calls = JSON.parse(readFileSync(argsFile, "utf8")) as string[][];
    expect(calls.map(args => args.at(-1))).toEqual(["codex", "claude-code", "gemini-cli"]);
    for (const args of calls) {
      expect(args.slice(0, 3)).toEqual(["--yes", "skills@1.7.1", "add"]);
      expect(args[3]).toMatch(/skills\/enso$/);
      expect(args.slice(4, -1)).toEqual(["-g", "-y", "--copy", "--json", "--agent"]);
    }
  });
  it("uses explicitly selected agents and deduplicates them", async () => {
    const argsFile = mockInstaller();
    const result = await run(["skill", "install", "--agent", "cursor", "codex", "cursor"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(argsFile, "utf8")).map((args: string[]) => args.at(-1))).toEqual(["cursor", "codex"]);
    expect(skillAgents.discoverSkillAgents).not.toHaveBeenCalled();
  });
  it("reports each target and continues installation when a target fails", async () => {
    vi.mocked(skillAgents.discoverSkillAgents).mockReturnValue({ agents: ["codex", "claude-code", "gemini-cli"], skippedAgents: [] });
    mockInstaller(undefined, 0, "claude-code");
    const result = await run(["skill", "install"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "skill_install_failed", details: { results: [
      { agent: "codex", status: "installed" },
      { agent: "claude-code", status: "failed", error: "Permission denied" },
      { agent: "gemini-cli", status: "installed" }
    ] } } });
  });
  it.each(["failed", "skipped"])("reports a %s installer result with a zero exit code", async status => {
    mockInstaller(JSON.stringify([{ name: "enso", status, error: "Agent installation requires attention" }]));
    const result = await run(["skill", "install", "--agent", "codex"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.details.results[0]).toMatchObject({ agent: "codex", status: "failed", exitCode: 0 });
  });
  it("preserves an installer error from a failing process", async () => {
    mockInstaller(JSON.stringify([{ name: "enso", status: "failed", error: "Permission denied" }]), 1);
    const result = await run(["skill", "install", "--agent", "codex"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.details.results[0]).toMatchObject({ agent: "codex", status: "failed", error: "Permission denied", exitCode: 1 });
  });
  it.each(["not json", "[]"])("reports an unconfirmed installer response: %s", async stdout => {
    mockInstaller(stdout);
    const result = await run(["skill", "install", "--agent", "codex"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.details.results[0]).toMatchObject({ status: "failed", stdout });
  });
  it("reports agent discovery requiring setup before running an installer", async () => {
    vi.mocked(skillAgents.discoverSkillAgents).mockReturnValue({ agents: [], skippedAgents: ["promptscript"] });
    const argsFile = mockInstaller();
    const result = await run(["skill", "install"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("agents_not_found");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([]);
  });
});
