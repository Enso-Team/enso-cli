import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { z } from "zod";
import type { EnsoEnvelope } from "../errors.js";
import { agentIdsForDisplayNames, discoverSkillAgents } from "../skill-agents.js";

const execFileAsync = promisify(execFile);
const skillsInstallerPackage = "skills@1.7.1";
const installerResultsSchema = z.array(z.object({
  name: z.string().optional(),
  status: z.enum(["installed", "failed", "skipped"]),
  path: z.string().optional(),
  error: z.string().optional()
})).nonempty();

type AgentInstallation = {
  agent: string;
  status: "installed" | "failed";
  path?: string;
  error?: string;
  exitCode?: number | string;
  stdout?: string;
  stderr?: string;
};

function installerResults(stdout: string): z.infer<typeof installerResultsSchema> | undefined {
  try {
    const parsed = installerResultsSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The skill `enso skill install` copies: a working checkout's skill first, for local development. */
function findSkillPath(): string {
  const local = resolve(process.cwd(), "skills", "enso");
  return existsSync(join(local, "SKILL.md")) ? local : packagedSkillPath();
}

/** The skill shipped with this CLI release, wherever the command runs from. */
function packagedSkillPath(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [resolve(packageRoot, "skills", "enso"), resolve(packageRoot, "..", "skills", "enso")];
  return candidates.find(candidate => existsSync(join(candidate, "SKILL.md"))) ?? candidates[0];
}

async function installAgent(source: string, installer: string, agent: string): Promise<AgentInstallation> {
  const args = ["--yes", skillsInstallerPackage, "add", source, "-g", "-y", "--copy", "--json", "--agent", agent];
  let stdout = "";
  let stderr = "";
  let exitCode: number | string = 0;
  let cause: string | undefined;
  try {
    ({ stdout, stderr } = await execFileAsync(installer, args, { maxBuffer: 1024 * 1024 * 10 }));
  } catch (error) {
    const failure = error as { message?: string; stdout?: string; stderr?: string; code?: number | string };
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
    exitCode = failure.code ?? 1;
    cause = failure.message;
  }
  const results = installerResults(stdout);
  if (exitCode === 0 && results?.every(result => result.status === "installed")) {
    return { agent, status: "installed", path: results[0].path };
  }
  return {
    agent,
    status: "failed",
    exitCode,
    error: results?.find(result => result.status !== "installed")?.error ?? cause?.slice(0, 2000) ?? "Installer response requires confirmation",
    ...(!results ? { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) } : {})
  };
}

export function registerSkill(program: Command): void {
  const skill = program.command("skill").description("Install the bundled Enso skill");
  skill.command("install")
    .option("--agent <agents...>", "select specific agents; defaults to all detected agents with global skill support")
    .action(async (options: { agent?: string[] }): Promise<EnsoEnvelope> => {
      const source = findSkillPath();
      if (!existsSync(join(source, "SKILL.md"))) {
        return { ok: false, error: { code: "skill_not_found", message: "Bundled Enso skill is unavailable", details: { skillPath: source } } };
      }
      const discovered = options.agent ? { agents: options.agent, skippedAgents: [] } : discoverSkillAgents();
      const targets = [...new Set(discovered.agents)];
      const skippedAgents = discovered.skippedAgents.map(agent => ({ agent, reason: "project_only" }));
      if (targets.length === 0) {
        return { ok: false, error: { code: "agents_not_found", message: "Install an agent with global skill support or select one with --agent", details: { skippedAgents } } };
      }
      const results = await installTo(source, targets);
      if (results.some(result => result.status === "failed")) {
        return { ok: false, error: { code: "skill_install_failed", message: "Skill installation is incomplete", details: { source, installer: installerBin(), results, skippedAgents } } };
      }
      return { ok: true, data: { installed: true, source, installer: installerBin(), results, skippedAgents } };
    });
}

function installerBin(): string {
  return process.env.ENSO_CLI_SKILL_INSTALLER_BIN ?? (process.platform === "win32" ? "npx.cmd" : "npx");
}

async function installTo(source: string, agents: string[]): Promise<AgentInstallation[]> {
  const results: AgentInstallation[] = [];
  // Each installer writes the shared canonical skill directory, so targets run sequentially.
  for (const agent of agents) results.push(await installAgent(source, installerBin(), agent));
  return results;
}

/**
 * Copy the bundled skill to the agents that already have `enso`. The installer cannot update
 * a skill installed from a local path, so this reads its list and installs to the same agents.
 */
export async function refreshInstalledSkill(): Promise<SkillRefresh> {
  const { stdout } = await execFileAsync(installerBin(), ["--yes", skillsInstallerPackage, "list", "-g", "--json"], { maxBuffer: 1024 * 1024 * 10 });
  const installed = z.array(z.object({ name: z.string(), agents: z.array(z.string()) })).parse(JSON.parse(stdout)).find(skill => skill.name === "enso");
  if (!installed) return { refreshed: false, reason: "not_installed" };
  const { agents, unknownAgents } = agentIdsForDisplayNames(installed.agents);
  const results = await installTo(packagedSkillPath(), agents);
  const failed = results.filter(result => result.status === "failed").map(result => result.agent);
  if (failed.length === 0) return { refreshed: true, results, unknownAgents };
  return { refreshed: false, results, unknownAgents, hint: `Run \`enso skill install --agent ${failed.join(" ")}\` to copy the new skill` };
}

export type SkillRefresh =
  | { refreshed: false; reason: "not_installed" }
  | { refreshed: boolean; results: AgentInstallation[]; unknownAgents: string[]; hint?: string };

/**
 * Installed copies of the skill that differ from the one bundled with this CLI. Checks the
 * installer's shared folder and Claude's skills folder, where copies outlive CLI upgrades.
 */
export function staleSkillCopies(options: { homeDirectory?: string; environment?: NodeJS.ProcessEnv } = {}): string[] {
  const home = options.homeDirectory ?? homedir();
  const claudeHome = (options.environment ?? process.env).CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const bundled = skillFiles(packagedSkillPath());
  if (!bundled) return [];
  return [join(home, ".agents", "skills", "enso"), join(claudeHome, "skills", "enso")]
    .filter(copy => existsSync(join(copy, "SKILL.md")))
    .filter(copy => {
      const files = skillFiles(copy);
      return !files || files.size !== bundled.size || [...bundled].some(([file, text]) => files.get(file) !== text);
    });
}

/** The skill's markdown by relative path, or undefined when a file cannot be read. */
function skillFiles(root: string): Map<string, string> | undefined {
  const files = new Map<string, string>();
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  try {
    walk(root);
    return files;
  } catch {
    return undefined;
  }
}
