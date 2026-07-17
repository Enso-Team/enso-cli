import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { EnsoEnvelope } from "../errors.js";

const execFileAsync = promisify(execFile);

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function findSkillPath(): string {
  const candidates = [
    resolve(process.cwd(), "skills", "enso"),
    resolve(packageRoot(), "skills", "enso"),
    resolve(packageRoot(), "..", "skills", "enso")
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "SKILL.md"))) ?? candidates[0];
}

export function registerSkill(program: Command): void {
  const skill = program.command("skill").description("Install the bundled Enso skill");

  skill.command("install").action(async (): Promise<EnsoEnvelope> => {
    const source = findSkillPath();

    if (!existsSync(join(source, "SKILL.md"))) {
      return {
        ok: false,
        error: {
          code: "skill_not_found",
          message: "Bundled Enso skill was not found",
          details: { skillPath: source }
        }
      };
    }

    const installer = process.env.ENSO_CLI_SKILL_INSTALLER_BIN ?? (process.platform === "win32" ? "npx.cmd" : "npx");
    const args = ["--yes", "skills", "add", source, "-g", "-y", "--copy"];

    try {
      const { stdout, stderr } = await execFileAsync(installer, args, { maxBuffer: 1024 * 1024 * 10 });
      return {
        ok: true,
        data: {
          installed: true,
          source,
          installer,
          args,
          stdout,
          stderr
        }
      };
    } catch (error) {
      const failure = error as { message?: string; stdout?: string; stderr?: string; code?: number | string };
      return {
        ok: false,
        error: {
          code: "skill_install_failed",
          message: "Could not install the Enso skill with npx skills",
          details: {
            source,
            installer,
            args,
            exitCode: failure.code,
            stdout: failure.stdout,
            stderr: failure.stderr,
            cause: failure.message
          }
        }
      };
    }
  });
}
