import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { cliVersion } from "../version.js";
import { inspectInstallation } from "../installation.js";
import { configDir } from "../config.js";
import { Command } from "commander";
import { z } from "zod";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";
import { discoverSkillAgents, supportedSkillAgents } from "../skill-agents.js";

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

function findSkillPath(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    resolve(packageRoot, "skills", "enso"),
    resolve(packageRoot, "..", "skills", "enso")
  ];
  return candidates.find(candidate => existsSync(join(candidate, "SKILL.md"))) ?? candidates[0];
}

async function installAgent(source: string, installer: string, agent: string, manager: "npm" | "bun"): Promise<AgentInstallation> {
  const args = [...(manager === "npm" ? ["--yes"] : []), skillsInstallerPackage, "add", source, "-g", "-y", "--copy", "--json", "--agent", agent];
  let stdout = "";
  let stderr = "";
  let exitCode: number | string = 0;
  let cause: string | undefined;
  try {
    ({ stdout, stderr } = await execFileAsync(installer, args, { maxBuffer: 1024 * 1024 * 10, timeout: 120000 }));
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
    .option("--installer <manager>", "npm or bun; defaults to the CLI installation owner", parseSkillInstaller)
    .action(installSkill);
}

export type SkillInstallOptions = { agent?: string[]; installer?: "npm" | "bun" };
export function parseSkillInstaller(value: string): "npm" | "bun" {
  if (value === "npm" || value === "bun") return value;
  throw new EnsoCliError("invalid_installer", "Installer must be npm or bun", { value });
}

export function validateSkillTargets(options: SkillInstallOptions): void {
  for (const agent of options.agent ?? []) {
    if (!supportedSkillAgents().includes(agent)) throw new EnsoCliError("invalid_agent", `Unknown coding agent ${agent}`, { agent, supportedAgents: supportedSkillAgents(), hint: "Use a supported id such as codex or claude-code" });
    if (["eve", "promptscript"].includes(agent)) throw new EnsoCliError("project_only_agent", `${agent} requires a project skill destination`, { agent, hint: "Install the skill into that agent's project directory" });
  }
}

export async function installSkill(options: SkillInstallOptions = {}): Promise<EnsoEnvelope> {
  validateSkillTargets(options);
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
  const manager = options.installer ?? ((await inspectInstallation()).installer === "bunx" ? "bun" : "npm");
  const installer = process.env.ENSO_CLI_SKILL_INSTALLER_BIN ?? (manager === "bun" ? "bunx" : process.platform === "win32" ? "npx.cmd" : "npx");
  const results: AgentInstallation[] = [];
  // Each installer writes the shared canonical skill directory, so targets run sequentially.
  for (const agent of targets) results.push(await installAgent(source, installer, agent, manager));
  if (results.some(result => result.status === "failed")) {
    return { ok: false, error: { code: "skill_install_failed", message: "Skill installation is incomplete", details: { source, installer, results, skippedAgents } } };
  }
  const provenance = { cliVersion, source, sha256: createHash("sha256").update(readFileSync(join(source, "SKILL.md"))).digest("hex") };
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir(), "skill-install.json"), JSON.stringify({ provenance, results }), { mode: 0o600 });
  return { ok: true, data: { installed: true, source, installer, results, skippedAgents, provenance } };
}
