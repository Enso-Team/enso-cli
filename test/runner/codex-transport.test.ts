import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { connectCodex } from "../../src/runner/codex-app-server.js";
import { CodexRequestError, type CodexConnection, type CodexDiagnostic } from "../../src/runner/codex-connection.js";

const mock = fileURLToPath(new URL("./fixtures/codex-app-server-mock.mjs", import.meta.url));
const simple = fileURLToPath(new URL("./fixtures/agent-host/codex/simple.ndjson", import.meta.url));
let directory: string;
let connection: CodexConnection | undefined;
const diagnostics: CodexDiagnostic[] = [];

/** A `codex` executable that runs the mock app-server under this Node. */
function executable(): string {
  const path = join(directory, "codex");
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`, { mode: 0o755 });
  return path;
}
async function connect(env: Record<string, string>, exitGraceMs = 2000): Promise<CodexConnection> {
  connection = await connectCodex({
    command: executable(), args: ["app-server"], cwd: directory, env: { ...process.env, ...env },
    onDiagnostic: diagnostic => { diagnostics.push(diagnostic); }, exitGraceMs
  });
  return connection;
}
const initialize = (codex: CodexConnection) => codex.request("initialize", { clientInfo: { name: "enso-cli", title: "Enso CLI", version: "0.0.0" } });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number): Promise<boolean> {
  // An orphan killed with its parent is reaped by launchd a moment later.
  for (let attempt = 0; attempt < 40 && alive(pid); attempt++) await delay(50);
  return !alive(pid);
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "enso-codex-transport-")));
  diagnostics.length = 0;
});
afterEach(async () => {
  await connection?.close();
  connection = undefined;
  rmSync(directory, { recursive: true, force: true });
});

it("speaks JSON-RPC with a real app-server process in its own process group, and ends it by closing stdin", async () => {
  const codex = await connect({ ENSO_MOCK_TRANSCRIPT: simple });
  expect(await initialize(codex)).toMatchObject({ platformOs: "linux", userAgent: expect.stringContaining("0.156.1") });
  await codex.notify("initialized");
  const pid = codex.pid!;
  // The process group's leader: a terminal's Ctrl-C to the runner does not reach it.
  expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim())).toBe(pid);
  await codex.close();
  expect(alive(pid)).toBe(false);
  expect(await codex.terminated).toEqual({ code: "closed", message: "The runner closed the connection" });
  await expect(initialize(codex)).rejects.toMatchObject({ kind: "transport" });
  expect(diagnostics).toEqual([]);
});

it("signals the whole process group, escalating to SIGKILL, when the app-server outlives stdin and SIGTERM", async () => {
  const pids = join(directory, "pids.json");
  const codex = await connect({ ENSO_MOCK_MODE: "stubborn", ENSO_MOCK_PIDS: pids }, 200);
  await initialize(codex);
  while (!existsSync(pids)) await delay(10);
  const { server, child } = JSON.parse(readFileSync(pids, "utf8")) as { server: number; child: number };
  expect([alive(server), alive(child)]).toEqual([true, true]);
  const started = Date.now();
  await codex.close();
  // stdin's end and SIGTERM were each given their grace period, then SIGKILL ended it.
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  expect(await gone(server)).toBe(true);
  expect(await gone(child)).toBe(true);
  expect(diagnostics).toEqual([]);
});

it("reports the exit status and error output of an app-server that dies, failing the request in flight", async () => {
  const codex = await connect({ ENSO_MOCK_MODE: "crash" });
  const failure = await initialize(codex).catch(error => error as CodexRequestError);
  expect(failure).toBeInstanceOf(CodexRequestError);
  expect(failure).toMatchObject({ kind: "transport", method: "initialize" });
  expect(await codex.terminated).toMatchObject({ code: "codex_exited", exitCode: 3, signal: null, stderr: "fatal: the mock crashed" });
});

it("ends the connection on output that is not a JSON-RPC line", async () => {
  const codex = await connect({ ENSO_MOCK_MODE: "garbage" });
  await expect(initialize(codex)).rejects.toMatchObject({ kind: "transport" });
  expect(await codex.terminated).toMatchObject({ code: "codex_malformed_message" });
});

it("rejects, with nothing left running, when the executable cannot start", async () => {
  await expect(connectCodex({ command: join(directory, "missing"), args: ["app-server"], cwd: directory, env: process.env })).rejects.toMatchObject({ code: "ENOENT" });
});
