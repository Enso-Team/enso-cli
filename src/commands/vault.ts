import { Command } from "commander";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BridgeClient } from "../client.js";
import { EnsoCliError } from "../errors.js";

export function registerVault(program: Command): void {
  const vault = program.command("vault").description("Open and inspect Enso vaults");

  vault.command("current").action(async () => new BridgeClient().request("/v1/vault/current"));
  vault.command("tree").action(async () => new BridgeClient().request("/v1/vault/tree"));
  vault.command("open")
    .argument("<path>", "folder to open as a vault")
    .option("--dry-run", "validate folder access without switching vaults")
    .action(async (path: string, options: { dryRun?: boolean }) => {
      const folder = resolve(path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
      let directory = false;
      try { directory = statSync(folder).isDirectory(); } catch { directory = false; }
      if (!directory) throw new EnsoCliError("invalid_input", "Vault path must be an existing folder", { path: folder });
      return new BridgeClient().request("/v1/vault/open", {
        method: "POST", body: { path: folder, dryRun: Boolean(options.dryRun) }, dryRun: Boolean(options.dryRun)
      });
    });
}
