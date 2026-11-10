import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";
import type { AgentTurn } from "./growth-apply.js";

// The Agent turn lives beside the CLI config, one file per Canvas, so each apply continues
// the diagram the previous one grew.

function turnPath(canvasID: string): string {
  return join(configDir(), "turns", `${canvasID.toLowerCase()}.json`);
}

export function readAgentTurn(canvasID: string): AgentTurn | undefined {
  try {
    return JSON.parse(readFileSync(turnPath(canvasID), "utf8")) as AgentTurn;
  } catch {
    return undefined;
  }
}

export function writeAgentTurn(canvasID: string, turn: AgentTurn | undefined): void {
  if (turn === undefined) {
    rmSync(turnPath(canvasID), { force: true });
    return;
  }
  mkdirSync(join(configDir(), "turns"), { recursive: true, mode: 0o700 });
  writeFileSync(turnPath(canvasID), `${JSON.stringify(turn)}\n`, { encoding: "utf8", mode: 0o600 });
}
