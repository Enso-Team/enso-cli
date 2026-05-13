import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const defaultBridgeUrl = process.env.ENSO_BRIDGE_URL ?? "http://127.0.0.1:17650";

const configSchema = z.object({
  bridgeUrl: z.string().url(),
  token: z.string().min(1),
  linkedAt: z.string().optional()
});

export type EnsoConfig = z.infer<typeof configSchema>;

export function configDir(): string {
  if (process.env.ENSO_CLI_CONFIG_DIR) return process.env.ENSO_CLI_CONFIG_DIR;
  return join(homedir(), "Library", "Application Support", "Enso CLI");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): EnsoConfig | null {
  try {
    return configSchema.parse(JSON.parse(readFileSync(configPath(), "utf8")));
  } catch {
    return null;
  }
}

export function writeConfig(config: EnsoConfig): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function removeConfig(): void {
  rmSync(configPath(), { force: true });
}
