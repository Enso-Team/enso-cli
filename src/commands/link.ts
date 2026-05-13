import { Command, InvalidArgumentError } from "commander";
import { BridgeClient } from "../client.js";

type LinkDirection = "directed" | "undirected" | "bidirectional";

type LinkCreateOptions = {
  label?: string;
  color?: string;
  direction?: LinkDirection;
  dryRun?: boolean;
};

type LinkUpdateOptions = LinkCreateOptions;

function parseLinkDirection(value: string): LinkDirection {
  if (value === "directed" || value === "undirected" || value === "bidirectional") return value;
  throw new InvalidArgumentError("expected directed, undirected, or bidirectional");
}

function linkVisualBody(options: LinkCreateOptions): {
  label?: string;
  color?: string;
  direction?: LinkDirection;
  dryRun: boolean;
} {
  return {
    label: options.label,
    color: options.color,
    direction: options.direction,
    dryRun: Boolean(options.dryRun)
  };
}

export function registerLink(program: Command): void {
  const link = program.command("link").description("Manage Enso links");

  link
    .command("list")
    .option("--canvas <selector|current>")
    .action(async (options: { canvas?: string }) =>
      new BridgeClient().request("/v1/links", { query: { canvas: options.canvas } })
    );
  link
    .command("create")
    .argument("<source-node>")
    .argument("<target-node>")
    .option("--label <label>")
    .option("--color <color>", "relationship line color, such as #3B82F6 or blue")
    .option("--direction <direction>", "arrow direction: directed, undirected, or bidirectional", parseLinkDirection)
    .option("--dry-run", "validate without mutating")
    .action(async (source: string, target: string, options: LinkCreateOptions) =>
      new BridgeClient().request("/v1/links", {
        method: "POST",
        body: { source, target, ...linkVisualBody(options) },
        dryRun: Boolean(options.dryRun)
      })
    );
  link
    .command("update")
    .argument("<link-id>")
    .option("--label <label>")
    .option("--color <color>", "relationship line color, such as #3B82F6 or blue")
    .option("--direction <direction>", "arrow direction: directed, undirected, or bidirectional", parseLinkDirection)
    .option("--dry-run", "validate without mutating")
    .action(async (linkId: string, options: LinkUpdateOptions) =>
      new BridgeClient().request(`/v1/links/${encodeURIComponent(linkId)}`, {
        method: "PUT",
        body: linkVisualBody(options),
        dryRun: Boolean(options.dryRun)
      })
    );
  link
    .command("delete")
    .argument("<link-id>")
    .option("--dry-run", "validate without mutating")
    .action(async (linkId: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/links/${encodeURIComponent(linkId)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
}
