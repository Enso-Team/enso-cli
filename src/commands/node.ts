import { Command, InvalidArgumentError } from "commander";
import { BridgeClient } from "../client.js";
import { readContentValue } from "../content.js";

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
    .command("read")
    .argument("<selector>")
    .action(async (selector: string) => new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}`));
  node
    .command("write")
    .argument("<selector>")
    .requiredOption("--content <string|@file>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { content: string; dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}`, {
        method: "PUT",
        body: { content: readContentValue(options.content), dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
  node
    .command("create")
    .requiredOption("--title <title>")
    .option("--content <string|@file>")
    .option("--canvas <selector|current>", "target canvas", "current")
    .option("--x <number>", "world-space center x (omit to auto-place at viewport center)")
    .option("--y <number>", "world-space center y (omit to auto-place at viewport center)")
    .option("--dry-run", "validate without mutating")
    .action(async (options: { title: string; content?: string; canvas?: string; x?: string; y?: string; dryRun?: boolean }) => {
      const x = parseCoord(options.x, "x");
      const y = parseCoord(options.y, "y");
      return new BridgeClient().request("/v1/nodes", {
        method: "POST",
        body: {
          kind: "note",
          title: options.title,
          content: options.content ? readContentValue(options.content) : "",
          canvas: options.canvas ?? "current",
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
          dryRun: Boolean(options.dryRun)
        },
        dryRun: Boolean(options.dryRun)
      });
    });
  node
    .command("add")
    .description("Place an existing Note on the current canvas (references it; writes no new file)")
    .requiredOption("--title <title>", "name of the existing Note to place")
    .option("--canvas <selector|current>", "target canvas", "current")
    .option("--x <number>", "world-space center x (omit to auto-place at viewport center)")
    .option("--y <number>", "world-space center y (omit to auto-place at viewport center)")
    .option("--dry-run", "validate without mutating")
    .action(async (options: { title: string; canvas?: string; x?: string; y?: string; dryRun?: boolean }) => {
      const x = parseCoord(options.x, "x");
      const y = parseCoord(options.y, "y");
      return new BridgeClient().request("/v1/nodes", {
        method: "POST",
        body: {
          kind: "note",
          title: options.title,
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
    .command("move")
    .argument("<selector>")
    .requiredOption("--x <number>")
    .requiredOption("--y <number>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { x: string; y: string; dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/nodes/${encodeURIComponent(selector)}`, {
        method: "PUT",
        body: { x: Number(options.x), y: Number(options.y), dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
  node
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
