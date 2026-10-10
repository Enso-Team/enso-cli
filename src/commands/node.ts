import { Command, InvalidArgumentError } from "commander";
import { parseNodeAppearance, parseGlyphSize, parseFontSize, parseTitleGap, parseRatioLock } from "../node-appearance.js";
import { BridgeClient } from "../client.js";
import { placementSelector } from "../note-identity.js";
import { validateNotePath } from "../filenames.js";

function parseCoord(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new InvalidArgumentError(`${name} must be a number`);
  return parsed;
}

export function registerNode(program: Command): void {
  const node = program.command("node").description("Manage Enso nodes");

  node
    .command("list")
    .option("--canvas <selector>")
    .action(async (options: { canvas?: string }) =>
      new BridgeClient().request("/v1/nodes", { query: { canvas: options.canvas } })
    );
  node
    .command("place")
    .description("Place a Note that exists in the Vault on a Canvas. Write the markdown file first.")
    .argument("<note>", "the Note's title or Vault-relative path, e.g. docs/Service.md")
    .option("--glyph-size <points>", "Icon width in World points", parseGlyphSize)
    .option("--font-size <points>", "Title size in World points", parseFontSize)
    .option("--title-gap <points>", "Icon/title gap in World points", parseTitleGap)
    .option("--lock-ratio <boolean>", "Scale the whole Node proportionally: true or false", parseRatioLock)
    .option("--appearance <value>", "Node visual form; card resets it", parseNodeAppearance)
    .option("--canvas <selector|current>", "target canvas", "current")
    .option("--x <number>", "world-space center x (omit to auto-place at viewport center)")
    .option("--y <number>", "world-space center y (omit to auto-place at viewport center)")
    .option("--dry-run", "validate without mutating")
    .action(async (note: string, options: { appearance?: string; glyphSize?: number; fontSize?: number; titleGap?: number; lockRatio?: boolean; canvas?: string; x?: string; y?: string; dryRun?: boolean }) => {
      validateNotePath(note, "note");
      const x = parseCoord(options.x, "x");
      const y = parseCoord(options.y, "y");
      return new BridgeClient().request("/v1/nodes", {
        method: "POST",
        body: {
          kind: "note",
          title: placementSelector(note),
          ...(options.appearance !== undefined ? { appearance: options.appearance } : {}),
          ...(options.glyphSize !== undefined ? { glyphSize: options.glyphSize } : {}),
          ...(options.fontSize !== undefined ? { fontSize: options.fontSize } : {}),
          ...(options.titleGap !== undefined ? { titleGap: options.titleGap } : {}),
          ...(options.lockRatio !== undefined ? { isResizeLocked: options.lockRatio } : {}),
          canvas: options.canvas ?? "current",
          placeExisting: true,
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
          dryRun: Boolean(options.dryRun)
        },
        dryRun: Boolean(options.dryRun)
      });
    });
  node
    .command("update")
    .argument("<selector>")
    .option("--appearance <value>", "Node visual form; card resets it", parseNodeAppearance)
    .option("--glyph-size <points>", "Icon width in World points", parseGlyphSize)
    .option("--clear-glyph-size", "Derive icon size from title font size")
    .option("--font-size <points>", "Title size in World points", parseFontSize)
    .option("--title-gap <points>", "Icon/title gap in World points", parseTitleGap)
    .option("--lock-ratio <boolean>", "Scale the whole Node proportionally: true or false", parseRatioLock)
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { appearance?: string; glyphSize?: number; clearGlyphSize?: boolean; fontSize?: number; titleGap?: number; lockRatio?: boolean; dryRun?: boolean }) => {
      if (options.clearGlyphSize && options.glyphSize !== undefined) throw new InvalidArgumentError("Choose glyph-size or clear-glyph-size");
      if (options.appearance === undefined && options.glyphSize === undefined && !options.clearGlyphSize && options.fontSize === undefined && options.titleGap === undefined && options.lockRatio === undefined) {
        throw new InvalidArgumentError("Provide appearance, glyph-size, clear-glyph-size, font-size, title-gap, or lock-ratio");
      }
      return new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}`, {
        method: "PUT",
        body: {
          ...(options.appearance !== undefined ? { appearance: options.appearance } : {}),
          ...(options.clearGlyphSize ? { glyphSize: null } : options.glyphSize !== undefined ? { glyphSize: options.glyphSize } : {}),
          ...(options.fontSize !== undefined ? { fontSize: options.fontSize } : {}),
          ...(options.titleGap !== undefined ? { titleGap: options.titleGap } : {}),
          ...(options.lockRatio !== undefined ? { isResizeLocked: options.lockRatio } : {}),
          dryRun: Boolean(options.dryRun)
        },
        dryRun: Boolean(options.dryRun)
      });
    });
  node
    .command("move")
    .description("Move a Node on the current Canvas. There is no --canvas flag: the Canvas the app has open is the one edited.")
    .argument("<selector>")
    .requiredOption("--x <number>", "world-space center x")
    .requiredOption("--y <number>", "world-space center y")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { x: string; y: string; dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}`, {
        method: "PUT",
        body: { x: Number(options.x), y: Number(options.y), dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
  node
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
  node
    .command("neighbors")
    .argument("<selector>")
    .option("--depth <n>", "neighbor traversal depth", "1")
    .action(async (selector: string, options: { depth: string }) =>
      new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}/neighbors`, {
        query: { depth: Number(options.depth) }
      })
    );
}
