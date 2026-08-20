import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lockSync } from "proper-lockfile";
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

// The lock directory is refreshed by a heartbeat while pairing runs, so a lock whose mtime falls
// this far behind belongs to a process that is gone rather than one that is merely slow. The
// heartbeat runs at half this interval, which tests shorten to observe a full cycle.
function pairingLockStaleMs(): number {
  const override = Number.parseInt(process.env.ENSO_CLI_PAIRING_LOCK_STALE_MS ?? "", 10);
  return Number.isInteger(override) && override > 0 ? override : 60_000;
}

// proper-lockfile guards an existing target path with a sibling `<target>.lock` directory, so
// pairing locks against a sentinel file of its own instead of the credentials it protects.
function pairingLockTarget(): string {
  return join(configDir(), "pairing");
}

export function acquirePairingLock(onCompromised: (error: Error) => void): () => void {
  const directory = configDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = pairingLockTarget();
  writeFileSync(target, "", { encoding: "utf8", flag: "a", mode: 0o600 });
  chmodSync(target, 0o600);
  let release: () => void;
  try {
    release = lockSync(target, { stale: pairingLockStaleMs(), onCompromised });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("pairing_in_progress");
    throw error;
  }
  return () => {
    try {
      release();
    } catch {
      // A compromised or already released lock has nothing left to unlock.
    }
  };
}
