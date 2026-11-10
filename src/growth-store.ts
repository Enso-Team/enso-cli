import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";
import type { Growth } from "./growth-apply.js";

// The growth lives beside the CLI config, one file per Canvas, so each apply continues the
// diagram the previous one grew.

function growthPath(canvasID: string): string {
  return join(configDir(), "growth", `${canvasID.toLowerCase()}.json`);
}

export function readGrowth(canvasID: string): Growth | undefined {
  try {
    return JSON.parse(readFileSync(growthPath(canvasID), "utf8")) as Growth;
  } catch {
    return undefined;
  }
}

export function writeGrowth(canvasID: string, growth: Growth | undefined): void {
  if (growth === undefined) {
    rmSync(growthPath(canvasID), { force: true });
    return;
  }
  mkdirSync(join(configDir(), "growth"), { recursive: true, mode: 0o700 });
  writeFileSync(growthPath(canvasID), `${JSON.stringify(growth)}\n`, { encoding: "utf8", mode: 0o600 });
}
