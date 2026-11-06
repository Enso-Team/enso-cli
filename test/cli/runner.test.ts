import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { durable } from "../runner/replica.js";

let child: ChildProcess | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
  child = undefined; directory = undefined;
  vi.doUnmock("../../src/runner/service.js"); vi.restoreAllMocks(); vi.resetModules();
});
function start(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, ENSO_CLI_NO_UPDATE_CHECK: "1" };
  delete env.ENSO_VAULT_ID; delete env.ENSO_CANVAS_ID;
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
}
async function serve() {
  const path = directory = mkdtempSync(join(tmpdir(), "enso-cli-runner-"));
  const service = child = start(["runner", "serve", "--provider", "fake", "--directory", path]);
  const output = { stdout: "", stderr: "", directory: path, exited: once(service, "close") };
  service.stdout!.on("data", chunk => { output.stdout += chunk; });
  service.stderr!.on("data", chunk => { output.stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    service.stdout!.once("data", () => resolve());
    service.once("exit", () => reject(new Error(output.stderr)));
  });
  return output;
}
function leftovers(path: string) { return ["acquiring", "owner", "connection.json", "control.sock", "runner.sqlite-wal", "runner.sqlite-shm"].filter(name => existsSync(join(path, name))); }
async function command(args: string[]) {
  const process = start(args);
  let stdout = "", stderr = "";
  process.stdout!.on("data", chunk => { stdout += chunk; });
  process.stderr!.on("data", chunk => { stderr += chunk; });
  const [code] = await once(process, "exit");
  return { code, stdout, stderr };
}
it("runs the standalone CLI service without an app and gracefully shuts down", async () => {
  const output = await serve();
  const { directory } = output;
  expect(JSON.parse(output.stdout).data).toMatchObject({ ready: true, protocolVersion: 1 });
  const created = await command(["runner", "call", "POST", "/v1/sessions", "--directory", directory, "--json", JSON.stringify({ binding: {
    bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
      vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
    }, workingDirectory: directory
  } })]);
  expect(created.code).toBe(0);
  const s = JSON.parse(created.stdout).data;
  expect(s.binding.workingDirectory).toBe(realpathSync(directory));
  const submitted = await command(["runner", "call", "POST", "/v1/prompts", "--directory", directory, "--json", JSON.stringify({
    requestID: "cli-turn", sessionID: s.id, text: "CLI test", context: { selectedNodes: [] }, fake: { scenario: "input", delayMs: 0 }
  })]);
  expect(submitted.code).toBe(0);
  const result = await command(["runner", "call", "GET", "/v1/runs/cli-turn", "--directory", directory]);
  expect(JSON.parse(result.stdout).data.status).toBe("waiting_input");
  const stopped = await command(["runner", "shutdown", "--directory", directory]);
  expect(stopped.code).toBe(0);
  expect(JSON.parse(stopped.stdout).data).toEqual({ stopped: true });
  const [code] = await output.exited;
  expect(code).toBe(0);
  expect(output.stderr).toBe("");
  expect(output.stdout.trim().split("\n")).toHaveLength(1);
  expect(output.stdout).not.toContain('"token"');
  expect(leftovers(directory)).toEqual([]);
  expect(durable(directory).runs.find(run => run.request.requestID === "cli-turn")?.status).toBe("cancelled");
}, 15_000);

it("stops cleanly on SIGTERM with a single ready envelope and no leftover runtime files", async () => {
  const output = await serve();
  child!.kill("SIGTERM");
  const [code, signal] = await output.exited;
  expect([code, signal]).toEqual([0, null]);
  expect(output.stderr).toBe("");
  expect(output.stdout.trim().split("\n").map(line => JSON.parse(line).data)).toEqual([expect.objectContaining({ ready: true })]);
  expect(leftovers(output.directory)).toEqual([]);
}, 15_000);

it("defers an early signal until startup finishes, then stops without announcing readiness", async () => {
  let started!: () => void, finishStart!: (service: unknown) => void, finishStop!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const closed = new Promise<void>(resolve => { finishStop = resolve; });
  const stop = vi.fn(async () => { finishStop(); });
  let signal: AbortSignal | undefined;
  vi.doMock("../../src/runner/service.js", () => ({ startRunner: (options: { signal?: AbortSignal }) => {
    signal = options.signal; started(); return new Promise(resolve => { finishStart = resolve; });
  } }));
  const { buildProgram } = await import("../../src/index.js");
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  const parsed = buildProgram().parseAsync(["node", "enso", "runner", "serve", "--provider", "fake"]);
  await starting;
  const handler = process.listeners("SIGTERM").find(listener => !before.SIGTERM.includes(listener))!;
  expect(process.listeners("SIGINT").filter(listener => !before.SIGINT.includes(listener))).toEqual([handler]);
  expect(signal?.aborted).toBe(false);
  handler("SIGTERM"); handler("SIGTERM");
  // Startup is told at once, so it does not dispatch the runs this signal means to stop.
  expect(signal?.aborted).toBe(true);
  finishStart({ directory: "/unused", closed, stop });
  await parsed;
  expect(stop).toHaveBeenCalled();
  expect(write.mock.calls.join("")).not.toContain("ready");
  expect(process.exitCode).toBe(0);
  expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
  expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);
  process.exitCode = undefined;
});

it("starts the service outside the invocation's request context", async () => {
  let context: unknown = "unset";
  vi.doMock("../../src/runner/service.js", () => ({ startRunner: async () => {
    context = (await import("../../src/targeting.js")).currentRequestContext();
    return { directory: "/unused", closed: Promise.resolve(), stop: async () => {} };
  } }));
  const { buildProgram } = await import("../../src/index.js");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await buildProgram().parseAsync(["node", "enso", "runner", "serve", "--provider", "fake"]);
  expect(context).toBeUndefined();
  process.exitCode = undefined;
});

it("force-exits on the third signal with that signal's conventional code", async () => {
  for (const [name, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    let finishStart!: (service: unknown) => void;
    vi.doMock("../../src/runner/service.js", () => ({ startRunner: () => new Promise(resolve => { finishStart = resolve; }) }));
    const { buildProgram } = await import("../../src/index.js");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const before = process.listeners(name);
    const parsed = buildProgram().parseAsync(["node", "enso", "runner", "serve", "--provider", "fake"]);
    await vi.waitFor(() => expect(process.listeners(name).length).toBeGreaterThan(before.length));
    const handler = process.listeners(name).find(listener => !before.includes(listener))!;
    handler(name); handler(name); handler(name);
    expect(exit).toHaveBeenCalledWith(code);
    finishStart({ directory: "/unused", closed: Promise.resolve(), stop: async () => {} });
    await parsed;
    vi.restoreAllMocks(); vi.resetModules();
  }
  process.exitCode = undefined;
});

it("removes signal handlers when startup fails", async () => {
  vi.doMock("../../src/runner/service.js", () => ({ startRunner: async () => { throw new Error("boom"); } }));
  const { buildProgram } = await import("../../src/index.js");
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const before = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
  await buildProgram().parseAsync(["node", "enso", "runner", "serve", "--provider", "fake"]);
  expect(JSON.parse(String(write.mock.calls[0][0])).error.message).toBe("boom");
  expect(process.exitCode).toBe(1);
  expect({ SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }).toEqual(before);
  process.exitCode = undefined;
});

it("rejects non-positive runner timeouts", async () => {
  for (const [subcommand, timeout] of [["shutdown", "0"], ["shutdown", "1.5"], ["call", "soon"], ["call", "2147483648"]]) {
    const result = await command(["runner", ...(subcommand === "call" ? ["call", "GET", "/v1/snapshot"] : [subcommand]), "--timeout", timeout]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
  }
}, 15_000);

it("names the range of --retain-days when a value is outside it", async () => {
  const result = await command(["runner", "serve", "--provider", "fake", "--retain-days", "40000"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error).toMatchObject({ code: "invalid_input", message: "--retain-days must be a whole number of days from 1 to 36500" });
});

it("rejects unsupported providers with a structured CLI error", async () => {
  const result = await command(["runner", "serve", "--provider", "claude"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
});

it("fails runner calls whose socket reply is not an envelope", async () => {
  const path = directory = mkdtempSync(join(tmpdir(), "enso-cli-runner-"));
  const replies = ['{"error":"x"}', "[]", '{"ok":false,"error":{"code":"route_not_found","message":"missing"}}'];
  const server = createServer((_, response) => { response.end(replies.shift()); });
  await new Promise<void>(resolve => server.listen(join(path, "control.sock"), resolve));
  writeFileSync(join(path, "connection.json"), JSON.stringify({ socketPath: join(path, "control.sock"), token: "t", protocolVersion: 1, pid: process.pid }));
  try {
    for (const method of ["GET", "POST"]) {
      const result = await command(["runner", "call", method, "/v1/snapshot", "--directory", path]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error).toMatchObject({ code: "invalid_response", details: method === "GET" ? { status: 200 } : { status: 200, outcome: "unknown" } });
    }
    const failed = await command(["runner", "call", "GET", "/v1/snapshot", "--directory", path]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr).error.code).toBe("route_not_found");
  } finally { await new Promise(resolve => server.close(resolve)); }
}, 15_000);

it("exempts runner and update commands from the update notice", async () => {
  const [{ buildProgram }, { wantsUpdateNotice }] = await Promise.all([import("../../src/index.js"), import("../../src/update.js")]);
  const program = buildProgram();
  const find = (...names: string[]) => names.reduce((command, name) => command.commands.find(child => child.name() === name)!, program);
  expect(wantsUpdateNotice(find("runner", "call"))).toBe(false);
  expect(wantsUpdateNotice(find("update"))).toBe(false);
  // Only the top-level update command is exempt; subcommands named update are ordinary edits.
  for (const group of ["node", "link", "mark", "primitive", "excerpt"]) expect(wantsUpdateNotice(find(group, "update")), group).toBe(true);
});
