import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { BridgeClient } from "../client.js";
import { assertCompatibleContract } from "../contract.js";
import { discoverAndLink } from "../discovery.js";
import { EnsoCliError, errorEnvelope, type EnsoEnvelope } from "../errors.js";
import { inspectInstallation } from "../installation.js";
import { cliVersion } from "../version.js";
import { installSkill, parseSkillInstaller, validateSkillTargets, type SkillInstallOptions } from "./skill.js";

const execute = promisify(execFile);

async function appStatus(): Promise<EnsoEnvelope> {
  try { return await new BridgeClient().request("/v1/status"); }
  catch (error) {
    if (!(error instanceof EnsoCliError) || !["app_unavailable", "auth_required", "link_failed"].includes(error.body.code)) throw error;
    if (process.platform !== "darwin") throw new EnsoCliError("app_launch_required", "Launch the Enso Mac app to complete setup", { stage: "app", hint: "Run setup on the Mac that has Enso installed" });
    try { await execute("open", ["-a", "Enso"], { timeout: 10000 }); }
    catch { throw new EnsoCliError("app_missing", "The installed Enso app could not launch", { stage: "app", hint: "Install or launch Enso, then run enso setup" }); }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await discoverAndLink()) return new BridgeClient().request("/v1/status");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new EnsoCliError("app_unavailable", "Enso's bridge is unavailable after launch", { stage: "app", hint: "Open Enso and check Local agent access in Settings, then run enso setup" });
  }
}

export function registerSetup(program: Command): void {
  program.command("setup").description("Install the Enso skill and verify the local app connection")
    .option("--agent <agents...>", "specific skill targets; defaults to all detected supported global agents")
    .option("--installer <manager>", "npm or bun; defaults to installation ownership", parseSkillInstaller)
    .action(async (options: SkillInstallOptions): Promise<EnsoEnvelope> => {
      let stage = "targets";
      try {
        validateSkillTargets(options);
        stage = "app";
        const status = await appStatus();
        if (!status.ok) return { ...status, error: { ...status.error, details: { ...status.error.details, stage } } };
        const health = await new BridgeClient().request("/v1/health", { auth: false });
        if (!health.ok) return health;
        const healthData = health.data as Record<string, unknown>;
        assertCompatibleContract(healthData.contractVersion, String(healthData.bridgeUrl ?? "local Enso bridge"));
        stage = "skill";
        const skill = await installSkill(options);
        if (!skill.ok) return { ...skill, error: { ...skill.error, details: { ...skill.error.details, stage, pairing: "linked" } } };
        const app = status.data as Record<string, unknown>;
        return { ok: true, data: { ready: true, cliVersion, installation: await inspectInstallation(), pairing: "linked",
          app, appVersion: typeof app.appVersion === "string" ? app.appVersion : "unknown",
          buildVersion: typeof app.buildVersion === "string" ? app.buildVersion : "unknown", contractVersion: healthData.contractVersion, skill: skill.data,
          capabilities: Array.isArray(app.capabilities) && app.capabilities.every(value => typeof value === "string")
            ? { status: "reported", values: app.capabilities } : { status: "unknown", values: [] } } };
      } catch (error) {
        const envelope = errorEnvelope(error);
        return envelope.ok ? envelope : { ...envelope, error: { ...envelope.error, details: { ...envelope.error.details, stage } } };
      }
    });
}
