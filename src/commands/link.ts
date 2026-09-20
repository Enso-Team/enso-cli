import { Command, InvalidArgumentError } from "commander";
import { BridgeClient } from "../client.js";
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
  const link = program.command("link").description("Manage Enso canvas Links, the visual form of wikilinks between placed Notes");

  link
    .command("list")
    .description("List Links on a canvas. Each carries displayLabel and the mentioning sentences.")
    .option("--canvas <selector|current>")
    .action(async (options: { canvas?: string }) =>
      new BridgeClient().request("/v1/links", { query: { canvas: options.canvas } })
    );
  link
    .command("create")
    .description(
      "Show a Link over a pair the source Note already mentions with [[Target]]. Returns wikilink_required when it does not: write the sentence first. A mention alone draws nothing."
    )
    .argument("<source-node>")
    .argument("<target-node>")
    .option("--label <label>", "label override on the curve; empty shows the sentence from the Note")
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
      "Update a Link's presentation. --label sets the override and never edits the Note. --source, --target, and --delink move one endpoint and edit the first mention themselves."
    )
    .argument("<link-id>")
    .option("--source <node>", "move the tail to this Node; the old sentence stays and the new source gets one when it needs it")
    .option("--target <node>", "move the head to this Node; the token in the first mention is rewritten")
    .option("--delink", "detach the head into open space; the token leaves the first mention and the prose stays")
    .option("--target-position <x,y>", "with --delink, where the dangling head points in World space", parseTargetPosition)
    .option("--label <label>", "set the label override (never edits the Note)")
    .option("--clear-label", "clear the override so the curve shows the sentence from the Note")
    .option("--color <color>", "relationship line color, such as #3B82F6 or blue")
    .option("--direction <direction>", "arrow direction: directed, undirected, or bidirectional", parseLinkDirection)
    .option("--dry-run", "validate without mutating")
    .action(async (linkId: string, options: LinkUpdateOptions) => {
      let body: Record<string, unknown>;
      try {
        body = buildLinkUpdateBody(options);
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
    .description("Remove from Canvas: take the Link off this canvas. The mention and other canvases are untouched.")
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
    .description("Remove from Note: delete the first mentioning sentence from the source Note. The Link leaves every canvas when it was the last mention.")
    .option("--dry-run", "validate without mutating")
    .action(async (linkId: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/links/${encodeURIComponent(linkId)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun), fromNote: true },
        dryRun: Boolean(options.dryRun)
      })
    );
}
