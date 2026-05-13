import { Command } from "commander";
import { BridgeClient } from "../client.js";

export function registerSearch(program: Command): void {
  program
    .command("search")
    .argument("<query>")
    .description("Search notes and canvases")
    .action(async (query: string) => new BridgeClient().request("/v1/search", { query: { q: query } }));
}
