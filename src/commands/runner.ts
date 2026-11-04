import type { Command } from "commander";
import { EnsoCliError, printEnvelope } from "../errors.js";
import { runnerCall, shutdownRunner } from "../runner/client.js";
import { runnerVersion } from "../runner/protocol.js";
import { startRunner, type RunnerService } from "../runner/service.js";
import { currentRequestContext } from "../targeting.js";
import { withoutUpdateNotice } from "../update.js";

function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!/^\d+$/.test(value) || timeout <= 0 || timeout > 2 ** 31 - 1) throw new EnsoCliError("invalid_input", "--timeout must be a positive integer of milliseconds");
  return timeout;
}

export function registerRunner(program: Command): void {
  const runner = withoutUpdateNotice(program.command("runner")).description("Durable local prompt runner (fake provider only)");
  runner.command("serve")
    .description("Run an independent foreground service; stop with runner shutdown, SIGINT or SIGTERM (a third signal force-exits)")
    .requiredOption("--provider <name>", "execution provider (fake)")
    .option("--directory <path>", "private runner storage directory")
    .action(async function (this: Command) {
      if (this.opts().provider !== "fake") throw new EnsoCliError("invalid_input", "Only the fake provider is implemented");
      if (currentRequestContext()?.bound || this.optsWithGlobals().canvas) {
        throw new EnsoCliError("target_conflict", "Runner sessions carry their own explicit binding; omit global target options and unset ENSO_VAULT_ID/ENSO_CANVAS_ID when starting the service");
      }
      // Handlers precede startup so an early signal stops the service once it exists instead of killing a half-acquired lock.
      let service: RunnerService | undefined;
      let signals = 0;
      const signal = () => { if (++signals >= 3) process.exit(130); void service?.stop(); };
      process.on("SIGINT", signal);
      process.on("SIGTERM", signal);
      try {
        service = await startRunner({ directory: this.opts().directory });
        if (signals) void service.stop();
        else printEnvelope({ ok: true, data: { ready: true, protocolVersion: runnerVersion, directory: service.directory } }, Boolean(this.optsWithGlobals().pretty));
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
  runner.command("shutdown")
    .description("Cancel active work, release waits, and wait for the local runner to exit")
    .option("--directory <path>", "private runner storage directory")
    .option("--timeout <ms>", "shutdown timeout in milliseconds", parseTimeout)
    .action(async function (this: Command) { return shutdownRunner(this.opts().directory, { timeoutMs: this.opts().timeout }); });
}
