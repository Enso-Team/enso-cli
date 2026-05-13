import { Command } from "commander";
import { BridgeClient } from "../client.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show Enso bridge and app status")
    .action(async function () {
      return new BridgeClient().request("/v1/status");
    });
}
