import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { EnsoCliError, printEnvelope, printsOwnOutput } from "../errors.js";
import { ClaudeProvider, claudePermissionModes, loadClaudeQuery } from "../runner/claude.js";
import { runnerCall, shutdownRunner } from "../runner/client.js";
import { runnerVersion } from "../runner/protocol.js";
import { FakeProvider, type RunnerProvider } from "../runner/provider.js";
import { maxRetainDays, startRunner, type RunnerService } from "../runner/service.js";
import { RunnerStorage } from "../runner/storage.js";
import { currentRequestContext, withoutRequestContext } from "../targeting.js";
import { withoutUpdateNotice } from "../update.js";

function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!/^\d+$/.test(value) || timeout <= 0 || timeout > 2 ** 31 - 1) throw new EnsoCliError("invalid_input", "--timeout must be a positive integer of milliseconds");
  return timeout;
}
function parseProvider(value: string): "fake" | "claude" {
  if (value !== "fake" && value !== "claude") throw new EnsoCliError("invalid_input", "--provider must be fake or claude");
  return value;
}
function parsePermissionMode(value: string): (typeof claudePermissionModes)[number] {
  const mode = claudePermissionModes.find(candidate => candidate === value);
  if (!mode) throw new EnsoCliError("invalid_input", `--claude-permission-mode must be one of ${claudePermissionModes.join(", ")}`);
  return mode;
}
function parseDays(value: string): number {
  const days = Number(value);
  if (!/^\d+$/.test(value) || days <= 0 || days > maxRetainDays) throw new EnsoCliError("invalid_input", `--retain-days must be a whole number of days from 1 to ${maxRetainDays}`);
  return days;
}
/** The SDK spawns Claude in each session's working directory, so a relative path must be fixed against this one. */
function parseExecutable(value: string): string {
  const path = resolve(value);
  try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; }
  catch { /* missing or not executable; refused below */ }
  throw new EnsoCliError("invalid_input", "--claude-executable must be an executable file");
}

export function registerRunner(program: Command): void {
  const runner = withoutUpdateNotice(program.command("runner")).description("Durable local prompt runner (fake or Claude provider)");
  printsOwnOutput(runner.command("serve"))
    .description("Run an independent foreground service; stop with runner shutdown, SIGINT or SIGTERM (a third signal force-exits)")
    .requiredOption("--provider <name>", "execution provider: fake (deterministic test provider) or claude (Claude Agent SDK)", parseProvider)
    .option("--claude-model <model>", "Claude model for new and resumed turns (default: Claude Code's default)")
    .option("--claude-permission-mode <mode>", `Claude permission mode: ${claudePermissionModes.join(", ")} (default: default, which asks through the runner)`, parsePermissionMode)
    .option("--claude-executable <path>", "Claude Code executable to run instead of the SDK's bundled one", parseExecutable)
    .option("--directory <path>", "private runner storage directory")
    .option("--retain-days <days>", "delete finished runs and their events this many days after their last update (default: keep everything)", parseDays)
    .action(async function (this: Command) {
      const options = this.opts();
      const claudeOptions = ["claudeModel", "claudePermissionMode", "claudeExecutable"].filter(key => options[key] !== undefined);
      if (options.provider !== "claude" && claudeOptions.length) throw new EnsoCliError("invalid_input", "--claude-* options require --provider claude");
      if (currentRequestContext()?.bound || this.optsWithGlobals().canvas) {
        throw new EnsoCliError("target_conflict", "Runner sessions carry their own explicit binding; omit global target options and unset ENSO_VAULT_ID/ENSO_CANVAS_ID when starting the service");
      }
      // Handlers precede startup so an early signal stops the service once it exists instead of killing a half-acquired lock.
      let service: RunnerService | undefined;
      let signals = 0;
      // Until startRunner returns there is no service to stop; the abort keeps it from dispatching accepted runs.
      const stopping = new AbortController();
      const signal = (name: NodeJS.Signals) => {
        if (++signals >= 3) process.exit(name === "SIGTERM" ? 143 : 130);
        stopping.abort();
        void service?.stop();
      };
      process.on("SIGINT", signal);
      process.on("SIGTERM", signal);
      try {
        // Sessions carry their own binding; requests and runs must not inherit this invocation's context.
        const { directory, retainDays } = options;
        // The SDK loads before any runner file is touched, so a missing optional package refuses startup cleanly.
        const provider: RunnerProvider = options.provider === "claude"
          ? new ClaudeProvider(await loadClaudeQuery(), {
            permissionMode: options.claudePermissionMode ?? "default",
            ...(options.claudeModel ? { model: options.claudeModel } : {}),
            ...(options.claudeExecutable ? { executable: options.claudeExecutable } : {})
          })
          : new FakeProvider();
        service = await withoutRequestContext(() => startRunner({ directory, retainDays, provider, signal: stopping.signal }));
        if (signals) void service.stop();
        else printEnvelope({ ok: true, data: { ready: true, protocolVersion: runnerVersion, provider: provider.name, directory: service.directory } }, Boolean(this.optsWithGlobals().pretty));
        await service.closed;
      } finally { process.removeListener("SIGINT", signal); process.removeListener("SIGTERM", signal); }
    });
  runner.command("call <method> <path>")
    .description("Call the runner protocol using private connection discovery")
    .option("--json <json>", "JSON request body")
    .option("--directory <path>", "private runner storage directory")
    .option("--timeout <ms>", "request timeout in milliseconds", parseTimeout)
    .action(async function (this: Command, method: string, path: string) {
      if (!["GET", "POST"].includes(method)) throw new EnsoCliError("invalid_input", "Runner methods are GET and POST");
      let body: unknown;
      if (this.opts().json !== undefined) {
        try { body = JSON.parse(this.opts().json); }
        catch { throw new EnsoCliError("invalid_input", "--json must contain valid JSON"); }
      }
      return runnerCall(method, path, body, this.opts().directory, { timeoutMs: this.opts().timeout });
    });
  runner.command("check")
    .description("Rebuild every session and run from the event history and compare them with the stored rows (read-only; safe beside a live runner)")
    .option("--directory <path>", "private runner storage directory")
    .action(async function (this: Command) {
      const { differences, ...summary } = RunnerStorage.check(this.opts().directory);
      if (differences.length) {
        throw new EnsoCliError("invalid_runner_storage", `Runner rows disagree with the event history in ${differences.length} place(s)`, { ...summary, differences: differences.slice(0, 50) });
      }
      return { ok: true, data: summary };
    });
  runner.command("shutdown")
    .description("Cancel active work, release waits, and wait for the local runner to exit")
    .option("--directory <path>", "private runner storage directory")
    .option("--timeout <ms>", "shutdown timeout in milliseconds", parseTimeout)
    .action(async function (this: Command) { return shutdownRunner(this.opts().directory, { timeoutMs: this.opts().timeout }); });
}
