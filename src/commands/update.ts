import type { Command } from "commander";
import { updateCli } from "../update.js";

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("update a global npm installation to the latest CLI release")
    .option("--check", "check the available version")
    .action(async (options: { check?: boolean }) => ({ ok: true as const, data: await updateCli(Boolean(options.check)) }));
}
