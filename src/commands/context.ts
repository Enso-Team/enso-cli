import { Command } from "commander";
import { BridgeClient } from "../client.js";

export function registerContext(program: Command): void {
  program
    .command("context")
    .option("--canvas <selector|current>")
    .option("--node <selector>")
    .option("--depth <n>", "node context depth", "1")
    .option("--query <query>")
    .option("--vision", "include visual viewport context")
    .description("Export agent context from Enso")
    .action(async (options: { canvas?: string; node?: string; depth: string; query?: string; vision?: boolean }) =>
      new BridgeClient().request("/v1/context", {
        method: "POST",
        body: {
          canvas: options.canvas,
          node: options.node,
          depth: Number(options.depth),
          query: options.query,
          vision: options.vision
            ? {
                enabled: true,
                scope: "viewport",
                transport: "file"
              }
            : undefined
        }
      })
    );
}
