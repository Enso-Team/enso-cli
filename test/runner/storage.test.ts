import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerEngine } from "../../src/runner/engine.js";
import { FakeProvider } from "../../src/runner/provider.js";
import { startRunner, type RunnerService } from "../../src/runner/service.js";
import { apply, restore, toSnapshot, type State } from "../../src/runner/state.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import type { Run } from "../../src/runner/protocol.js";

let directory: string;
let storage: RunnerStorage;
let engine: RunnerEngine | undefined;
let service: RunnerService | undefined;
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory: realpathSync(directory) });
const prompt = (sessionID: string, requestID: string, scenario = "success", content = "") =>
  ({ requestID, sessionID, text: "Explain", context: { selectedNodes: [{ nodeID: "n", content }] }, fake: { scenario, delayMs: 0 } });
const live = (target: RunnerEngine) => (target as unknown as { state: State }).state;
const durable = () => new RunnerStorage(directory).load().state;
const path = (name: string) => join(directory, name);
const lines = () => readFileSync(path("log.jsonl"), "utf8").split("\n").slice(0, -1);
function open(options: { compactBytes?: number; autoDispatch?: boolean } = {}): RunnerEngine {
  storage.release();
  storage = new RunnerStorage(directory, { compactBytes: options.compactBytes });
  storage.acquire();
  return engine = new RunnerEngine(storage, new FakeProvider(), { autoDispatch: options.autoDispatch });
}
/** Leaves the store as a crash would: no shutdown transaction, owner released. */
function abandon(): void { engine = undefined; storage.release(); }
async function status(id: string, wanted: Run["status"]): Promise<Run> {
  for (let n = 0; n < 200; n++) {
    const run = engine!.run(id);
    if (run.status === wanted) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${id} did not reach ${wanted}`);
}
/** Several sessions and every kind of transition, including multi-event commits. */
async function history(): Promise<string> {
  const [a, b, c] = Array.from({ length: 3 }, () => engine!.createSession({ binding: binding() }));
  engine!.submit(prompt(a.id, "done"));
  await status("done", "completed");
  engine!.submit(prompt(a.id, "failed", "failure"));
  await status("failed", "failed");
  engine!.submit(prompt(b.id, "input", "input"));
  await status("input", "waiting_input");
  engine!.answer("input", { pendingID: "input:wait", value: "yes" });
  await status("input", "completed");
  engine!.submit(prompt(b.id, "uncertain", "interrupted"));
  await status("uncertain", "interrupted");
  engine!.submit(prompt(c.id, "waiting", "permission"));
  await status("waiting", "waiting_permission");
  return c.id;
}

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "enso-storage-")); storage = new RunnerStorage(directory); });
afterEach(async () => {
  await engine?.shutdown(); engine = undefined;
  await service?.stop(); service = undefined;
  vi.restoreAllMocks(); storage.release();
  rmSync(directory, { recursive: true, force: true });
});

describe("replay", () => {
  it.each([undefined, 1])("recovers state deep-equal to the live state (compactBytes %s)", async compactBytes => {
    open({ compactBytes });
    await history();
    expect(existsSync(path("state.json"))).toBe(compactBytes === 1);
    expect(durable()).toEqual(live(engine!));
    await engine!.shutdown();
    const stopped = structuredClone(live(engine!));
    expect(durable()).toEqual(stopped);
    open({ compactBytes });
    expect(live(engine!)).toEqual(stopped);
    expect(engine!.snapshot().runs.map(run => run.status)).toEqual(["completed", "failed", "completed", "interrupted", "cancelled"]);
    expect(engine!.session(engine!.snapshot().sessions[0].id).providerState).toEqual({ turn: 1 });
  });

  it("converts recovered dispatched work to restart_uncertain in one transaction", async () => {
    open();
    await history();
    abandon();
    const before = lines().length;
    open();
    expect(lines()).toHaveLength(before + 1);
    expect(engine!.run("waiting")).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" } });
    expect(durable()).toEqual(live(engine!));
  });
});

describe("torn and damaged logs", () => {
  it("ignores and truncates a torn final line, then appends durably", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(s.id, "a"));
    const before = structuredClone(live(engine!));
    abandon();
    appendFileSync(path("log.jsonl"), '{"events":[{"sequence":3,"type":"run_upd');
    const torn = readFileSync(path("log.jsonl"));
    expect(durable()).toEqual(before);
    expect(readFileSync(path("log.jsonl"))).toEqual(torn);
    open({ autoDispatch: false });
    expect(live(engine!)).toEqual(before);
    engine!.cancel("a");
    expect(lines().map(line => JSON.parse(line).events[0].sequence)).toEqual([1, 2, 3]);
    abandon();
    expect(durable().runs.get("a")!.status).toBe("cancelled");
    expect(durable().sequence).toBe(3);
  });

  it.each(["newline", "half"])("applies none of a multi-event transaction torn at its %s", async cut => {
    open({ autoDispatch: false });
    for (const id of ["a", "b", "c"]) engine!.submit(prompt(engine!.createSession({ binding: binding() }).id, id));
    const before = structuredClone(live(engine!));
    await engine!.shutdown();
    abandon();
    const text = readFileSync(path("log.jsonl"), "utf8");
    const last = text.slice(text.lastIndexOf("\n", text.length - 2) + 1);
    expect(JSON.parse(last).events).toHaveLength(3);
    writeFileSync(path("log.jsonl"), text.slice(0, text.length - (cut === "newline" ? 1 : Math.floor(last.length / 2))));
    expect(durable()).toEqual(before);
  });

  it.each([
    ["a corrupt middle line", (all: string[]) => { all[2] = "{not json"; }],
    ["a missing middle line", (all: string[]) => { all.splice(2, 1); }],
    ["a repeated line", (all: string[]) => { all.splice(2, 0, all[2]); }],
    ["a complete but invalid last line", (all: string[]) => { all.push('{"events":[]}'); }],
    ["an invariant violation", (all: string[]) => { all[1] = all[0].replace('"sequence":1,', '"sequence":2,'); }]
  ])("refuses %s without touching the files", async (_name, damage) => {
    open();
    await history();
    await engine!.shutdown();
    abandon();
    const all = lines();
    damage(all);
    writeFileSync(path("log.jsonl"), all.join("\n") + "\n");
    writeFileSync(path("state.json"), JSON.stringify({ storageVersion: 2, sequence: 0, sessions: [], runs: [] }) + "\n");
    const files = ["log.jsonl", "state.json"].map(name => readFileSync(path(name)));
    await expect(startRunner({ directory })).rejects.toMatchObject({ body: { code: "invalid_runner_storage" } });
    expect(["log.jsonl", "state.json"].map(name => readFileSync(path(name)))).toEqual(files);
  });

  it("refuses a snapshot whose binding has a corrupted canvasTarget", async () => {
    open();
    engine!.createSession({ binding: binding() });
    await engine!.shutdown();
    abandon();
    const snapshot = toSnapshot(durable());
    snapshot.sessions[0].binding.canvasTarget = { vaultID: "vault", canvasID: "canvas" } as never;
    writeFileSync(path("state.json"), JSON.stringify(snapshot) + "\n");
    writeFileSync(path("log.jsonl"), "");
    expect(() => durable()).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "invalid_runner_storage" }) }));
  });
});

describe("compaction", () => {
  it.each([
    ["the snapshot rename", "tmp"],
    ["log truncation", "renamed"],
    ["the next append", "truncated"],
    ["an earlier compaction", "earlier"]
  ])("recovers a crash before %s without loss or double apply", async (_name, step) => {
    open();
    await history();
    const middle = toSnapshot(structuredClone(live(engine!)));
    await engine!.shutdown();
    const final = structuredClone(live(engine!));
    abandon();
    const log = readFileSync(path("log.jsonl"));
    const snapshot = JSON.stringify(toSnapshot(final)) + "\n";
    if (step === "tmp") writeFileSync(path(".state.json.crash.tmp"), snapshot);
    if (step === "renamed" || step === "truncated") writeFileSync(path("state.json"), snapshot);
    if (step === "truncated") writeFileSync(path("log.jsonl"), "");
    if (step === "earlier") writeFileSync(path("state.json"), JSON.stringify(middle) + "\n");
    expect(readFileSync(path("log.jsonl")).length).toBe(step === "truncated" ? 0 : log.length);
    expect(durable()).toEqual(final);
    open();
    expect(live(engine!)).toEqual(final);
    engine!.createSession({ binding: binding() });
    expect(durable()).toEqual(live(engine!));
  });

  it("refuses a log that skips past or falls short of its snapshot", async () => {
    open();
    await history();
    const middle = toSnapshot(structuredClone(live(engine!)));
    await engine!.shutdown();
    abandon();
    const all = lines();
    writeFileSync(path("state.json"), JSON.stringify(middle) + "\n");
    writeFileSync(path("log.jsonl"), all.slice(0, 2).join("\n") + "\n");
    expect(() => durable()).toThrow(/does not reach its snapshot/);
    writeFileSync(path("state.json"), JSON.stringify({ ...middle, sequence: 1, sessions: middle.sessions.slice(0, 1), runs: [] }) + "\n");
    writeFileSync(path("log.jsonl"), all.slice(3).join("\n") + "\n");
    expect(() => durable()).toThrow(/does not continue its snapshot/);
  });

  it("keeps per-transaction writes independent of history size", async () => {
    open({ autoDispatch: false });
    const size = () => statSync(path("log.jsonl")).size;
    const measure = (action: () => void) => { const before = size(); action(); return size() - before; };
    const first = engine!.createSession({ binding: binding() });
    const sessionBytes = measure(() => engine!.createSession({ binding: binding() }));
    const cancelBytes = measure(() => { engine!.submit(prompt(first.id, "small")); engine!.cancel("small"); });
    const write = vi.spyOn(storage, "write");
    const content = "x".repeat(200 * 1024);
    for (let n = 0; n < 20; n++) {
      engine!.submit(prompt(first.id, `big-${n}`, "success", content));
      engine!.cancel(`big-${n}`);
    }
    expect(size()).toBeGreaterThan(20 * 200 * 1024);
    expect(Math.abs(measure(() => engine!.createSession({ binding: binding() })) - sessionBytes)).toBeLessThan(8);
    expect(measure(() => { engine!.submit(prompt(first.id, "late")); engine!.cancel("late"); }) - cancelBytes).toBeLessThan(8);
    // A transition of a large run carries only its delta, never the captured context.
    engine!.submit(prompt(first.id, "big-last", "success", content));
    expect(measure(() => engine!.cancel("big-last"))).toBeLessThan(512);
    expect(write).not.toHaveBeenCalled();
  });

  it("expires cursors before the retained window, consistently across restart", async () => {
    open({ compactBytes: 64 * 1024, autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    expect(engine!.events(0).events.map(event => event.type)).toEqual(["session_created"]);
    engine!.submit(prompt(s.id, "big", "success", "x".repeat(100 * 1024)));
    expect(existsSync(path("state.json"))).toBe(true);
    // Compaction keeps the triggering line, so a caught-up client still polls across it.
    expect(readFileSync(path("log.jsonl"), "utf8").trim().split("\n").flatMap(line => JSON.parse(line).events.map((event: { sequence: number }) => event.sequence))).toEqual([2]);
    expect(engine!.events(1).events.map(event => event.sequence)).toEqual([2]);
    expect(() => engine!.events(0)).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "cursor_expired" }) }));
    expect(() => engine!.events(3)).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "invalid_cursor" }) }));
    const snapshot = engine!.snapshot();
    expect(snapshot.cursor).toBe(2);
    engine!.cancel("big");
    const delta = engine!.events(snapshot.cursor);
    expect(delta.events).toEqual([expect.objectContaining({ sequence: 3, type: "run_updated", requestID: "big", status: "cancelled" })]);
    const local = restore({ storageVersion: 2, sequence: snapshot.cursor, sessions: snapshot.sessions, runs: snapshot.runs });
    for (const event of delta.events) apply(local, event);
    expect(local).toEqual(live(engine!));
    abandon();
    open({ compactBytes: 64 * 1024 });
    expect(engine!.events(2)).toEqual(delta);
    expect(engine!.events(1).events.map(event => event.sequence)).toEqual([2, 3]);
    expect(() => engine!.events(0)).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "cursor_expired" }) }));
  });

  it("reports cursor_expired over HTTP as 410", async () => {
    service = await startRunner({ directory, compactBytes: 1 });
    service.engine.createSession({ binding: binding() });
    service.engine.createSession({ binding: binding() });
    const { socketPath, token } = JSON.parse(readFileSync(path("connection.json"), "utf8"));
    const response = await new Promise<{ status?: number; body: any }>(resolve => {
      request({ socketPath, path: "/v1/events?after=0", headers: { Authorization: `Bearer ${token}`, "Enso-Runner-Version": "1" } }, res => {
        let text = ""; res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      }).end();
    });
    expect(response).toMatchObject({ status: 410, body: { ok: false, error: { code: "cursor_expired" } } });
  });
});
