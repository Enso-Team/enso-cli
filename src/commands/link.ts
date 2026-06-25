import { Command, InvalidArgumentError } from "commander";
import { BridgeClient } from "../client.js";
import { readContentValue } from "../content.js";
import {
  buildLinkCreateBody,
  buildLinkUpdateBody,
  type LinkDirection,
  type LinkUpdateOptions
} from "../link-model.js";

function parseLinkDirection(value: string): LinkDirection {
  if (value === "directed" || value === "undirected" || value === "bidirectional") return value;
  throw new InvalidArgumentError("expected directed, undirected, or bidirectional");
}

export function registerLink(program: Command): void {
  const link = program.command("link").description("Manage Enso canvas links and relation bindings");

  link
    .command("list")
    .description("List links on a canvas (includes isUnbound and primaryBinding when present)")
    .option("--canvas <selector|current>")
    .action(async (options: { canvas?: string }) =>
      new BridgeClient().request("/v1/links", { query: { canvas: options.canvas } })
    );
  link
    .command("create")
    .description(
      "Create an interfile link. Always establishes primaryBinding and inserts Related: [[Target]] in the source note. May return duplicate_link if the pair already exists."
    )
    .argument("<source-node>")
    .argument("<target-node>")
    .option("--label <label>", "canvas label only (does not rewrite bound note text)")
    .option("--color <color>", "relationship line color, such as #3B82F6 or blue")
    .option("--direction <direction>", "arrow direction: directed, undirected, or bidirectional", parseLinkDirection)
    .option("--dry-run", "validate without mutating")
    .action(async (source: string, target: string, options: LinkUpdateOptions) =>
      new BridgeClient().request("/v1/links", {
        method: "POST",
        body: buildLinkCreateBody(source, target, options),
        dryRun: Boolean(options.dryRun)
      })
    );
  link
    .command("update")
    .description(
      "Update a link. --label is canvas-only. Use --bound-line to replace the owned relation line in the source note (must include [[Target]]). Use --sync-prose only when note text should mirror the canvas label."
    )
    .argument("<link-id>")
    .option("--label <label>", "set canvas label only (does not rewrite note markdown)")
    .option("--clear-label", "clear canvas label (binding and note line unchanged)")
    .option(
      "--bound-line <string|@file>",
      "replace bound relation line in source note; wikilink may appear anywhere in the line"
    )
    .option("--sync-prose", "rewrite bound line from canvas label or Related fallback (not custom prose)")
    .option("--color <color>", "relationship line color, such as #3B82F6 or blue")
    .option("--direction <direction>", "arrow direction: directed, undirected, or bidirectional", parseLinkDirection)
    .option("--dry-run", "validate without mutating")
    .action(async (linkId: string, options: LinkUpdateOptions & { boundLine?: string }) => {
      let body: Record<string, unknown>;
      try {
        body = buildLinkUpdateBody({
          ...options,
          boundLine: options.boundLine !== undefined ? readContentValue(options.boundLine) : undefined
        });
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : "Invalid link update options");
      }
      return new BridgeClient().request(`/v1/links/${encodeURIComponent(linkId)}`, {
        method: "PUT",
        body,
        dryRun: Boolean(options.dryRun)
      });
    });
  link
    .command("delete")
    .argument("<link-id>")
    .option("--from-note", "also strip the bound relation line from the note text (affects every canvas); default removes the link from this canvas only")
    .option("--dry-run", "validate without mutating")
    .action(async (linkId: string, options: { dryRun?: boolean; fromNote?: boolean }) =>
      new BridgeClient().request(`/v1/links/${encodeURIComponent(linkId)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun), fromNote: Boolean(options.fromNote) },
        dryRun: Boolean(options.dryRun)
      })
    );
}
