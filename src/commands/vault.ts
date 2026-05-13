import { Command } from "commander";
import { BridgeClient } from "../client.js";

export function registerVault(program: Command): void {
  const vault = program.command("vault").description("Inspect the current Enso vault");

  vault.command("current").action(async () => new BridgeClient().request("/v1/vault/current"));
  vault.command("tree").action(async () => new BridgeClient().request("/v1/vault/tree"));
}
