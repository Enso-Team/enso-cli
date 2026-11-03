import type { Command } from "commander";
import { EnsoCliError, printEnvelope } from "../errors.js";
import { runnerCall } from "../runner/client.js";
import { runnerVersion } from "../runner/protocol.js";
import { startRunner } from "../runner/service.js";
import { currentRequestContext } from "../targeting.js";

export function registerRunner(program: Command): void {
  const runner = program.command("runner").description("Durable local prompt runner (fake provider only)");
  runner.command("serve")
    .description("Run an independent foreground service; stop with runner shutdown or SIGTERM")
    .requiredOption("--provider <name>", "execution provider (fake)")
    .option("--directory <path>", "private runner storage directory")
    .action(async function (this: Command) {
      if (this.opts().provider !== "fake") throw new EnsoCliError("invalid_input", "Only the fake provider is implemented");
      if (currentRequestContext()?.bound || this.optsWithGlobals().canvas) {
        throw new EnsoCliError("target_conflict", "Runner sessions carry their own explicit binding; omit global target options and unset ENSO_VAULT_ID/ENSO_CANVAS_ID when starting the service");
      }
      const service = await startRunner({ directory: this.opts().directory });
      const signal = () => { void service.stop(); };
      process.once("SIGINT", signal);
      process.once("SIGTERM", signal);
      printEnvelope({ ok: true, data: { ready: true, protocolVersion: runnerVersion, directory: service.directory } }, Boolean(this.optsWithGlobals().pretty));
      try { await service.closed; }
      finally { process.removeListener("SIGINT", signal); process.removeListener("SIGTERM", signal); }
      return { ok: true, data: { stopped: true } };
    });
  runner.command("call <method> <path>")
    .description("Call the runner protocol using private connection discovery")
    .option("--json <json>", "JSON request body")
    .option("--directory <path>", "private runner storage directory")
    .action(async function (this: Command, method: string, path: string) {
      if (!["GET", "POST"].includes(method)) throw new EnsoCliError("invalid_input", "Runner methods are GET and POST");
      let body: unknown;
      if (this.opts().json !== undefined) {
        try { body = JSON.parse(this.opts().json); }
        catch { throw new EnsoCliError("invalid_input", "--json must contain valid JSON"); }
      }
      return runnerCall(method, path, body, this.opts().directory);
    });
  runner.command("shutdown")
    .description("Cancel active work, release waits, and stop the local runner")
    .option("--directory <path>", "private runner storage directory")
    .action(async function (this: Command) { return runnerCall("POST", "/v1/shutdown", undefined, this.opts().directory); });
}
