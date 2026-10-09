import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { z } from "zod";
import type { EnsoEnvelope } from "../errors.js";
import { discoverSkillAgents } from "../skill-agents.js";

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
    resolve(process.cwd(), "skills", "enso"),
    resolve(packageRoot, "skills", "enso"),
    resolve(packageRoot, "..", "skills", "enso")
  ];
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
      const installer = process.env.ENSO_CLI_SKILL_INSTALLER_BIN ?? (process.platform === "win32" ? "npx.cmd" : "npx");
      const results: AgentInstallation[] = [];
      // Each installer writes the shared canonical skill directory, so targets run sequentially.
      for (const agent of targets) results.push(await installAgent(source, installer, agent));
      if (results.some(result => result.status === "failed")) {
        return { ok: false, error: { code: "skill_install_failed", message: "Skill installation is incomplete", details: { source, installer, results, skippedAgents } } };
      }
      return { ok: true, data: { installed: true, source, installer, results, skippedAgents } };
    });
}
