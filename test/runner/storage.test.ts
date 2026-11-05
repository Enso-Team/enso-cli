import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerEngine } from "../../src/runner/engine.js";
import { FakeProvider, type RunnerProvider } from "../../src/runner/provider.js";
import { startRunner } from "../../src/runner/service.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import type { Run } from "../../src/runner/protocol.js";
import { allEvents, applyEvents, durable, empty } from "./replica.js";

let directory: string;
let storage: RunnerStorage;
let engine: RunnerEngine | undefined;
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory: realpathSync(directory) });
const prompt = (sessionID: string, requestID: string, scenario = "success", content = "") =>
  ({ requestID, sessionID, text: "Explain", context: { selectedNodes: [{ nodeID: "n", content }] }, fake: { scenario, delayMs: 0 } });
const path = (name: string) => join(directory, name);
const storageError = (message?: RegExp) => expect.objectContaining({ body: expect.objectContaining({ code: "invalid_runner_storage", ...(message ? { message: expect.stringMatching(message) } : {}) }) });
function open(options: { autoDispatch?: boolean; provider?: RunnerProvider; onFatal?: () => void } = {}): RunnerEngine {
  storage.release();
  storage = new RunnerStorage(directory);
  storage.acquire();
  return engine = new RunnerEngine(storage, options.provider ?? new FakeProvider(), options);
}
/** Leaves the store as a crash would: no shutdown transaction, owner released. */
function abandon(): void { engine = undefined; storage.release(); }
/** A second, independent writer: what a hand edit or a fault injected beneath the runner looks like. */
function external<T>(action: (db: Database.Database) => T): T {
  const db = new Database(path("runner.sqlite"), { fileMustExist: true });
  try { return action(db); } finally { db.close(); }
}
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
  await engine?.shutdown().catch(() => {}); engine = undefined;
  vi.restoreAllMocks(); storage.release();
  rmSync(directory, { recursive: true, force: true });
});

describe("transactions", () => {
  it("recovers exactly the committed state, which snapshot plus events reproduce", async () => {
    open();
    await history();
    const live = engine!.snapshot();
    expect(durable(directory)).toEqual(live);
    expect(applyEvents(empty(), allEvents(engine!))).toEqual(live);
    await engine!.shutdown();
    const stopped = engine!.snapshot();
    expect(stopped.runs.map(run => run.status)).toEqual(["completed", "failed", "completed", "interrupted", "cancelled"]);
    open();
    expect(engine!.snapshot()).toEqual(stopped);
    expect(applyEvents(empty(), allEvents(engine!))).toEqual(stopped);
    expect(engine!.session(stopped.sessions[0].id).providerState).toEqual({ turn: 1 });
  });

  it("converts recovered dispatched work to restart_uncertain in one transaction", async () => {
    open();
    await history();
    const { cursor } = engine!.snapshot();
    abandon();
    const commit = vi.spyOn(RunnerStorage.prototype, "commit");
    open();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(engine!.events(cursor).events).toEqual([expect.objectContaining({
      sequence: cursor + 1, type: "run_updated", requestID: "waiting", status: "interrupted", error: expect.objectContaining({ code: "restart_uncertain" })
    })]);
    expect(durable(directory)).toEqual(engine!.snapshot());
  });

  it("rolls back a transaction that fails part way, fails closed, and continues gap-free after restart", async () => {
    open({ autoDispatch: false });
    for (const id of ["a", "b", "c"]) engine!.submit(prompt(engine!.createSession({ binding: binding() }).id, id));
    const before = durable(directory);
    // The second of shutdown's three cancellations fails inside the database.
    external(db => db.exec(`CREATE TRIGGER inject BEFORE UPDATE ON runs WHEN NEW.request_id = 'b'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`));
    await expect(engine!.shutdown()).rejects.toMatchObject({ body: { code: "runner_storage_failure" } });
    expect(() => engine!.snapshot()).toThrow("Runner storage failed");
    expect(durable(directory)).toEqual(before);
    abandon();
    external(db => db.exec("DROP TRIGGER inject"));
    open({ autoDispatch: false });
    expect(engine!.snapshot()).toEqual(before);
    engine!.cancel("b");
    expect(engine!.events(before.cursor).events.map(event => event.sequence)).toEqual([before.cursor + 1]);
    expect(applyEvents(empty(), allEvents(engine!))).toEqual(durable(directory));
  });

  it("commits a completed result and its session checkpoint together or not at all", async () => {
    const onFatal = vi.fn();
    open({ onFatal, provider: { name: "fake", execute: async () => ({ status: "completed", result: { text: "done" }, providerState: { turn: 1 } }) } });
    const s = engine!.createSession({ binding: binding() });
    external(db => db.exec(`CREATE TRIGGER inject BEFORE UPDATE OF provider_state_json ON sessions
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`));
    engine!.submit(prompt(s.id, "turn"));
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalled());
    const stored = durable(directory);
    expect(stored.runs[0]).toMatchObject({ status: "running" });
    expect(stored.runs[0].result).toBeUndefined();
    expect(stored.sessions[0].providerState).toBeUndefined();
    abandon();
    external(db => db.exec("DROP TRIGGER inject"));
    open();
    expect(engine!.run("turn")).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" } });
    expect(engine!.session(s.id).providerState).toBeUndefined();
  });

  it("enforces immutability, single active runs and gap-free events in the schema itself", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(s.id, "active"));
    engine!.submit(prompt(engine!.createSession({ binding: binding() }).id, "done"));
    engine!.cancel("done");
    abandon();
    const before = readFileSync(path("runner.sqlite"));
    external(db => {
      for (const statement of [
        "UPDATE sessions SET binding_json = '{}'",
        "UPDATE runs SET request_json = '{}' WHERE request_id = 'active'",
        "UPDATE runs SET status = 'completed' WHERE request_id = 'done'",
        "UPDATE runs SET status = 'accepted' WHERE request_id = 'active'",
        `INSERT INTO runs (request_id, session_id, sequence, request_json, created_at, status, updated_at)
          SELECT 'second', session_id, 99, request_json, created_at, 'accepted', updated_at FROM runs WHERE request_id = 'active'`,
        "INSERT INTO events (sequence, type, event_json) VALUES (99, 'session_updated', '{}')",
        "DELETE FROM events WHERE sequence = 1",
        "UPDATE events SET event_json = '{}' WHERE sequence = 1",
        "DELETE FROM sessions"
      ]) expect(() => db.exec(statement), statement).toThrow();
    });
    expect(readFileSync(path("runner.sqlite"))).toEqual(before);
  });
});

describe("existing stores", () => {
  const files = () => Object.fromEntries(readdirSync(directory).sort().map(name => [name, readFileSync(path(name))]));
  const ownerReleased = () => expect(() => lstatSync(path("owner"))).toThrow();

  it.each([
    [["state.json", "log.jsonl"]],
    [["log.jsonl"]],
    [[".state.json.1234.tmp"]]
  ])("refuses a pre-SQLite store (%j) without migrating, modifying or shadowing it", async names => {
    for (const name of names) writeFileSync(path(name), `${JSON.stringify({ storageVersion: 2, sequence: 0, sessions: [], runs: [] })}\n`);
    const before = files();
    await expect(startRunner({ directory })).rejects.toMatchObject({ body: {
      code: "invalid_runner_storage", message: expect.stringContaining("pre-SQLite"), details: { legacyFiles: [...names].sort() }
    } });
    expect(files()).toEqual(before);
    expect(existsSync(path("runner.sqlite"))).toBe(false);
    ownerReleased();
  });

  it("refuses a file that is not a database", async () => {
    writeFileSync(path("runner.sqlite"), "x".repeat(4096));
    const before = files();
    await expect(startRunner({ directory })).rejects.toEqual(storageError());
    expect(files()).toEqual(before);
    ownerReleased();
  });

  it("refuses another application's database before changing its journal mode", async () => {
    const db = new Database(path("runner.sqlite"));
    db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep me')");
    db.close();
    const before = files();
    await expect(startRunner({ directory })).rejects.toEqual(storageError(/not an Enso runner database/));
    expect(files()).toEqual(before);
  });

  it("refuses an unsupported schema version without migrating it", async () => {
    open();
    engine!.createSession({ binding: binding() });
    abandon();
    external(db => db.pragma("user_version = 2"));
    const before = readFileSync(path("runner.sqlite"));
    await expect(startRunner({ directory })).rejects.toEqual(storageError(/Unsupported runner storage version 2/));
    expect(readFileSync(path("runner.sqlite"))).toEqual(before);
  });

  it.each([
    ["an invalid binding", "INSERT INTO sessions SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 99, provider, '{}', created_at, NULL FROM sessions LIMIT 1", /session/],
    ["an event gap", "DROP TRIGGER events_no_delete; DELETE FROM events WHERE sequence = 1", /sequence gap/],
    ["a damaged event", "DROP TRIGGER events_no_update; UPDATE events SET event_json = '{' WHERE sequence = 1", /event/]
  ])("refuses a store with %s", async (_name, damage, message) => {
    open();
    engine!.createSession({ binding: binding() });
    engine!.createSession({ binding: binding() });
    abandon();
    external(db => db.exec(damage));
    const before = readFileSync(path("runner.sqlite"));
    await expect(startRunner({ directory })).rejects.toEqual(storageError(message));
    expect(readFileSync(path("runner.sqlite"))).toEqual(before);
    ownerReleased();
  });

  // A crash leaves committed transactions in runner.sqlite-wal. Refusal must not fold them into the main file.
  it.each([
    ["another application's database", null, /not an Enso runner database/],
    ["a newer runner store", "PRAGMA user_version = 2", /Unsupported runner storage version 2/],
    ["a damaged runner store", "INSERT INTO sessions SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 99, provider, '{}', created_at, NULL FROM sessions LIMIT 1", /session/]
  ])("refuses %s with a live WAL, leaving the database and WAL unchanged", async (_name, damage, message) => {
    const source = mkdtempSync(join(tmpdir(), "enso-source-"));
    const owner = new RunnerStorage(source);
    try {
      let open: Database.Database;
      if (damage === null) {
        open = new Database(join(source, "runner.sqlite"));
        open.pragma("journal_mode = WAL");
        open.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep me')");
      } else {
        owner.acquire();
        new RunnerEngine(owner, new FakeProvider(), { autoDispatch: false }).createSession({ binding: binding() });
        open = new Database(join(source, "runner.sqlite"));
        open.exec(damage);
      }
      // Copied while still open, as SIGKILL would leave it.
      for (const name of ["runner.sqlite", "runner.sqlite-wal"]) copyFileSync(join(source, name), path(name));
      open.close();
    } finally { owner.release(); rmSync(source, { recursive: true, force: true }); }
    expect(statSync(path("runner.sqlite-wal")).size).toBeGreaterThan(0);
    const data = () => ["runner.sqlite", "runner.sqlite-wal"].map(name => readFileSync(path(name)));
    const before = data();
    await expect(startRunner({ directory })).rejects.toEqual(storageError(message));
    expect(data()).toEqual(before);
    ownerReleased();
  });

  it("initializes a database file left empty by a crash during creation", async () => {
    writeFileSync(path("runner.sqlite"), "");
    open();
    engine!.createSession({ binding: binding() });
    expect(durable(directory).cursor).toBe(1);
  });
});

describe("events", () => {
  it("pages large histories while snapshot and cursor stay consistent", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    const content = "x".repeat(600 * 1024);
    for (const id of ["a", "b", "c"]) { engine!.submit(prompt(s.id, id, "success", content)); engine!.cancel(id); }
    const first = engine!.events(0);
    expect(first.events.map(event => event.type)).toEqual(["session_created", "run_accepted", "run_updated"]);
    expect(first.cursor).toBe(3);
    const events = allEvents(engine!);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const snapshot = engine!.snapshot();
    expect(applyEvents(empty(), events)).toEqual(snapshot);
    expect(engine!.events(snapshot.cursor)).toEqual({ events: [], cursor: snapshot.cursor });
    expect(() => engine!.events(snapshot.cursor + 1)).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "invalid_cursor" }) }));
    // A transition of a large run carries only its delta, never the captured context.
    expect(JSON.stringify(events.at(-1)).length).toBeLessThan(512);
  });
});
