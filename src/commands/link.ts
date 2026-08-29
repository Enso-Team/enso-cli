import { Command, InvalidArgumentError } from "commander";
import { BridgeClient } from "../client.js";
import { readContentValue } from "../content.js";
import {
  buildLinkCreateBody,
  buildLinkUpdateBody,
  parseWorldPoint,
  type LinkDirection,
  type LinkUpdateOptions,
  type WorldPoint
} from "../link-model.js";

function parseLinkDirection(value: string): LinkDirection {
  if (value === "directed" || value === "undirected" || value === "bidirectional") return value;
  throw new InvalidArgumentError("expected directed, undirected, or bidirectional");
}

function parseTargetPosition(value: string): WorldPoint {
  try {
    return parseWorldPoint(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : "Invalid target position");
  }
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
      "Update a link. --label is canvas-only. Use --bound-line to replace the owned relation line in the source note (must include [[Target]]). Use --sync-prose only when note text should mirror the canvas label. --source, --target, and --delink move one endpoint and rewrite the bound line themselves."
    )
    .argument("<link-id>")
    .option("--source <node>", "move the tail to this Node; the bound relation line moves to the new source Note")
    .option("--target <node>", "move the head to this Node; the [[wikilink]] in the bound line is rewritten")
    .option("--delink", "detach the head into open space; the wikilink token is removed and the prose stays")
    .option("--target-position <x,y>", "with --delink, where the dangling head points in World space", parseTargetPosition)
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
    .command("remove")
    .argument("<link-id>")
    .description("Remove the Canvas-local Link and preserve relation prose")
    .option("--dry-run", "validate without mutating")
    .action(async (linkId: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/links/${encodeURIComponent(linkId)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun), fromNote: false },
        dryRun: Boolean(options.dryRun)
      })
    );
  link
    .command("delete")
    .argument("<link-id>")
    .description("Delete the bound relation line from the source Note across canvases")
    .option("--dry-run", "validate without mutating")
    .action(async (linkId: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/links/${encodeURIComponent(linkId)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun), fromNote: true },
        dryRun: Boolean(options.dryRun)
      })
    );
}
