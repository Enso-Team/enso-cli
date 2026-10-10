import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
export const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
export type Installation = { owner: "npm" | "bun" | "project" | "linked"; automatic: boolean; updateCommand: string; installer: "npx" | "bunx" };

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Identify the package manager whose global executable resolves to this CLI. */
export async function inspectInstallation(): Promise<Installation> {
  const current = realpathSync(packageDirectory);
  try {
    const { stdout } = await execute("npm", ["root", "--global"], { timeout: 5000 });
    const candidate = join(stdout.trim(), "@enso-app/cli");
    if (realpathSync(candidate) === current) {
      if (lstatSync(candidate).isSymbolicLink()) return { owner: "linked", automatic: false, updateCommand: `npm --prefix ${shellQuote(current)} run build`, installer: "npx" };
      return { owner: "npm", automatic: true, updateCommand: "npm install -g @enso-app/cli@latest", installer: "npx" };
    }
  } catch { /* A missing npm global package leaves Bun ownership to inspect. */ }
  try {
    const { stdout } = await execute("bun", ["pm", "bin", "-g"], { timeout: 5000 });
    if (realpathSync(join(stdout.trim(), "enso")) === join(current, "dist/index.js")) {
      const automatic = current.endsWith("node_modules/@enso-app/cli") && !lstatSync(packageDirectory).isSymbolicLink();
      return { owner: automatic ? "bun" : "linked", automatic, updateCommand: automatic ? "bun add -g @enso-app/cli@latest" : `bun --cwd ${shellQuote(current)} run build`, installer: "bunx" };
    }
  } catch { /* Project and linked installations receive an explicit local action. */ }
  const project = current.endsWith("node_modules/@enso-app/cli") ? dirname(dirname(dirname(current))) : current;
  const bun = existsSync(join(project, "bun.lock")) || existsSync(join(project, "bun.lockb"));
  return { owner: "project", automatic: false, updateCommand: current.endsWith("node_modules/@enso-app/cli")
    ? bun ? `bun add --cwd ${shellQuote(project)} @enso-app/cli@latest` : `npm install --prefix ${shellQuote(project)} @enso-app/cli@latest`
    : `${bun ? "bun" : "npm"} --${bun ? "cwd" : "prefix"} ${shellQuote(project)} run build`, installer: bun ? "bunx" : "npx" };
}
