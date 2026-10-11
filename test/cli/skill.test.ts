import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
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
  it("requires the packaged skill inside its own installation", async () => {
    execFileSync("npm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });
    const fixture = join(tempDir, "package");
    mkdirSync(join(fixture, "dist"), { recursive: true });
    writeFileSync(join(fixture, "dist/index.js"), readFileSync("dist/index.js"));
    writeFileSync(join(fixture, "package.json"), readFileSync("package.json"));
    symlinkSync(join(process.cwd(), "node_modules"), join(fixture, "node_modules"));
    const otherSkill = join(tempDir, "skills/enso");
    mkdirSync(otherSkill, { recursive: true });
    writeFileSync(join(otherSkill, "SKILL.md"), "# Another source");
    const argsFile = mockInstaller();
    const result = spawnSync(process.execPath, [join(fixture, "dist/index.js"), "skill", "install", "--agent", "codex", "--installer", "npm"], { encoding: "utf8", env: { ...process.env, ENSO_CLI_NO_UPDATE_CHECK: "1" } });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("skill_not_found");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([]);
  }, 30000);
  it("validates setup targets before contacting or launching the app", async () => {
    const result = await run(["setup", "--agent", "claude"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_agent");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it("reports unknown app capabilities explicitly", async () => {
    mockInstaller();
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: true, data: { contractVersion: 2 } }));
    const result = await run(["setup", "--agent", "codex"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ appVersion: "unknown", buildVersion: "unknown", capabilities: { status: "unknown", values: [] } });
  });
  it("preserves disabled agent access and reports the app blocker without installing", async () => {
    const argsFile = mockInstaller();
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: false, error: { code: "access_disabled", message: "Local agent access is disabled", details: { hint: "Enable Local agent access in Enso Settings" } } }));
    const result = await run(["setup", "--agent", "codex"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "access_disabled", details: { stage: "app", hint: "Enable Local agent access in Enso Settings" } });
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
  it("completes setup with pairing, installed skill provenance, and explicit capability status", async () => {
    mockInstaller();
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: true, data: { appVersion: "1.5", contractVersion: 2, capabilities: ["mark.update"] } }));
    const result = await run(["setup", "--agent", "codex"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ ready: true, pairing: "linked", cliVersion: "0.8.1", capabilities: { status: "reported", values: ["mark.update"] }, skill: { installed: true } });
  });
  it("uses Bun's executable without npx-specific flags when requested", async () => {
    const argsFile = mockInstaller();
    const result = await run(["skill", "install", "--agent", "codex", "--installer", "bun"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(argsFile, "utf8"))[0].slice(0, 2)).toEqual(["skills@1.7.1", "add"]);
  });
  it("installs the package-owned skill when the working directory contains another Enso skill", async () => {
    const argsFile = mockInstaller();
    const projectSkill = join(tempDir, "skills", "enso");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(join(projectSkill, "SKILL.md"), "# Project skill");
    const cwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await run(["skill", "install", "--agent", "codex"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(readFileSync(argsFile, "utf8"))[0][3]).toBe(join(cwd, "skills", "enso"));
      expect(JSON.parse(result.stdout).data.provenance).toMatchObject({ cliVersion: "0.8.1", source: join(cwd, "skills", "enso") });
    } finally { process.chdir(cwd); }
  });
  it("rejects unknown explicit targets before installation", async () => {
    const argsFile = mockInstaller();
    const result = await run(["skill", "install", "--agent", "claude"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "invalid_agent", details: { agent: "claude" } });
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([]);
  });
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
