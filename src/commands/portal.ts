import { Command } from "commander";
import { BridgeClient } from "../client.js";

export function registerPortal(program: Command): void {
  const portal = program.command("portal").description("Manage Enso portal nodes");

  portal
    .command("create")
    .requiredOption("--title <title>")
    .requiredOption("--subcanvas-ref <canvas-ref>")
    .option("--canvas <selector|current>", "target canvas", "current")
    .option("--dry-run", "validate without mutating")
    .action(async (options: { title: string; subcanvasRef: string; canvas?: string; dryRun?: boolean }) =>
      new BridgeClient().request("/v1/nodes", {
        method: "POST",
        body: {
          kind: "portal",
          title: options.title,
          subcanvasRef: options.subcanvasRef,
          canvas: options.canvas ?? "current",
          dryRun: Boolean(options.dryRun)
        },
        dryRun: Boolean(options.dryRun)
      })
    );

  portal
    .command("open")
    .argument("<selector>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}/subcanvas/open`, {
        method: "POST",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );

  portal
    .command("change-subcanvas")
    .argument("<selector>")
    .argument("<canvas-ref>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, canvasRef: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}`, {
        method: "PUT",
        body: { subcanvasRef: canvasRef, dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );

  portal
    .command("delete")
    .argument("<selector>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
}
