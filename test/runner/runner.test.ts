import { mkdtempSync, readFileSync, rmSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runnerCall } from "../../src/runner/client.js";
import { RunnerEngine } from "../../src/runner/engine.js";
import { FakeProvider } from "../../src/runner/provider.js";
import { startRunner, type RunnerService } from "../../src/runner/service.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import type { Run } from "../../src/runner/protocol.js";

let directory: string;
let service: RunnerService | undefined;
const target = { vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222" };
const context = { selectedNodes: [{ nodeID: "node-a", noteID: "note-a", content: "# Captured\nOriginal note" }] };
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: target, workingDirectory: realpathSync(directory) });
const call = async (method: string, path: string, body?: unknown) => runnerCall(method, path, body, directory);
async function data(method: string, path: string, body?: unknown): Promise<any> {
  const result = await call(method, path, body);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}
async function session() { return data("POST", "/v1/sessions", { binding: binding() }); }
function prompt(sessionID: string, requestID = "request-1", scenario = "success", delayMs = 30) {
  return { requestID, sessionID, text: "Explain this selection", context, fake: { scenario, delayMs } };
}
async function status(id: string, wanted: string): Promise<Run> {
  for (let n = 0; n < 200; n++) {
    const run = await data("GET", `/v1/runs/${id}`);
    if (run.status === wanted) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${id} did not reach ${wanted}`);
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "enso-runner-")); });
afterEach(async () => { await service?.stop(); service = undefined; vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

describe("local runner protocol", () => {
  it("handles duplicate submissions before, during, after execution, and across restart", async () => {
    service = await startRunner({ directory, autoDispatch: false });
    const s = await session();
    const p = prompt(s.id, "same", "success", 100);
    const accepted = await data("POST", "/v1/prompts", p);
    expect(accepted.status).toBe("accepted");
    expect(await data("POST", "/v1/prompts", p)).toEqual(accepted);
    const disk = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    expect(disk.runs[0]).toEqual(accepted);
    service.engine.dispatchAccepted();
    await status("same", "running");
    expect((await data("POST", "/v1/prompts", p)).status).toBe("running");
    expect(await call("POST", "/v1/prompts", prompt(s.id, "busy-running"))).toMatchObject({ error: { code: "session_busy" } });
    const completed = await status("same", "completed");
    expect(completed.result).toMatchObject({ context, binding: binding(), turn: 1 });
    expect(await data("POST", "/v1/prompts", p)).toEqual(completed);
    expect(await call("POST", "/v1/prompts", { ...p, context: { selectedNodes: [] } })).toMatchObject({ error: { code: "request_conflict" } });
    await service.stop();
    service = await startRunner({ directory });
    expect(await data("POST", "/v1/prompts", p)).toEqual(completed);
    const next = prompt(s.id, "follow-up");
    await data("POST", "/v1/prompts", next);
    expect((await status("follow-up", "completed")).result).toMatchObject({ turn: 2 });
    expect(await data("GET", `/v1/sessions/${s.id}`)).toMatchObject({ binding: binding(), providerState: { turn: 2 } });
  });

  it("serializes concurrent duplicates, conflicts, and competing prompts without queueing", async () => {
    service = await startRunner({ directory, autoDispatch: false });
    const s = await session();
    const p = prompt(s.id);
    const duplicates = await Promise.all(Array.from({ length: 12 }, () => call("POST", "/v1/prompts", p)));
    expect(duplicates.every(result => result.ok && (result.data as Run).status === "accepted")).toBe(true);
    const conflict = await call("POST", "/v1/prompts", { ...p, text: "different" });
    expect(conflict).toMatchObject({ ok: false, error: { code: "request_conflict" } });
    const anotherSession = await session();
    expect(await call("POST", "/v1/prompts", { ...p, sessionID: anotherSession.id })).toMatchObject({ error: { code: "request_conflict" } });
    const busy = await Promise.all(["a", "b", "c"].map(id => call("POST", "/v1/prompts", prompt(s.id, id))));
    expect(busy.every(result => !result.ok && result.error.code === "session_busy")).toBe(true);
    const contenders = await Promise.all(["x", "y"].map(id => call("POST", "/v1/prompts", prompt(anotherSession.id, id))));
    expect(contenders.filter(result => result.ok)).toHaveLength(1);
    expect(contenders.filter(result => !result.ok && result.error.code === "session_busy")).toHaveLength(1);
    expect(service.engine.snapshot().runs).toHaveLength(2);
  });

  it("recovers results with snapshot plus durable events across client disconnects", async () => {
    service = await startRunner({ directory });
    const s = await session();
    await data("POST", "/v1/prompts", prompt(s.id, "reconnect", "success", 80));
    await status("reconnect", "running");
    const snapshot = await data("GET", "/v1/snapshot");
    // Drop a separate observing transport; execution is owned by the runner.
    const connection = JSON.parse(readFileSync(join(directory, "connection.json"), "utf8"));
    await new Promise<void>(resolve => {
      const req = request({ socketPath: service!.socketPath, path: "/v1/snapshot", headers: {
        Authorization: `Bearer ${connection.token}`, "Enso-Runner-Version": "1"
      } }, response => { response.destroy(); resolve(); });
      req.on("error", () => resolve()); req.end();
    });
    const complete = await status("reconnect", "completed");
    const delta = await data("GET", `/v1/events?after=${snapshot.cursor}`);
    expect(delta.events.at(-1).run).toEqual(complete);
    expect(delta.events.every((event: any) => event.sequence > snapshot.cursor)).toBe(true);
    const after = await data("GET", "/v1/snapshot");
    expect(after.runs[0]).toEqual(complete);
    expect(await data("GET", `/v1/events?after=${after.cursor}`)).toEqual({ events: [], cursor: after.cursor });
    expect(await call("GET", "/v1/events?after=999999")).toMatchObject({ error: { code: "invalid_cursor" } });
  });

  it.each(["permission", "input"])("persists %s waits, validates responses, and resumes", async scenario => {
    service = await startRunner({ directory });
    const s = await session();
    await data("POST", "/v1/prompts", prompt(s.id, "waiting", scenario));
    const waiting = await status("waiting", `waiting_${scenario}`);
    expect(waiting.pending).toMatchObject({ id: "waiting:wait", kind: scenario });
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).runs[0].pending).toEqual(waiting.pending);
    expect(await call("POST", "/v1/runs/waiting/respond", { pendingID: "wrong", value: "allow" })).toMatchObject({ error: { code: "pending_not_found" } });
    if (scenario === "permission") expect(await call("POST", "/v1/runs/waiting/respond", { pendingID: "waiting:wait", value: "invalid" })).toMatchObject({ error: { code: "invalid_input" } });
    await data("POST", "/v1/runs/waiting/respond", { pendingID: "waiting:wait", value: scenario === "permission" ? "allow" : "answer" });
    expect((await status("waiting", "completed")).result).toMatchObject({ answer: scenario === "permission" ? "allow" : "answer" });
  });

  it.each(["success", "permission", "input"])("cancels %s work and confirms a terminal state", async scenario => {
    service = await startRunner({ directory });
    const s = await session();
    await data("POST", "/v1/prompts", prompt(s.id, "stop", scenario, scenario === "success" ? 500 : 0));
    await status("stop", scenario === "success" ? "running" : `waiting_${scenario}`);
    const stopping = await data("POST", "/v1/runs/stop/cancel");
    expect(stopping.status).toBe("stopping");
    const cancelled = await status("stop", "cancelled");
    expect(cancelled.pending).toBeUndefined();
    expect(await data("POST", "/v1/runs/stop/cancel")).toEqual(cancelled);
    expect((await data("POST", "/v1/prompts", prompt(s.id, "stop", scenario, scenario === "success" ? 500 : 0))).status).toBe("cancelled");
  });

  it("cancels accepted work without dispatch and releases waits on service shutdown", async () => {
    service = await startRunner({ directory, autoDispatch: false });
    const a = await session();
    await data("POST", "/v1/prompts", prompt(a.id, "accepted"));
    expect((await data("POST", "/v1/runs/accepted/cancel")).status).toBe("cancelled");
    service.engine.dispatchAccepted();
    const b = await session();
    await data("POST", "/v1/prompts", prompt(b.id, "pending", "input", 0));
    service.engine.dispatchAccepted();
    await status("pending", "waiting_input");
    expect(await data("POST", "/v1/shutdown")).toEqual({ stopped: true });
    await service.closed;
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).runs.every((run: Run) => run.status === "cancelled")).toBe(true);
  });

  it.each(["failure", "interrupted"])("persists fake %s outcome without redispatch", async scenario => {
    service = await startRunner({ directory });
    const s = await session();
    const p = prompt(s.id, "outcome", scenario);
    await data("POST", "/v1/prompts", p);
    const outcome = await status("outcome", scenario === "failure" ? "failed" : "interrupted");
    expect(outcome.error?.code).toBe(scenario === "failure" ? "fake_failure" : "fake_uncertain");
    await service.stop(); service = await startRunner({ directory });
    expect(await data("POST", "/v1/prompts", p)).toEqual(outcome);
  });

  it("protects discovery, socket and state and rejects unauthorized/version/browser access", async () => {
    service = await startRunner({ directory });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(service.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "connection.json")).mode & 0o777).toBe(0o600);
    const connection = JSON.parse(readFileSync(join(directory, "connection.json"), "utf8"));
    const raw = (headers: Record<string, string>) => new Promise<{ status: number; body: any }>(resolve => {
      const req = request({ socketPath: service!.socketPath, path: "/v1/snapshot", headers }, response => {
        let text = ""; response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
      }); req.end();
    });
    expect(await raw({})).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
    expect(await raw({ Authorization: "Bearer wrong", "Enso-Runner-Version": "1" })).toMatchObject({ status: 401 });
    const auth = { Authorization: `Bearer ${connection.token}` };
    expect(await raw(auth)).toMatchObject({ status: 426 });
    expect(await raw({ ...auth, "Enso-Runner-Version": "2" })).toMatchObject({ status: 426 });
    expect(await raw({ ...auth, "Enso-Runner-Version": "1", Origin: "http://hostile.example" })).toMatchObject({ status: 401 });
    await session();
    const state = readFileSync(join(directory, "state.json"), "utf8");
    expect(state).not.toContain(connection.token);
    expect(statSync(join(directory, "state.json")).mode & 0o777).toBe(0o600);
    await expect(startRunner({ directory })).rejects.toMatchObject({ body: { code: "runner_locked" } });
    expect((await data("GET", "/v1/snapshot")).sessions).toHaveLength(1);
  });

  it("keeps maximum-length request IDs recoverable through pending waits", async () => {
    service = await startRunner({ directory });
    const s = await session();
    const id = "r".repeat(128);
    const p = prompt(s.id, id, "permission", 0);
    await data("POST", "/v1/prompts", p);
    const waiting = await status(id, "waiting_permission");
    await data("POST", `/v1/runs/${id}/respond`, { pendingID: waiting.pending!.id, value: "allow" });
    const completed = await status(id, "completed");
    await service.stop(); service = await startRunner({ directory });
    expect(await data("POST", "/v1/prompts", p)).toEqual(completed);
  });

  it("validates explicit targets, origins, cwd and captured context", async () => {
    service = await startRunner({ directory });
    for (const bad of [
      { ...binding(), bridgeUrl: "https://example.com" },
      { ...binding(), bridgeUrl: "http://secret@localhost:17650" },
      { ...binding(), canvasTarget: { ...target, canvasID: "name" } },
      { ...binding(), workingDirectory: "." },
      { ...binding(), workingDirectory: join(directory, "missing") }
    ]) expect(await call("POST", "/v1/sessions", { binding: bad })).toMatchObject({ ok: false });
    const s = await session();
    expect(await call("POST", "/v1/prompts", { ...prompt(s.id), context: { selectedNodes: [{ content: "missing ID" }] } })).toMatchObject({ ok: false });
    expect(await call("POST", "/v1/prompts", { ...prompt(s.id), canvas: "different" })).toMatchObject({ ok: false });
  });
});

describe("durability failure", () => {
  it("fails closed when acceptance cannot be persisted, without dispatch", async () => {
    const storage = new RunnerStorage(directory); storage.acquire();
    const provider = new FakeProvider();
    const execute = vi.spyOn(provider, "execute");
    const engine = new RunnerEngine(storage, provider);
    const s = engine.createSession({ binding: binding() });
    vi.spyOn(storage, "write").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => engine.submit(prompt(s.id))).toThrow("Durable write failed");
    await new Promise(resolve => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
    expect(() => engine.snapshot()).toThrow("Runner storage failed");
    await engine.shutdown(); storage.release();
  });
});


describe("service persistence failure", () => {
  it("shuts down after losing a terminal write and recovers as uncertain", async () => {
    service = await startRunner({ directory });
    const s = await session();
    const original = RunnerStorage.prototype.write;
    vi.spyOn(RunnerStorage.prototype, "write").mockImplementation(function (this: RunnerStorage, name, value) {
      if (name === "state.json" && (value as any).runs.at(-1)?.status === "completed") throw new Error("disk full");
      return original.call(this, name, value);
    });
    await data("POST", "/v1/prompts", prompt(s.id, "unwritten-result", "success", 20));
    await expect(service.closed).rejects.toMatchObject({ body: { code: "runner_storage_failure" } });
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).runs[0].status).toBe("running");
    vi.restoreAllMocks();
    service = await startRunner({ directory });
    const recovered = await data("GET", "/v1/runs/unwritten-result");
    expect(recovered.status).toBe("interrupted");
    expect(recovered.error.code).toBe("restart_uncertain");
  });
});
