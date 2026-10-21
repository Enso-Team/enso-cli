import type { Command } from "commander";
import { updateCli } from "../update.js";
import { refreshInstalledSkill } from "./skill.js";

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("update a global npm installation to the latest CLI release and refresh the installed skill")
    .option("--check", "check the available version")
    .action(async (options: { check?: boolean }) => {
      const result = await updateCli(Boolean(options.check));
      if (!result.updated) return { ok: true as const, data: result };
      // The upgrade has landed, so a skill refresh failure is reported alongside it.
      const skill = await refreshInstalledSkill().catch((error: unknown) => ({
        refreshed: false,
        error: error instanceof Error ? error.message : String(error),
        hint: "Run `enso skill install` to copy the new skill"
      }));
      return { ok: true as const, data: { ...result, skill } };
    });
}
