import { Command } from "commander";
import { parseNodeAppearance, parseGlyphSize, parseFontSize } from "../node-appearance.js";
import { BridgeClient } from "../client.js";

export function registerPortal(program: Command): void {
  const portal = program.command("portal").description("Manage Enso portal nodes");

  portal
    .command("create")
    .requiredOption("--title <title>")
    .option("--glyph-size <points>", "Icon width in World points", parseGlyphSize)
    .option("--font-size <points>", "Title size in World points", parseFontSize)
    .option("--appearance <value>", "Node visual form", parseNodeAppearance)
    .requiredOption("--subcanvas-ref <canvas-ref>")
    .option("--canvas <selector|current>", "target canvas", "current")
    .option("--dry-run", "validate without mutating")
    .action(async (options: { appearance?: string; glyphSize?: number; fontSize?: number; title: string; subcanvasRef: string; canvas?: string; dryRun?: boolean }) =>
      new BridgeClient().request("/v1/nodes", {
        method: "POST",
        body: {
          kind: "portal",
          title: options.title,
          ...(options.appearance !== undefined ? { appearance: options.appearance } : {}),
          ...(options.glyphSize !== undefined ? { glyphSize: options.glyphSize } : {}),
          ...(options.fontSize !== undefined ? { fontSize: options.fontSize } : {}),
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
    .command("remove")
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
