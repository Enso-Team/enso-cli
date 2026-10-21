import { Command } from "commander";
import { BridgeClient } from "../client.js";
import { canvasSummary } from "./canvas.js";
import { staleSkillCopies } from "./skill.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show Enso bridge and app status")
    .action(async function () {
      const envelope = await new BridgeClient().request("/v1/status");
      if (!envelope.ok) return envelope;
      const data = { ...envelope.data as Record<string, unknown> };
      if (data.currentCanvas) data.currentCanvas = canvasSummary(data.currentCanvas);
      const stale = staleSkillCopies();
      if (stale.length > 0) data.skill = { stale, hint: "Run `enso skill install` to copy the skill bundled with this CLI" };
      return { ok: true, data };
    });
}
