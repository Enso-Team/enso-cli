import { Command } from "commander";
import { BridgeClient } from "../client.js";
import { canvasSummary } from "./canvas.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show Enso bridge and app status")
    .action(async function () {
      const envelope = await new BridgeClient().request("/v1/status");
      const data = envelope.ok ? envelope.data as Record<string, unknown> | undefined : undefined;
      if (!data?.currentCanvas) return envelope;
      return { ok: true, data: { ...data, currentCanvas: canvasSummary(data.currentCanvas) } };
    });
}
