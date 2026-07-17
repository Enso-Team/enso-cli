import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/index.js";
import { run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

describe("skill", () => {
  it("does not expose the raw apply command", () => {
    expect(buildProgram().commands.map((command) => command.name())).not.toContain("apply");
  });
  it("uses one temporary file for the default Canvas pass", () => {
    const skill = readFileSync(join(process.cwd(), "skills/enso/SKILL.md"), "utf8");
    const metadata = readFileSync(join(process.cwd(), "skills/enso/agents/openai.yaml"), "utf8");
    const diagramDesign = readFileSync(join(process.cwd(), "skills/enso/references/diagram-design.md"), "utf8");
    expect(skill).toContain("name: enso\n");
    expect(skill).toContain('Treat "in Enso" as a destination and perform the work through the Enso app');
    expect(skill).toContain("For explain, show, map, or illustrate requests, create or update an Enso Canvas");
    expect(metadata).toContain('Treat "in Enso" as a destination and perform the work through the Enso app');
    expect(diagramDesign).toContain("Give each region an intentional color and low fill opacity");
    expect(diagramDesign).toContain("every region has a semantic color");
    expect(skill).toContain("enso canvas apply /tmp/enso-<task>-intent.json --dry-run");
    expect(skill).toContain("enso canvas apply /tmp/enso-<task>-intent.json\n");
    expect(skill).toContain("Confirm `/tmp/enso-<task>-intent.json` no longer exists");
    expect(skill).not.toContain("rm -f /tmp/enso-<task>-intent.json");
    expect(skill).toContain("Use diagnostics to focus screenshot review");
    expect(skill).not.toContain("canvas apply --json -");
    expect(skill).not.toContain("Compose one JSON intent in memory");
  });
  it("installs the bundled skill through the npx skills installer", async () => {
    const mockInstaller = join(tempDir, "mock-npx.js");
    const argsFile = join(tempDir, "mock-npx-args.json");
    writeFileSync(mockInstaller, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.MOCK_NPX_ARGS_FILE, JSON.stringify(process.argv.slice(2), null, 2));",
      "process.stdout.write('skills installer stdout');",
      "process.stderr.write('skills installer stderr');"
    ].join("\n"), "utf8");
    chmodSync(mockInstaller, 0o755);
    process.env.ENSO_CLI_SKILL_INSTALLER_BIN = mockInstaller;
    process.env.MOCK_NPX_ARGS_FILE = argsFile;

    const result = await run(["skill", "install"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        installed: true,
        installer: mockInstaller,
        stdout: "skills installer stdout",
        stderr: "skills installer stderr"
      }
    });

    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args[0]).toBe("--yes");
    expect(args[1]).toBe("skills");
    expect(args[2]).toBe("add");
    expect(args[3]).toMatch(/skills\/enso$/);
    expect(args.slice(4)).toEqual(["-g", "-y", "--copy"]);
  });
});
