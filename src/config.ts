import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  const directory = dirname(configPath());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${configPath()}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, configPath());
  chmodSync(configPath(), 0o600);
}

export function removeConfig(): void {
  rmSync(configPath(), { force: true });
}

export function acquirePairingLock(): () => void {
  const directory = configDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, "pairing.lock");
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("pairing_in_progress");
    }
    throw error;
  }
  writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  closeSync(descriptor);
  chmodSync(path, 0o600);
  return () => rmSync(path, { force: true });
}
