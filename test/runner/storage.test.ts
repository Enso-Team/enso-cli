import { chmodSync, copyFileSync, existsSync, lstatSync, symlinkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
function open(options: { autoDispatch?: boolean; provider?: RunnerProvider; onFatal?: () => void; reclaimStep?: number } = {}): RunnerEngine {
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
    external(db => db.exec(`CREATE TRIGGER inject BEFORE UPDATE ON sessions
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

  it("compiles each statement once per connection and reuses it", async () => {
    open({ autoDispatch: false });
    const exercise = (id: string) => {
      const s = engine!.createSession({ binding: binding() });
      engine!.submit(prompt(s.id, id));
      engine!.cancel(id);
      engine!.snapshot();
      engine!.events(0);
    };
    exercise("warm");
    const prepare = vi.spyOn(Database.prototype, "prepare");
    exercise("again");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("enforces immutability, single active runs, gap-free events and row-event linkage in the schema itself", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(s.id, "active"));
    engine!.submit(prompt(engine!.createSession({ binding: binding() }).id, "done"));
    engine!.cancel("done");
    abandon();
    const before = readFileSync(path("runner.sqlite"));
    const next = durable(directory).cursor + 1;
    const updated = (requestID: string, status: string) =>
      `INSERT INTO events (sequence, type, subject, event_json) VALUES (${next}, 'run_updated', '${requestID}', json_object('type', 'run_updated', 'requestID', '${requestID}', 'status', '${status}', 'updatedAt', 'now'))`;
    external(db => {
      for (const statements of [
        // Rows change only with the event that changes them, and only the way that event says.
        ["UPDATE sessions SET sequence = 99"],
        ["UPDATE sessions SET last_sequence = 1"],
        ["UPDATE runs SET session_id = (SELECT id FROM sessions WHERE id <> runs.session_id) WHERE request_id = 'active'"],
        ["UPDATE runs SET status = 'running' WHERE request_id = 'active'"],
        [updated("active", "running"), `UPDATE runs SET last_sequence = ${next}, status = 'completed' WHERE request_id = 'active'`],
        [updated("done", "running"), `UPDATE runs SET last_sequence = ${next}, status = 'running' WHERE request_id = 'done'`],
        [updated("active", "accepted"), `UPDATE runs SET last_sequence = ${next}, status = 'accepted' WHERE request_id = 'active'`],
        ["INSERT INTO runs (request_id, session_id, sequence, last_sequence, status) SELECT 'second', session_id, 2, 2, 'accepted' FROM runs WHERE request_id = 'active'"],
        [`INSERT INTO sessions (id, sequence, last_sequence) VALUES ('${s.id}', 1, 1)`],
        // Events are append-only, gap-free, and name their own subject.
        ["INSERT INTO events (sequence, type, subject, event_json) VALUES (99, 'session_updated', NULL, '{}')"],
        [`INSERT INTO events (sequence, type, subject, event_json) VALUES (${next}, 'session_updated', 'someone-else', json_object('type', 'session_updated', 'sessionID', '${s.id}'))`],
        ["UPDATE events SET event_json = '{}' WHERE sequence = 1"],
        // Only retention deletes, and only announced, finished runs and their expired events.
        ["DELETE FROM events WHERE sequence = 1"],
        ["DELETE FROM sessions"],
        ["DELETE FROM runs WHERE request_id = 'done'"],
        [`INSERT INTO events (sequence, type, subject, event_json) VALUES (${next}, 'runs_deleted', NULL, json_object('type', 'runs_deleted', 'requestIDs', json_array('active')))`,
          "DELETE FROM runs WHERE request_id = 'active'"],
        ["UPDATE retention SET expired_through = 1"],
        ["DELETE FROM retention"]
      ]) {
        // Each case runs alone and rolls back, so only its final statement can be the one refused.
        db.exec("BEGIN");
        try {
          for (const statement of statements.slice(0, -1)) db.exec(statement);
          // A constraint or trigger, not a mistyped statement, must be what refuses it.
          expect(() => db.exec(statements.at(-1)!), statements.at(-1)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) }));
        } finally { db.exec("ROLLBACK"); }
      }
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
    await expect(startRunner({ directory })).rejects.toMatchObject({ body: {
      code: "invalid_runner_storage", details: { cause: { code: "SQLITE_NOTADB" } }
    } });
    expect(files()).toEqual(before);
    ownerReleased();
  });

  it.each(["SQLITE_READONLY_CANTINIT", "SQLITE_PROTOCOL", "SQLITE_PERM", "SQLITE_NOMEM"])("reports %s while judging a store as a failure, not a refusal", async code => {
    open();
    abandon();
    const pragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (source === "application_id") throw Object.assign(new Error("not a judgment"), { code });
      return pragma.call(this, source, options);
    });
    const error = await startRunner({ directory }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ body: { code: "runner_storage_failure", details: { cause: { code } } } });
    expect((error as Error).message).not.toMatch(/refusing/);
    ownerReleased();
  });

  it("reports a lock held inside SQLite as locked, not as a refused store", async () => {
    open();
    abandon();
    const pragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (source === "quick_check") throw Object.assign(new Error("database table is locked"), { code: "SQLITE_LOCKED" });
      return pragma.call(this, source, options);
    });
    await expect(startRunner({ directory })).rejects.toMatchObject({ body: { code: "runner_locked" } });
  });

  it("does not claim to refuse a store it created when initializing it fails", async () => {
    const pragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (source === "journal_mode = WAL") throw new Error("no WAL here");
      return pragma.call(this, source, options);
    });
    await expect(startRunner({ directory })).rejects.toEqual(storageError(/^Runner database could not be initialized$/));
    ownerReleased();
  });

  it("refuses another application's database before changing its journal mode", async () => {
    const db = new Database(path("runner.sqlite"));
    db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep me')");
    db.close();
    const before = files();
    const refusal = await startRunner({ directory }).then(() => undefined, (error: Error) => error);
    expect(refusal).toEqual(storageError(/not an Enso runner database; refusing to dispatch or overwrite it$/));
    // Amended in place, so the stack still points at the check that failed.
    expect(refusal?.stack).not.toContain("at refused");
    expect(files()).toEqual(before);
    // `check` only reads, so it reports the same problem without claiming to refuse anything.
    expect(() => RunnerStorage.check(directory)).toThrow(storageError(/not an Enso runner database$/));
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
    ["an invalid binding", "DROP TRIGGER events_no_update; UPDATE events SET event_json = json_set(event_json, '$.session.binding', json('{}')) WHERE sequence = 1", /event/],
    ["an event gap", "PRAGMA foreign_keys = OFF; DROP TRIGGER events_deleted_expired_only; DELETE FROM events WHERE sequence = 1", /sequence gap/],
    ["a damaged event", "DROP TRIGGER events_no_update; PRAGMA ignore_check_constraints = ON; UPDATE events SET event_json = '{' WHERE sequence = 1", /event/],
    ["a row pointing at an older event", "DROP TRIGGER sessions_updated; UPDATE sessions SET last_sequence = sequence - 1 WHERE sequence = 2", /reference|rows do not match/],
    ["an event without its row", "DROP TRIGGER sessions_no_delete; PRAGMA foreign_keys = OFF; DELETE FROM sessions WHERE sequence = 2", /rows do not match/]
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
    ["a damaged runner store", "DROP TRIGGER events_no_update; UPDATE events SET event_json = json_set(event_json, '$.session.binding', json('{}')) WHERE sequence = 1", /event/]
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

  // A store moved or deleted without its WAL files: SQLite would discard them, destroying the moved store's last commits.
  it.each([["missing", null], ["empty", ""]])("refuses journals beside a %s database without creating or changing anything", async (_name, main) => {
    const source = mkdtempSync(join(tmpdir(), "enso-source-"));
    const owner = new RunnerStorage(source);
    try {
      owner.acquire();
      new RunnerEngine(owner, new FakeProvider(), { autoDispatch: false }).createSession({ binding: binding() });
      // Copied while still open, as SIGKILL would leave it.
      for (const name of ["runner.sqlite-wal", "runner.sqlite-shm"]) copyFileSync(join(source, name), path(name));
    } finally { owner.release(); rmSync(source, { recursive: true, force: true }); }
    if (main !== null) writeFileSync(path("runner.sqlite"), main);
    expect(statSync(path("runner.sqlite-wal")).size).toBeGreaterThan(0);
    const before = files();
    await expect(startRunner({ directory })).rejects.toMatchObject({ body: {
      code: "invalid_runner_storage", details: { journalFiles: ["runner.sqlite-shm", "runner.sqlite-wal"] }
    } });
    expect(files()).toEqual(before);
    ownerReleased();
  });

  it("initializes a database file left empty by a crash during creation", async () => {
    writeFileSync(path("runner.sqlite"), "");
    open();
    engine!.createSession({ binding: binding() });
    expect(durable(directory).cursor).toBe(1);
  });

  // Initializing an empty file writes its first page through a rollback journal. SQLite discards a journal beside an
  // empty database rather than applying it.
  it("initializes an empty database left beside the journal of a crash during initialization", async () => {
    const source = mkdtempSync(join(tmpdir(), "enso-source-"));
    try {
      const db = new Database(join(source, "runner.sqlite"));
      db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('before')");
      db.exec("BEGIN IMMEDIATE; UPDATE notes SET body = 'during'");
      // Copied mid-transaction, as SIGKILL would leave it.
      copyFileSync(join(source, "runner.sqlite-journal"), path("runner.sqlite-journal"));
      db.exec("ROLLBACK");
      db.close();
    } finally { rmSync(source, { recursive: true, force: true }); }
    expect(statSync(path("runner.sqlite-journal")).size).toBeGreaterThan(0);
    writeFileSync(path("runner.sqlite"), "");
    open();
    engine!.createSession({ binding: binding() });
    expect(durable(directory).cursor).toBe(1);
    expect(existsSync(path("runner.sqlite-journal"))).toBe(false);
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

describe("retention", () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const expired = expect.objectContaining({ body: expect.objectContaining({ code: "cursor_expired" }) });

  it("deletes finished runs older than the cutoff with their events, expiring only cursors that cannot replay", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    const other = engine!.createSession({ binding: binding() });
    for (const id of ["old-1", "old-2"]) { engine!.submit(prompt(s.id, id)); engine!.cancel(id); }
    const beforeOld = engine!.snapshot();
    await sleep(5);
    const cutoff = new Date();
    await sleep(5);
    engine!.submit(prompt(s.id, "new"));
    engine!.cancel("new");
    engine!.submit(prompt(other.id, "active"));
    const caughtUp = engine!.snapshot();

    expect(await engine!.deleteFinishedBefore(cutoff)).toBe(2);
    const after = engine!.snapshot();
    expect(after.runs.map(run => run.request.requestID)).toEqual(["new", "active"]);
    expect(() => engine!.run("old-1")).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "run_not_found" }) }));
    expect(allEvents(engine!, beforeOld.cursor).at(-1)).toEqual({ sequence: after.cursor, type: "runs_deleted", requestIDs: ["old-1", "old-2"] });
    // A client at or past the last deleted event replays to the same state, removing the deleted runs.
    expect(applyEvents(caughtUp, allEvents(engine!, caughtUp.cursor))).toEqual(after);
    expect(applyEvents(beforeOld, allEvents(engine!, beforeOld.cursor))).toEqual(after);
    // One below it would miss events, so it must take a new snapshot.
    expect(() => engine!.events(beforeOld.cursor - 1)).toThrow(expired);
    expect(() => engine!.events(0)).toThrow(expired);
    expect(await engine!.deleteFinishedBefore(cutoff)).toBe(0);

    abandon();
    open({ autoDispatch: false });
    expect(engine!.snapshot()).toEqual(after);
    expect(RunnerStorage.check(directory)).toMatchObject({ runs: 2, expiredThrough: beforeOld.cursor, differences: [] });
    // A deleted request ID is free: resubmitting it is a new run, which retention can delete again.
    engine!.submit(prompt(s.id, "old-1"));
    engine!.cancel("old-1");
    expect(await engine!.deleteFinishedBefore(new Date(Date.now() + 1000))).toBe(2);
    expect(engine!.snapshot().runs.map(run => run.request.requestID)).toEqual(["active"]);
    expect(RunnerStorage.check(directory).differences).toEqual([]);
  });

  it("deletes the session checkpoints that expired history superseded, keeping each session's latest", async () => {
    open();
    const s = engine!.createSession({ binding: binding() });
    for (const id of ["t1", "t2", "t3"]) { engine!.submit(prompt(s.id, id)); await status(id, "completed"); }
    const checkpoints = () => external(db => db.prepare("SELECT sequence FROM events WHERE type = 'session_updated' ORDER BY sequence").pluck().all() as number[]);
    const all = checkpoints();
    expect(all).toHaveLength(3);
    const { sessions } = engine!.snapshot();

    expect(await engine!.deleteFinishedBefore(new Date(Date.now() + 1000))).toBe(3);
    expect(checkpoints()).toEqual([all[2]]);
    expect(engine!.snapshot().sessions).toEqual(sessions);
    expect(RunnerStorage.check(directory).differences).toEqual([]);
    // The latest checkpoint is the session's state, so the schema refuses to delete it.
    external(db => expect(() => db.exec(`DELETE FROM events WHERE sequence = ${all[2]}`)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) })));

    abandon();
    open();
    expect(engine!.snapshot().sessions).toEqual(sessions);
    // The next turn continues from the kept checkpoint.
    engine!.submit(prompt(s.id, "t4"));
    await status("t4", "completed");
    expect(engine!.snapshot().sessions[0].providerState).toEqual({ turn: 4 });
  });

  it("stores each payload once and returns deleted space to the file system", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    const content = "x".repeat(600 * 1024);
    const pages = () => external(db => ({ pages: db.pragma("page_count", { simple: true }) as number, free: db.pragma("freelist_count", { simple: true }) }));
    const empty = pages().pages;
    for (const id of ["a", "b", "c"]) { engine!.submit(prompt(s.id, id, "success", content)); engine!.cancel(id); }
    const full = pages().pages;
    // Three captured contexts, each stored once: well under the six copies a row and its event would hold.
    expect((full - empty) * 4096).toBeLessThan(3 * content.length * 1.2);
    expect(await engine!.deleteFinishedBefore(new Date(Date.now() + 1000))).toBe(3);
    expect(pages()).toEqual({ pages: expect.any(Number), free: 0 });
    expect(pages().pages).toBeLessThan(empty + (full - empty) / 10);
  });

  it("returns freed space in bounded steps, serving requests between them", async () => {
    open({ autoDispatch: false, reclaimStep: 32 });
    const s = engine!.createSession({ binding: binding() });
    for (const id of ["a", "b", "c"]) { engine!.submit(prompt(s.id, id, "success", "x".repeat(600 * 1024))); engine!.cancel(id); }
    const spy = vi.spyOn(Database.prototype, "pragma");
    const vacuums = () => spy.mock.calls.filter(([source]) => source.startsWith("incremental_vacuum"));
    const pass = engine!.deleteFinishedBefore(new Date(Date.now() + 1000));
    // The deletion and the first step ran before the pass yielded; requests are served while the rest waits.
    expect(vacuums()).toHaveLength(1);
    expect(engine!.snapshot().runs).toEqual([]);
    expect(await pass).toBe(3);
    // The first freelist read is what the deletion freed: one step per 32 of those pages, whatever the layout.
    const freed = spy.mock.results[spy.mock.calls.findIndex(([source]) => source === "freelist_count")]!.value as number;
    expect(freed).toBeGreaterThan(32);
    expect(vacuums()).toHaveLength(Math.ceil(freed / 32));
    expect(new Set(vacuums().map(([source]) => source))).toEqual(new Set(["incremental_vacuum(32)"]));
    expect(external(db => db.pragma("freelist_count", { simple: true }))).toBe(0);
  });

  it("keeps releasing when commits free more pages between its steps", async () => {
    open({ autoDispatch: false, reclaimStep: 32 });
    external(db => db.exec("CREATE TABLE scratch (body BLOB); INSERT INTO scratch VALUES (randomblob(1048576))"));
    const s = engine!.createSession({ binding: binding() });
    for (const id of ["a", "b", "c"]) { engine!.submit(prompt(s.id, id, "success", "x".repeat(600 * 1024))); engine!.cancel(id); }
    const pass = engine!.deleteFinishedBefore(new Date(Date.now() + 1000));
    // The first step ran before the pass yielded; a commit now frees far more than a step releases.
    external(db => db.exec("DROP TABLE scratch"));
    expect(await pass).toBe(3);
    expect(external(db => db.pragma("freelist_count", { simple: true }))).toBe(0);
  });

  it("leaves a few free pages for later writes instead of releasing them", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(s.id, "done", "success", "x".repeat(64 * 1024)));
    engine!.cancel("done");
    const spy = vi.spyOn(Database.prototype, "pragma");
    expect(await engine!.deleteFinishedBefore(new Date(Date.now() + 1000))).toBe(1);
    expect(spy.mock.calls.filter(([source]) => source.startsWith("incremental_vacuum"))).toEqual([]);
    expect(external(db => db.pragma("freelist_count", { simple: true }))).toBeGreaterThan(0);
  });

  it("leaves the rest of the free space to the next pass when shutdown stops one", async () => {
    open({ autoDispatch: false, reclaimStep: 32 });
    const s = engine!.createSession({ binding: binding() });
    for (const id of ["a", "b", "c"]) { engine!.submit(prompt(s.id, id, "success", "x".repeat(600 * 1024))); engine!.cancel(id); }
    const pass = engine!.deleteFinishedBefore(new Date(Date.now() + 1000));
    await engine!.shutdown();
    expect(await pass).toBe(3);
    const free = () => external(db => db.pragma("freelist_count", { simple: true }) as number);
    expect(free()).toBeGreaterThan(0);
    open({ autoDispatch: false });
    // Nothing left to delete, but the free pages the stopped pass left are still returned.
    expect(await engine!.deleteFinishedBefore(new Date(Date.now() + 1000))).toBe(0);
    expect(free()).toBe(0);
  });

  // The vacuum itself, or the count after it: either way SQLite failed beneath a write, so the runner stops.
  it.each([
    ["the vacuum", (source: string) => source.startsWith("incremental_vacuum")],
    ["counting what is left", (() => { let counts = 0; return (source: string) => source === "freelist_count" && ++counts === 2; })()]
  ])("fails closed when %s fails, keeping the deletion", async (_name, failing) => {
    let fatal = 0;
    open({ autoDispatch: false, onFatal: () => fatal++ });
    const s = engine!.createSession({ binding: binding() });
    for (const id of ["a", "b", "c"]) { engine!.submit(prompt(s.id, id, "success", "x".repeat(600 * 1024))); engine!.cancel(id); }
    const pragma = Database.prototype.pragma;
    const spy = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (failing(source)) throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      return pragma.call(this, source, options);
    });
    const failure = expect.objectContaining({ body: expect.objectContaining({ code: "runner_storage_failure" }) });
    await expect(engine!.deleteFinishedBefore(new Date(Date.now() + 1000))).rejects.toEqual(failure);
    expect(fatal).toBe(1);
    expect(() => engine!.submit(prompt(s.id, "next"))).toThrow(failure);
    spy.mockRestore();
    // After a restart the deletion is durable, and the next pass returns the space though it deletes nothing.
    open({ autoDispatch: false });
    expect(engine!.snapshot().runs).toEqual([]);
    const free = () => external(db => db.pragma("freelist_count", { simple: true }) as number);
    expect(await engine!.deleteFinishedBefore(new Date(Date.now() + 1000))).toBe(0);
    expect(free()).toBe(0);
  });

  it("serve --retain-days is ready, and stops, without waiting for its first pass", async () => {
    let passes = 0;
    vi.spyOn(RunnerEngine.prototype, "deleteFinishedBefore").mockImplementation(() => { passes++; return new Promise<number>(() => {}); });
    const service = await startRunner({ directory, retainDays: 1, autoDispatch: false });
    // Not even the first batch runs before startRunner returns.
    expect(passes).toBe(0);
    await new Promise(resolve => setImmediate(resolve));
    expect(passes).toBe(1);
    await service.stop();
  });

  it("serve --retain-days dispatches accepted runs before its first pass", async () => {
    const order: string[] = [];
    vi.spyOn(RunnerEngine.prototype, "dispatchAccepted").mockImplementation(() => { order.push("dispatch"); });
    vi.spyOn(RunnerEngine.prototype, "deleteFinishedBefore").mockImplementation(async () => { order.push("retention"); return 0; });
    const service = await startRunner({ directory, retainDays: 1 });
    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual(["dispatch", "retention"]);
    await service.stop();
  });

  it("does not run a first pass for a service stopped before it starts", async () => {
    const pass = vi.spyOn(RunnerEngine.prototype, "deleteFinishedBefore");
    const service = await startRunner({ directory, retainDays: 1, autoDispatch: false });
    await service.stop();
    await new Promise(resolve => setImmediate(resolve));
    expect(pass).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 36_501])("refuses retainDays %s before taking the store", async retainDays => {
    await expect(startRunner({ directory, retainDays })).rejects.toMatchObject({ body: { code: "invalid_input" } });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("serve --retain-days deletes expired runs at startup", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(s.id, "done"));
    engine!.cancel("done");
    abandon();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * 24 * 60 * 60 * 1000);
    const service = await startRunner({ directory, retainDays: 3, autoDispatch: false });
    expect(service.engine.snapshot().runs).toHaveLength(1);
    await service.stop();
    const later = await startRunner({ directory, retainDays: 1, autoDispatch: false });
    await new Promise(resolve => setImmediate(resolve));
    expect(later.engine.snapshot().runs).toEqual([]);
    await later.stop();
  });
});

describe("check", () => {
  it("rebuilds a live store from its events and finds the rows consistent", async () => {
    open();
    await history();
    const live = engine!.snapshot();
    expect(RunnerStorage.check(directory)).toEqual({
      cursor: live.cursor, expiredThrough: 0, events: live.cursor, sessions: live.sessions.length, runs: live.runs.length, differences: []
    });
  });

  it("finds history that startup's checks accept but the rows hide", async () => {
    open({ autoDispatch: false });
    const s = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(s.id, "done"));
    engine!.cancel("done");
    const { cursor } = engine!.snapshot();
    abandon();
    // A finished run reopened by hand: every row still points at its latest event, so startup accepts it.
    external(db => db.exec(`DROP TRIGGER runs_terminal_final;
      INSERT INTO events (sequence, type, subject, event_json) VALUES (${cursor + 1}, 'run_updated', 'done',
        json_object('type', 'run_updated', 'requestID', 'done', 'status', 'running', 'updatedAt', '${new Date().toISOString()}'));
      UPDATE runs SET last_sequence = ${cursor + 1}, status = 'running' WHERE request_id = 'done'`));
    open({ autoDispatch: false });
    abandon();
    expect(RunnerStorage.check(directory).differences).toEqual([{ problem: "update of a finished run", sequence: cursor + 1, requestID: "done" }]);
  });

  it("reports a missing store as not found, without creating it", () => {
    expect(() => RunnerStorage.check(directory)).toThrow(expect.objectContaining({
      body: expect.objectContaining({ code: "runner_storage_not_found", details: { directory } })
    }));
    expect(readdirSync(directory)).toEqual([]);
  });

  it("reports a file given as the directory as not found", () => {
    writeFileSync(path("notes.txt"), "not a directory");
    expect(() => RunnerStorage.check(path("notes.txt"))).toThrow(expect.objectContaining({
      body: expect.objectContaining({ code: "runner_storage_not_found", details: { directory: path("notes.txt") } })
    }));
  });

  it("reports a store it cannot reach as an open failure, not as missing", () => {
    // A dangling symlink: unlike file modes, root cannot get past it.
    symlinkSync(path("elsewhere.sqlite"), path("runner.sqlite"));
    expect(() => RunnerStorage.check(directory)).toThrow(expect.objectContaining({
      body: expect.objectContaining({ code: "runner_storage_failure", details: { cause: expect.objectContaining({ code: expect.stringMatching(/^SQLITE_CANTOPEN/) }) } })
    }));
    expect(existsSync(path("elsewhere.sqlite"))).toBe(false);
  });

  // Root ignores file modes, so this one cannot fail an open there.
  it.skipIf(process.getuid?.() === 0)("reports a directory it cannot search as an open failure, not as missing", () => {
    chmodSync(directory, 0o600);
    try {
      expect(() => RunnerStorage.check(directory)).toThrow(expect.objectContaining({
        body: expect.objectContaining({ code: "runner_storage_failure", details: { directory, cause: expect.objectContaining({ code: "EACCES" }) } })
      }));
    } finally { chmodSync(directory, 0o700); }
  });

  it.skipIf(process.getuid?.() === 0)("reports a database it cannot open as an open failure, not a refused store", () => {
    open();
    abandon();
    chmodSync(path("runner.sqlite"), 0);
    try {
      expect(() => RunnerStorage.check(directory)).toThrow(expect.objectContaining({
        body: expect.objectContaining({ code: "runner_storage_failure", details: { cause: expect.objectContaining({ code: expect.stringMatching(/^SQLITE_CANTOPEN/) }) } })
      }));
    } finally { chmodSync(path("runner.sqlite"), 0o600); }
  });
});
