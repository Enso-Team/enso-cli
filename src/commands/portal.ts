import { Command } from "commander";
import { parseNodeAppearance, parseGlyphSize, parseFontSize, parseTitleGap, parseRatioLock } from "../node-appearance.js";
import { validateFilename } from "../filenames.js";
import { BridgeClient } from "../client.js";

export function registerPortal(program: Command): void {
  const portal = program.command("portal").description("Manage Enso portal nodes");

  portal
    .command("create")
    .requiredOption("--title <title>")
    .option("--glyph-size <points>", "Icon width in World points", parseGlyphSize)
    .option("--font-size <points>", "Title size in World points", parseFontSize)
    .option("--title-gap <points>", "Icon/title gap in World points", parseTitleGap)
    .option("--lock-ratio <boolean>", "Scale the whole Node proportionally: true or false", parseRatioLock)
    .option("--appearance <value>", "Node visual form", parseNodeAppearance)
    .requiredOption("--subcanvas-ref <canvas-ref>")
    .option("--canvas <selector|current>", "target canvas", "current")
    .option("--dry-run", "validate without mutating")
    .action(async (options: { appearance?: string; glyphSize?: number; fontSize?: number; titleGap?: number; lockRatio?: boolean; title: string; subcanvasRef: string; canvas?: string; dryRun?: boolean }) => {
      validateFilename(options.title, "title");
      return new BridgeClient().request("/v1/nodes", {
        method: "POST",
        body: {
          kind: "portal",
          title: options.title,
          ...(options.appearance !== undefined ? { appearance: options.appearance } : {}),
          ...(options.glyphSize !== undefined ? { glyphSize: options.glyphSize } : {}),
          ...(options.fontSize !== undefined ? { fontSize: options.fontSize } : {}),
          ...(options.titleGap !== undefined ? { titleGap: options.titleGap } : {}),
          ...(options.lockRatio !== undefined ? { isResizeLocked: options.lockRatio } : {}),
          subcanvasRef: options.subcanvasRef,
          canvas: options.canvas ?? "current",
          dryRun: Boolean(options.dryRun)
        },
        dryRun: Boolean(options.dryRun)
      });
    });

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
