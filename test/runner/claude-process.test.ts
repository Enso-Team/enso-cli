import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClaudeProvider, loadClaudeQuery } from "../../src/runner/claude.js";
import { ProviderCleanupError } from "../../src/runner/provider.js";
import { startRunner, type RunnerService } from "../../src/runner/service.js";
import { runnerCall } from "../../src/runner/client.js";
import { RunnerStorage } from "../../src/runner/storage.js";

const executable = fileURLToPath(new URL("./fixtures/claude-process-mock.mjs", import.meta.url));
const query = await loadClaudeQuery();
let directory: string;
let service: RunnerService | undefined;
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory: directory });
const prompt = (sessionID: string, text: string, requestID = "turn") => ({ requestID, sessionID, text, context: { selectedNodes: [] } });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pids = () => JSON.parse(readFileSync(join(directory, "pids.json"), "utf8")) as { server: number; child?: number };
const marked = (name: string) => existsSync(join(directory, name));

beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "enso-cp-"))); });
afterEach(async () => {
  vi.restoreAllMocks();
  writeFileSync(join(directory, "release"), "ready");
  if (marked("pids.json")) {
    try { process.kill(-pids().server, "SIGKILL"); } catch { /* already gone */ }
  }
  await service?.stop(); service = undefined;
  rmSync(directory, { recursive: true, force: true });
});

async function start(graceMs = 100, path = executable) {
  service = await startRunner({ directory: join(directory, "store"), provider: new ClaudeProvider(query,
    { permissionMode: "default", executable: path }, { stopTimeoutMs: 30, exitGraceMs: graceMs }) });
  return service.engine.createSession({ binding: binding() });
}

it("keeps the session busy until the real SDK's child exits after EOF", async () => {
  const session = await start(2000);
  service!.engine.submit(prompt(session.id, "delayed"));
  await expect.poll(() => marked("eof")).toBe(true);
  const { server } = pids();
  expect(alive(server)).toBe(true);
  expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(server)], { encoding: "utf8" }).trim())).toBe(server);
  expect(service!.engine.run("turn").status).toBe("running");
  expect(() => service!.engine.submit(prompt(session.id, "next", "next"))).toThrow("Only one active prompt");
  writeFileSync(join(directory, "release"), "ready");
  await expect.poll(() => service!.engine.run("turn").status).toBe("completed");
  expect(alive(server)).toBe(false);
});

it.each(["stubborn", "orphan-eof", "orphan-term"])("cleans up the whole group before completion (%s)", async mode => {
  const session = await start();
  service!.engine.submit(prompt(session.id, mode));
  await expect.poll(() => service!.engine.run("turn").status, { timeout: 5000 }).toBe("completed");
  const { server, child } = pids();
  expect(alive(server)).toBe(false);
  if (child) expect(alive(child)).toBe(false);
  if (mode === "stubborn") expect(marked("term")).toBe(true);
});

it.each(["cancel", "cancel-unanswered"])("awaits cleanup before cancellation or interruption becomes terminal (%s)", async mode => {
  const session = await start(200);
  service!.engine.submit(prompt(session.id, mode));
  await expect.poll(() => marked("pids.json")).toBe(true);
  service!.engine.cancel("turn");
  await expect.poll(() => marked("eof")).toBe(true);
  expect(service!.engine.run("turn").status).toBe("stopping");
  expect(alive(pids().server)).toBe(true);
  await expect.poll(() => service!.engine.run("turn").status).toBe(mode === "cancel" ? "cancelled" : "interrupted");
  expect(alive(pids().server)).toBe(false);
});

it("retains service ownership during shutdown until the child exits", async () => {
  const session = await start(2000);
  service!.engine.submit(prompt(session.id, "cancel"));
  await expect.poll(() => marked("pids.json")).toBe(true);
  let stopped = false;
  const stop = service!.stop().then(() => { stopped = true; });
  await expect.poll(() => marked("eof")).toBe(true);
  expect(stopped).toBe(false);
  expect(alive(pids().server)).toBe(true);
  expect(() => new RunnerStorage(join(directory, "store")).acquire()).toThrow("A runner already owns");
  writeFileSync(join(directory, "release"), "ready");
  await stop;
  expect(alive(pids().server)).toBe(false);
  const storage = new RunnerStorage(join(directory, "store"));
  storage.acquire(); storage.release();
});

it("keeps stderr diagnostics when using the SDK custom spawner", async () => {
  const session = await start();
  service!.engine.submit(prompt(session.id, "crash"));
  await expect.poll(() => service!.engine.run("turn").status).toBe("interrupted");
  expect(service!.engine.run("turn").error?.details?.stderr).toContain("mock Claude crashed");
  expect(alive(pids().server)).toBe(false);
});

it("reports a spawn failure without hanging cleanup or claiming uncertain execution", async () => {
  const session = await start(100, join(directory, "missing"));
  service!.engine.submit(prompt(session.id, "test"));
  await expect.poll(() => service!.engine.run("turn").status).toBe("failed");
  expect(service!.engine.run("turn").error?.code).toBe("claude_unavailable");
});

it("stops serving work when real process-group cleanup cannot confirm exit", async () => {
  const kill = process.kill.bind(process);
  const calls: NodeJS.Signals[] = [];
  const session = await start();
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (marked("pids.json") && pid === -pids().server && (signal === "SIGTERM" || signal === "SIGKILL")) {
      calls.push(signal);
      return true; // Simulate signals accepted without the process exiting.
    }
    return kill(pid, signal);
  });
  service!.engine.submit(prompt(session.id, "stubborn"));
  await expect.poll(() => {
    try { service!.engine.snapshot(); return undefined; } catch (error) { return (error as ProviderCleanupError).body.code; }
  }).toBe("runner_cleanup_failure");
  expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
  expect(alive(pids().server)).toBe(true);
  expect(() => new RunnerStorage(join(directory, "store")).acquire()).toThrow("A runner already owns");
  spy.mockRestore();
  kill(-pids().server, "SIGKILL");
  await service!.stop();
  await expect(service!.closed).rejects.toMatchObject({ body: { code: "runner_cleanup_failure" } });
  expect(alive(pids().server)).toBe(false);
});

it("fails closed and retains ownership if a provider cannot confirm cleanup", async () => {
  let exit!: () => void;
  const exited = new Promise<void>(resolve => { exit = resolve; });
  try {
    service = await startRunner({ directory: join(directory, "store"), provider: { name: "fake", execute: async () => {
      throw new ProviderCleanupError("Execution is still alive", exited);
    } } });
    const session = service.engine.createSession({ binding: binding() });
    service.engine.submit(prompt(session.id, "test"));
    await expect.poll(() => {
      try { service!.engine.snapshot(); return undefined; } catch (error) { return (error as ProviderCleanupError).body.code; }
    }).toBe("runner_cleanup_failure");
    expect(() => service!.engine.submit(prompt(session.id, "next", "next"))).toThrow("Execution is still alive");
    expect(await runnerCall("GET", "/v1/snapshot", undefined, join(directory, "store"))).toMatchObject({ ok: false, error: { code: "runner_cleanup_failure" } });
    expect(() => new RunnerStorage(join(directory, "store")).acquire()).toThrow("A runner already owns");
    let stopped = false;
    const stop = service.stop().then(() => { stopped = true; });
    await delay(25);
    expect(stopped).toBe(false);
    exit(); await stop;
    await expect(service.closed).rejects.toMatchObject({ body: { code: "runner_cleanup_failure" } });
    // No false terminal outcome was committed; normal restart recovery requires an explicit recovery choice.
    const storage = new RunnerStorage(join(directory, "store"));
    storage.acquire();
    expect(storage.snapshot().runs[0].status).toBe("running");
    storage.release();
    service = await startRunner({ directory: join(directory, "store") });
    expect(service.engine.run("turn")).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" } });
    expect(service.engine.session(session.id).uncertain).toEqual({ requestID: "turn" });
    expect(() => service!.engine.submit(prompt(session.id, "next", "next"))).toThrow("The session's last run ended uncertain");
  } finally { exit(); }
});
