import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { configDir } from "./config.js";
import { EnsoCliError } from "./errors.js";
import { cliVersion } from "./version.js";

const execute = promisify(execFile);
const packageName = "@enso-app/cli";
const registry = "https://registry.npmjs.org";
const dayMs = 24 * 60 * 60 * 1000;
const stableVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const cacheSchema = z.object({ checkedAt: z.number().finite(), latest: stableVersion.optional() });
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

export function isNewerVersion(latest: string, installed: string): boolean {
  if (!stableVersion.safeParse(latest).success || !stableVersion.safeParse(installed).success) return false;
  const target = latest.split(".").map(BigInt);
  const current = installed.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (target[i] !== current[i]) return target[i] > current[i];
  }
  return false;
}

function cachePath(): string {
  return join(configDir(), "update-check.json");
}

function writeCache(latest?: string): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const temporaryPath = `${cachePath()}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ checkedAt: Date.now(), latest }), { mode: 0o600 });
    renameSync(temporaryPath, cachePath());
  } catch {
    // Update checks also work with a read-only configuration directory.
  }
}

export async function latestVersion(): Promise<string> {
  try {
    const response = await fetch(`${registry}/@enso-app%2fcli/latest`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`npm returned HTTP ${response.status}`);
    const { version } = z.object({ version: stableVersion }).parse(await response.json());
    return version;
  } catch {
    throw new EnsoCliError("update_check_failed", "Could not check npm for the latest CLI version", {
      hint: "Check your internet connection and retry `enso update`"
    });
  }
}

export async function notifyUpdate(): Promise<void> {
  if (!process.stdout.isTTY || !process.stderr.isTTY || process.env.CI || process.env.ENSO_CLI_NO_UPDATE_CHECK === "1") return;
  try {
    let cache: z.infer<typeof cacheSchema> | undefined;
    try {
      cache = cacheSchema.parse(JSON.parse(readFileSync(cachePath(), "utf8")));
    } catch {
      // A fresh check creates the cache.
    }
    const age = cache ? Date.now() - cache.checkedAt : Infinity;
    let latest = cache?.latest;
    if (age < 0 || age >= dayMs) {
      try {
        latest = await latestVersion();
        writeCache(latest);
      } catch {
        writeCache();
        return;
      }
    }
    if (latest && isNewerVersion(latest, cliVersion)) {
      process.stderr.write(`Enso CLI ${latest} is available, installed ${cliVersion}. Run \`enso update\`.\n`);
    }
  } catch {
    // Notifications are best effort; the command result owns the exit status.
  }
}

export async function updateCli(checkOnly: boolean): Promise<{ installedVersion: string; latestVersion: string; updateAvailable: boolean; updated: boolean }> {
  const latest = await latestVersion();
  writeCache(latest);
  const updateAvailable = isNewerVersion(latest, cliVersion);
  const result = { installedVersion: cliVersion, latestVersion: latest, updateAvailable, updated: false };
  if (checkOnly || !updateAvailable) return result;

  try {
    const { stdout } = await execute("npm", ["root", "--global"], { timeout: 5000 });
    const globalPackageDirectory = join(stdout.trim(), packageName);
    if (realpathSync(globalPackageDirectory) !== realpathSync(packageDirectory) || lstatSync(globalPackageDirectory).isSymbolicLink()) {
      throw new EnsoCliError("update_install_location", "Use npm to update this installation", {
        hint: "Run `npm install -g @enso-app/cli@latest` with the npm prefix that owns this installation. For a project dependency, run `npm install @enso-app/cli@latest` in that project."
      });
    }
    await execute("npm", ["install", "--global", `${packageName}@${latest}`, "--registry", registry, "--engine-strict"], {
      cwd: dirname(packageDirectory),
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024
    });
    const installed = z.object({ version: stableVersion }).parse(JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")));
    if (installed.version !== latest) throw new Error("The installed version differs from the requested version");
    return { installedVersion: installed.version, latestVersion: latest, updateAvailable: false, updated: true };
  } catch (error) {
    if (error instanceof EnsoCliError) throw error;
    throw new EnsoCliError("update_failed", "npm could not update the CLI installation", {
      hint: "Run `npm install -g @enso-app/cli@latest` using the npm prefix and permissions that own this installation"
    });
  }
}
