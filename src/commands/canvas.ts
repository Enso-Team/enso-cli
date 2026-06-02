import { Command } from "commander";
import { BridgeClient } from "../client.js";

export function registerCanvas(program: Command): void {
  const canvas = program.command("canvas").description("Manage Enso canvases");

  canvas.command("list").action(async () => new BridgeClient().request("/v1/canvases"));
  canvas.command("current").action(async () => new BridgeClient().request("/v1/canvases/current"));
  canvas
    .command("create")
    .argument("<name>")
    .option("--dry-run", "validate without mutating")
    .action(async (name: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request("/v1/canvases", {
        method: "POST",
        body: { name, dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
  canvas
    .command("open")
    .argument("<selector>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/canvases/${encodeURIComponent(selector)}/open`, {
        method: "POST",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
  canvas
    .command("inspect")
    .argument("<selector>")
    .action(async (selector: string) =>
      new BridgeClient().request(`/v1/canvases/${encodeURIComponent(selector)}/inspect`)
    );
  canvas
    .command("delete")
    .argument("<selector>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/canvases/${encodeURIComponent(selector)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
}
