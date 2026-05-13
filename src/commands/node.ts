import { Command } from "commander";
import { BridgeClient } from "../client.js";
import { readContentValue } from "../content.js";

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
    .option("--dry-run", "validate without mutating")
    .action(async (options: { title: string; content?: string; canvas?: string; dryRun?: boolean }) =>
      new BridgeClient().request("/v1/nodes", {
        method: "POST",
        body: {
          kind: "note",
          title: options.title,
          content: options.content ? readContentValue(options.content) : "",
          canvas: options.canvas ?? "current",
          dryRun: Boolean(options.dryRun)
        },
        dryRun: Boolean(options.dryRun)
      })
    );
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
