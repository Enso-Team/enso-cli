import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { connectCodex, spawnCodex } from "../../src/runner/codex-app-server.js";
import type { CodexChild, CodexConnection } from "../../src/runner/codex-connection.js";
import { CodexProvider } from "../../src/runner/codex.js";
import { ProviderCleanupError } from "../../src/runner/provider.js";
import { startRunner, type RunnerService } from "../../src/runner/service.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import { durable } from "./replica.js";

const mock = fileURLToPath(new URL("./fixtures/codex-app-server-mock.mjs", import.meta.url));
const binding = (workingDirectory: string) => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory });

it.each(["completed", "cancelled", "unanswered"] as const)("retains ownership when Codex cleanup cannot confirm exit (%s)", async outcome => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "enso-cp-")));
  const store = join(directory, "store");
  const fixture = outcome === "cancelled" ? "turn_interrupt" : "simple";
  let transcript = readFileSync(new URL(`./fixtures/agent-host/codex/${fixture}.ndjson`, import.meta.url), "utf8");
  if (outcome === "unanswered") {
    // Stall initialize: cancellation's deadline closes the connection while drive() still awaits an RPC.
    const entries = transcript.trim().split("\n").map(line => JSON.parse(line));
    transcript = entries.slice(0, entries.findIndex(entry => entry.type === "emit_inbound")).map(entry => JSON.stringify(entry)).join("\n");
  }
  const path = join(directory, "transcript.ndjson");
  writeFileSync(path, transcript);
  let child: CodexChild | undefined;
  let connection: CodexConnection | undefined;
  let service: RunnerService | undefined;
  const signals: NodeJS.Signals[] = [];
  try {
    service = await startRunner({ directory: store, provider: new CodexProvider(options => connectCodex({
      ...options,
      env: { ...options.env, ENSO_MOCK_MODE: "stubborn-transcript", ENSO_MOCK_TRANSCRIPT: path },
      spawn: (_command, _args, spawnOptions) => {
        child = spawnCodex(process.execPath, [mock], spawnOptions);
        return { ...child, kill: signal => {
          signals.push(signal);
          // Exercise both signals accepted without exit and signals that fail outright.
          if (outcome === "cancelled") throw new Error("Signal failed");
        } };
      }
    }).then(connected => { connection = connected; return connected; }), {
      executable: "codex", approvalPolicy: "on-request", sandbox: "workspace-write"
    }, { exitGraceMs: 50, stopTimeoutMs: 30 }) });
    const session = service.engine.createSession({ binding: binding(directory) });
    const prompt = { requestID: "turn", sessionID: session.id, text: "test", context: { selectedNodes: [] } };
    service.engine.submit(prompt);
    if (outcome !== "completed") {
      await expect.poll(() => outcome === "unanswered" ? connection !== undefined :
        Boolean((service!.engine.run("turn").native as { turnID?: string } | undefined)?.turnID)).toBe(true);
      service.engine.cancel("turn");
    }
    await expect.poll(() => {
      try { service!.engine.snapshot(); return undefined; }
      catch (error) { return (error as ProviderCleanupError).body.code; }
    }).toBe("runner_cleanup_failure");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child!.isAlive()).toBe(true);
    expect(() => service!.engine.submit({ ...prompt, requestID: "next" })).toThrow("runner stopped accepting work");
    expect(() => new RunnerStorage(store).acquire()).toThrow("A runner already owns");
    const failure = await connection!.close().catch(error => error);
    expect(failure).toBeInstanceOf(ProviderCleanupError);
    expect(connection!.close()).toBe(connection!.close());
    let exited = false;
    void (failure as ProviderCleanupError).exited.then(() => { exited = true; });
    let stopped = false;
    const stop = service.stop().then(() => { stopped = true; });
    await delay(25);
    expect(exited).toBe(false);
    expect(stopped).toBe(false);
    const before = durable(store);
    expect(before.runs[0].status).toBe(outcome === "completed" ? "running" : "stopping");
    expect(before.runs[0].result).toBeUndefined();
    expect(before.sessions[0].providerState).toBeUndefined();
    child!.kill("SIGKILL");
    await (failure as ProviderCleanupError).exited;
    await stop;
    await expect(service.closed).rejects.toMatchObject({ body: { code: "runner_cleanup_failure" } });
    expect(child!.isAlive()).toBe(false);
    expect(durable(store)).toEqual(before);
    service = await startRunner({ directory: store });
    expect(service.engine.run("turn")).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" } });
    expect(service.engine.session(session.id).uncertain?.requestID).toBe("turn");
  } finally {
    try { child?.kill("SIGKILL"); } catch { /* already gone */ }
    await service?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
