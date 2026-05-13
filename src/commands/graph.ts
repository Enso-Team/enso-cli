import { Command } from "commander";
import { BridgeClient } from "../client.js";

export function registerGraph(program: Command): void {
  const graph = program.command("graph").description("Inspect Enso graph structure");

  graph
    .command("inspect")
    .option("--canvas <selector|current>")
    .action(async (options: { canvas?: string }) =>
      new BridgeClient().request("/v1/context", { method: "POST", body: { canvas: options.canvas ?? "current" } })
    );
  graph
    .command("broken")
    .action(async () => new BridgeClient().request("/v1/context", { method: "POST", body: { broken: true } }));
  graph
    .command("path")
    .argument("<source-node>")
    .argument("<target-node>")
    .action(async (source: string, target: string) =>
      new BridgeClient().request("/v1/context", { method: "POST", body: { path: { source, target } } })
    );
}
