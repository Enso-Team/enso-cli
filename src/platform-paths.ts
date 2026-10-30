import { homedir } from "node:os";
import { join } from "node:path";

export type PlatformContext = { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv };

export function currentPlatform(): PlatformContext {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/** The per-user application data folder: where Electron keeps `userData` for an app name. */
export function appDataDir({ platform, home, env }: PlatformContext): string {
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME ?? join(home, ".config");
}
