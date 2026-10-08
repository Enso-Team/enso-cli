import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/index.js";
import { run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

describe("skill", () => {
  it("does not expose the raw apply command", () => {
    expect(buildProgram().commands.map((command) => command.name())).not.toContain("apply");
  });
  it("bundles the references linked from the skill", () => {
    const skillPath = join(process.cwd(), "skills/enso/SKILL.md");
    const skill = readFileSync(skillPath, "utf8");
    expect(skill).toMatch(/^---\nname: enso\ndescription: .+\n---\n/);
    const references = [...skill.matchAll(/\]\((references\/[^)]+\.md)\)/g)];
    expect(references.length).toBeGreaterThan(0);
    for (const [, reference] of references) {
      expect(existsSync(resolve(dirname(skillPath), reference)), reference).toBe(true);
    }
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
