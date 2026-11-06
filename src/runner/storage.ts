import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import { configDir } from "../config.js";
import { EnsoCliError } from "../errors.js";
import { activeStatuses, canonical, eventSchema, terminal, terminalStatuses, type Change, type Run, type RunnerEvent, type Session } from "./protocol.js";

export function runnerDirectory(): string { return join(configDir(), "runner", "v1"); }

export const databaseName = "runner.sqlite";
/** `PRAGMA application_id` ("Enso") marks the file as a runner store; `user_version` is its schema version. */
const applicationID = 0x456e736f;
const schemaVersion = 1;
/** Files of the pre-SQLite store. Their presence refuses startup: they are neither migrated nor modified. */
const legacy = (name: string) => name === "state.json" || name === "log.jsonl" || /^\.(state\.json|log\.jsonl)\..+\.tmp$/.test(name);
/**
 * The database's WAL files. Beside a missing or empty database they belong to a store that was moved or deleted, and
 * SQLite would discard its uncheckpointed commits. A `-journal` is not among them: this store writes one only while
 * initializing an empty file, and SQLite itself discards a journal beside an empty database without applying it.
 */
const walFiles = ["-wal", "-shm"].map(suffix => databaseName + suffix);
const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(", ");
const terminalSQL = sqlList(terminalStatuses);
const activeSQL = sqlList(activeStatuses);
const sessionEventsSQL = "'session_created', 'session_updated'";
const runEventsSQL = "'run_accepted', 'run_updated'";
const abort = (message: string) => `BEGIN SELECT RAISE(ABORT, '${message}'); END`;
const latestEvent = "(SELECT MAX(sequence) FROM events)";
/**
 * Events are the record and hold every payload, once. A session or run row is the index over its events: the event
 * that created it (`sequence`) and its latest event (`last_sequence`), plus the keys and status that constraints need.
 * Invariants live in the schema, so a bug or hand edit cannot commit a state the runner would refuse to load: a row
 * changes only in the transaction that appends its event, and only retention deletes anything.
 */
const schema = `
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (${sessionEventsSQL}, ${runEventsSQL}, 'runs_deleted')),
  subject TEXT,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  -- The session or run the event belongs to, exactly as the event names it; none for runs_deleted.
  CHECK (subject IS CASE type
    WHEN 'session_created' THEN json_extract(event_json, '$.session.id')
    WHEN 'session_updated' THEN json_extract(event_json, '$.sessionID')
    WHEN 'run_accepted' THEN json_extract(event_json, '$.run.request.requestID')
    WHEN 'run_updated' THEN json_extract(event_json, '$.requestID')
  END)
) STRICT;
CREATE INDEX events_subject ON events (subject, sequence);
CREATE TRIGGER events_gap_free BEFORE INSERT ON events
  WHEN NEW.sequence IS NOT (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events) ${abort("event sequence must be gap-free")};
CREATE TRIGGER events_no_update BEFORE UPDATE ON events ${abort("events are append-only")};

CREATE TABLE retention (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  expired_through INTEGER NOT NULL
) STRICT;
INSERT INTO retention VALUES (1, 0);
CREATE TRIGGER retention_single BEFORE INSERT ON retention ${abort("retention has one row")};
CREATE TRIGGER retention_no_delete BEFORE DELETE ON retention ${abort("retention has one row")};
CREATE TRIGGER retention_forward BEFORE UPDATE ON retention
  WHEN NEW.singleton IS NOT 1 OR NEW.expired_through < OLD.expired_through OR NEW.expired_through >= ${latestEvent}
    OR (SELECT type FROM events WHERE sequence = ${latestEvent}) IS NOT 'runs_deleted'
  ${abort("expired history only advances, below the runs_deleted event that announces it")};
-- A session_updated event replaces every mutable field, so one its session has superseded is not needed to fold the
-- history; its latest one is.
CREATE TRIGGER events_deleted_expired_only BEFORE DELETE ON events
  WHEN OLD.sequence > (SELECT expired_through FROM retention) OR CASE
    WHEN OLD.type IN (${runEventsSQL}) THEN EXISTS (SELECT 1 FROM runs WHERE request_id = OLD.subject)
    WHEN OLD.type = 'session_updated' THEN OLD.sequence >= (SELECT last_sequence FROM sessions WHERE id = OLD.subject)
    ELSE 1 END IS NOT 0
  ${abort("only expired events of deleted runs, and superseded session checkpoints, are deleted")};

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE REFERENCES events (sequence),
  last_sequence INTEGER NOT NULL REFERENCES events (sequence)
) STRICT;
CREATE TRIGGER sessions_created BEFORE INSERT ON sessions
  WHEN NEW.sequence IS NOT ${latestEvent} OR NEW.last_sequence IS NOT NEW.sequence
    OR NOT EXISTS (SELECT 1 FROM events WHERE sequence = NEW.sequence AND type = 'session_created' AND subject = NEW.id)
  ${abort("a session row is created only by its session_created event")};
CREATE TRIGGER sessions_updated BEFORE UPDATE ON sessions
  WHEN NEW.id IS NOT OLD.id OR NEW.sequence IS NOT OLD.sequence OR NEW.last_sequence IS NOT ${latestEvent}
    OR NOT EXISTS (SELECT 1 FROM events WHERE sequence = NEW.last_sequence AND type = 'session_updated' AND subject = NEW.id)
  ${abort("a session changes only by its latest session_updated event")};
CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions ${abort("sessions are retained")};
-- Deleting an event checks every reference to it; unindexed, each check would scan the table.
CREATE INDEX sessions_last_sequence ON sessions (last_sequence);

CREATE TABLE runs (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  sequence INTEGER NOT NULL UNIQUE REFERENCES events (sequence),
  last_sequence INTEGER NOT NULL REFERENCES events (sequence),
  status TEXT NOT NULL CHECK (status IN (${activeSQL}, ${terminalSQL}))
) STRICT;
CREATE UNIQUE INDEX runs_one_active_per_session ON runs (session_id) WHERE status IN (${activeSQL});
CREATE INDEX runs_last_sequence ON runs (last_sequence);
CREATE TRIGGER runs_accepted BEFORE INSERT ON runs
  WHEN NEW.sequence IS NOT ${latestEvent} OR NEW.last_sequence IS NOT NEW.sequence OR NEW.status IS NOT 'accepted'
    OR NOT EXISTS (SELECT 1 FROM events WHERE sequence = NEW.sequence AND type = 'run_accepted' AND subject = NEW.request_id
      AND json_extract(event_json, '$.run.request.sessionID') IS NEW.session_id AND json_extract(event_json, '$.run.status') IS 'accepted')
  ${abort("a run row is created only by its run_accepted event")};
CREATE TRIGGER runs_updated BEFORE UPDATE ON runs
  WHEN NEW.request_id IS NOT OLD.request_id OR NEW.session_id IS NOT OLD.session_id OR NEW.sequence IS NOT OLD.sequence
    OR NEW.last_sequence IS NOT ${latestEvent}
    OR NOT EXISTS (SELECT 1 FROM events WHERE sequence = NEW.last_sequence AND type = 'run_updated' AND subject = NEW.request_id
      AND json_extract(event_json, '$.status') IS NEW.status)
  ${abort("a run changes only by its latest run_updated event")};
CREATE TRIGGER runs_terminal_final BEFORE UPDATE ON runs
  WHEN OLD.status IN (${terminalSQL}) OR NEW.status = 'accepted' ${abort("terminal runs are final and accepted is only initial")};
CREATE TRIGGER runs_deleted BEFORE DELETE ON runs
  WHEN OLD.status NOT IN (${terminalSQL}) OR NOT EXISTS (
    SELECT 1 FROM events, json_each(events.event_json, '$.requestIDs') AS deleted
    WHERE events.sequence = ${latestEvent} AND events.type = 'runs_deleted' AND deleted.value = OLD.request_id)
  ${abort("only finished runs named by the latest runs_deleted event are deleted")};
`;
/** Each row against the events it indexes, and each event against its row. Any result is a mismatch. */
const linkage = `
SELECT 'session' FROM sessions s LEFT JOIN events f ON f.sequence = s.sequence
WHERE f.type IS NOT 'session_created' OR f.subject IS NOT s.id
  OR s.last_sequence IS NOT (SELECT MAX(sequence) FROM events WHERE subject = s.id AND type IN (${sessionEventsSQL}))
UNION ALL
SELECT 'run' FROM runs r LEFT JOIN events f ON f.sequence = r.sequence LEFT JOIN events l ON l.sequence = r.last_sequence
WHERE f.type IS NOT 'run_accepted' OR f.subject IS NOT r.request_id
  OR json_extract(f.event_json, '$.run.request.sessionID') IS NOT r.session_id
  OR r.last_sequence IS NOT (SELECT MAX(sequence) FROM events WHERE subject = r.request_id AND type IN (${runEventsSQL}))
  OR json_extract(l.event_json, CASE l.type WHEN 'run_accepted' THEN '$.run.status' ELSE '$.status' END) IS NOT r.status
UNION ALL
SELECT 'event' FROM events e
WHERE (e.type IN (${sessionEventsSQL}) AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.subject AND s.sequence <= e.sequence))
  OR (e.type IN (${runEventsSQL}) AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.request_id = e.subject AND r.sequence <= e.sequence))
UNION ALL
SELECT 'count' WHERE (SELECT COUNT(*) FROM events WHERE type = 'session_created') IS NOT (SELECT COUNT(*) FROM sessions)
  OR (SELECT COUNT(*) FROM events WHERE type = 'run_accepted') IS NOT (SELECT COUNT(*) FROM runs)
LIMIT 1`;
const linked = (row: string) => `${row}.sequence, f.type AS first_type, f.event_json AS first_json, ${row}.last_sequence, l.type AS last_type, l.event_json AS last_json`;
const sessionSelect = `SELECT s.id, ${linked("s")} FROM sessions s JOIN events f ON f.sequence = s.sequence JOIN events l ON l.sequence = s.last_sequence`;
const runSelect = `SELECT r.request_id, r.session_id, r.status, ${linked("r")} FROM runs r JOIN events f ON f.sequence = r.sequence JOIN events l ON l.sequence = r.last_sequence`;

type Database = BetterSqlite3.Database;
type LinkedRow = { sequence: number; first_type: string; first_json: string; last_sequence: number; last_type: string; last_json: string };
type SessionRow = LinkedRow & { id: string };
type RunRow = LinkedRow & { request_id: string; session_id: string; status: string };
type EventRow = { sequence: number; type: string; event_json: string };
type Event<T extends RunnerEvent["type"]> = Extract<RunnerEvent, { type: T }>;
export type StoredSnapshot = { sessions: Session[]; runs: Run[]; cursor: number };
/** Something the event history and the rows disagree on, found by `RunnerStorage.check`. */
export type Difference = { problem: string; sequence?: number; sessionID?: string; requestID?: string };
export type StoreCheck = { cursor: number; expiredThrough: number; events: number; sessions: number; runs: number; differences: Difference[] };

/** The deltas of docs/runner-protocol.md: an update replaces every mutable field, and an absent one is cleared. */
function updatedSession(session: Session, event: Event<"session_updated">): Session {
  const { providerState: _, ...rest } = session;
  return event.providerState === undefined ? rest : { ...rest, providerState: event.providerState };
}
/** The session or run an event belongs to; the schema checks it against the event itself. */
function subject(event: RunnerEvent): string | null {
  if (event.type === "session_created") return event.session.id;
  if (event.type === "session_updated") return event.sessionID;
  if (event.type === "run_accepted") return event.run.request.requestID;
  if (event.type === "run_updated") return event.requestID;
  return null;
}
function updatedRun(run: Run, event: Event<"run_updated">): Run {
  const { sequence: _, type: __, requestID: ___, ...fields } = event;
  return { request: run.request, createdAt: run.createdAt, ...fields };
}

/** Loaded lazily, and probed, so other CLI commands never depend on the native module and a missing binding is
 * reported before any runner file is created. */
function sqlite(): typeof BetterSqlite3 {
  try {
    const Sqlite: typeof BetterSqlite3 = createRequire(import.meta.url)("better-sqlite3");
    new Sqlite(":memory:").close();
    return Sqlite;
  } catch { throw unavailable(); }
}
function invalid(message: string, details?: Record<string, unknown>): EnsoCliError {
  return new EnsoCliError("invalid_runner_storage", message, details);
}
/** Startup, unlike the read-only `check`, says what it does about a store it judged invalid. Amends the error in place
 * so it keeps the stack of the check that failed. */
function refused(error: unknown): unknown {
  if (error instanceof EnsoCliError && error.body.code === "invalid_runner_storage") {
    error.message = error.body.message = `${error.body.message}; refusing to dispatch or overwrite it`;
  }
  return error;
}
/** Keeps the SQLite or filesystem cause, and reports a lock or I/O failure as such rather than as a refused store. */
function failure(error: unknown, message: string): EnsoCliError {
  if (error instanceof EnsoCliError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return invalid(message);
  const cause = { cause: { code, message: (error as Error).message } };
  if (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_")) return new EnsoCliError("runner_locked", "Runner database is locked by another process", cause);
  if (code === "SQLITE_FULL" || code.startsWith("SQLITE_IOERR")) {
    return new EnsoCliError("runner_storage_failure", "Runner database could not be read or written", cause);
  }
  // Missing, or not readable by this user: nothing was judged, so nothing is refused.
  if (code.startsWith("SQLITE_CANTOPEN")) return new EnsoCliError("runner_storage_failure", "Runner database could not be opened", cause);
  return invalid(message, cause);
}
/**
 * Statements compiled once per connection and reused. Keyed by connection because startup judges the file through a
 * read-only connection before opening the writer, and a statement belongs to the connection that prepared it.
 */
const statements = new WeakMap<Database, Map<string, BetterSqlite3.Statement>>();
function prepare(db: Database, sql: string): BetterSqlite3.Statement {
  let cache = statements.get(db);
  if (!cache) statements.set(db, cache = new Map());
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, statement = db.prepare(sql));
  return statement;
}
function openDatabase(Sqlite: typeof BetterSqlite3, path: string, options: BetterSqlite3.Options): Database {
  try { return new Sqlite(path, options); }
  catch (error) { throw failure(error, "Unreadable runner database"); }
}
function unavailable(): EnsoCliError {
  return new EnsoCliError("runner_storage_unavailable", "The runner needs the better-sqlite3 native module. npm 12 skips its install script by default: reinstall with `npm install -g @enso-app/cli --allow-scripts=better-sqlite3` (Node versions without a prebuilt binary, such as 20, also need a C++ toolchain to build it)");
}

/**
 * Runner-owned SQLite store. Ownership (`owner`, `acquiring/`) is separate from, and taken before, the database:
 * SQLite locking only serializes statements. Every commit is one IMMEDIATE transaction holding its events and the
 * resulting session/run rows; WAL with synchronous=FULL and fullfsync flushes the drive cache (F_FULLFSYNC on macOS)
 * before the commit returns.
 */
export class RunnerStorage {
  readonly directory: string;
  private locked = false;
  private db?: Database;
  /** Set once startup creates the database file, after which a failure is not a refusal of an existing store. */
  private created = false;
  constructor(directory = runnerDirectory()) { this.directory = resolve(directory); }

  /** Takes service ownership, then opens (or creates) the database. Throws, without ownership, if either fails. */
  acquire(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
      throw new EnsoCliError("unsafe_storage", "Runner storage must be a directory owned by the current user");
    }
    chmodSync(this.directory, 0o700);
    // Serialize lock reclamation as well as acquisition. Never steal from a live PID.
    // An orphaned acquisition guard fails closed (see runner protocol recovery docs).
    const guard = join(this.directory, "acquiring");
    try { mkdirSync(guard, { mode: 0o700 }); }
    catch { throw new EnsoCliError("runner_locked", "Runner startup is already in progress, or its acquisition guard needs recovery"); }
    try {
      const lock = join(this.directory, "owner");
      let owner: string | undefined;
      try { owner = readlinkSync(lock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new EnsoCliError("runner_locked", "Unreadable runner owner record; refusing recovery");
        }
      }
      if (owner !== undefined) {
        const pid = Number(owner);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new EnsoCliError("runner_locked", "Invalid runner owner record; refusing recovery");
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw new EnsoCliError("runner_locked", "A runner already owns this storage");
        unlinkSync(lock);
      }
      symlinkSync(String(process.pid), lock);
      this.locked = true;
    } finally { rmSync(guard, { recursive: true }); }
    try { this.open(); }
    catch (error) { this.release(); throw this.created ? error : refused(error); }
  }

  /**
   * Validates the store as startup does, then rebuilds every session and run from the event history alone and
   * compares them with what the rows read. Read-only, so it can run beside a live runner; one read transaction.
   *
   * Known limitation: `verify` runs first and throws on the first row that does not match its events (`linkage`), so
   * most row/event mismatches surface as one bare "Runner rows do not match their events" with no session or run
   * named, and never reach `differences`. Only history the rows hide (an update to a finished run, a deletion of an
   * unfinished one) is listed. The schema's triggers keep such mismatches from committing, so this matters only for
   * repairing a store damaged by hand or by the disk. Listing them would need `linkage` to return every mismatch with
   * its ID, and `rebuild` to record an unreadable row instead of throwing.
   */
  static check(directory = runnerDirectory()): StoreCheck {
    const storage = new RunnerStorage(directory);
    const path = join(storage.directory, databaseName);
    // Only a missing entry, or a file where the directory should be, means no store: a directory this user cannot
    // search is a store that could not be opened, and a dangling symlink is left for SQLite to report the same way.
    try { lstatSync(path); }
    catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new EnsoCliError("runner_storage_not_found", `No runner store in ${storage.directory}; \`enso runner serve\` creates one`, { directory: storage.directory });
      }
      throw new EnsoCliError("runner_storage_failure", "Runner database could not be opened", { directory: storage.directory, cause: { code, message } });
    }
    const db = storage.db = openDatabase(sqlite(), path, { readonly: true, fileMustExist: true });
    try { return db.transaction(() => { storage.verify(); return storage.rebuild(); })(); }
    finally { storage.release(); }
  }

  private open(): void {
    this.created = false;
    const names = readdirSync(this.directory);
    const found = names.filter(legacy);
    if (found.length) {
      throw invalid("Found a pre-SQLite runner store, which this runner does not migrate. Keep it with a runner build that reads it, or move it out of this directory to start empty", { legacyFiles: found.sort() });
    }
    const path = join(this.directory, databaseName);
    // An empty file is given its first page before WAL mode creates any WAL file, so WAL files beside a missing or
    // empty file are another store's.
    const orphans = names.filter(name => walFiles.includes(name));
    if (orphans.length && (!names.includes(databaseName) || lstatSync(path).size === 0)) {
      throw invalid(`Found SQLite journal files without their ${databaseName}. Move them back beside the store they belong to, or delete them to start empty`, { journalFiles: orphans.sort() });
    }
    const Sqlite = sqlite();
    let identity: "empty" | "store" = "empty";
    try {
      // Created private, with a durable directory entry: SQLite gives -wal/-shm this mode but syncs the directory only for those.
      closeSync(openSync(path, "wx", 0o600));
      this.created = true;
      this.syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Judge an existing file read-only: closing a read-write connection folds its WAL into it, even one being refused.
      const reader = this.db = openDatabase(Sqlite, path, { readonly: true, fileMustExist: true });
      try {
        identity = this.identify(reader);
        if (identity === "store") this.verify();
      } finally { reader.close(); this.db = undefined; }
    }
    const db = this.db = openDatabase(Sqlite, path, { fileMustExist: true, timeout: 1000 });
    try {
      // Ownership excludes other writers, so this is the file just judged.
      if (this.identify(db) !== identity) throw new Error("Runner database changed during startup");
      // Lets retention return freed pages to the file system. It must precede the first table, and WAL mode, which
      // writes the header; an empty file whose header was written by a crash takes it through VACUUM instead.
      if (identity === "empty") {
        db.pragma("auto_vacuum = INCREMENTAL");
        if (db.pragma("auto_vacuum", { simple: true }) !== 2) db.exec("VACUUM");
      }
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL"); // WAL commits sync the log (NORMAL defers to checkpoints and can lose commits).
      db.pragma("fullfsync = ON"); // macOS: F_FULLFSYNC flushes the drive's volatile cache; plain fsync does not.
      db.pragma("checkpoint_fullfsync = ON");
      db.pragma("foreign_keys = ON");
      db.pragma("journal_size_limit = 8388608");
      const actual = {
        journal_mode: db.pragma("journal_mode", { simple: true }), synchronous: db.pragma("synchronous", { simple: true }),
        fullfsync: db.pragma("fullfsync", { simple: true }), checkpoint_fullfsync: db.pragma("checkpoint_fullfsync", { simple: true }),
        foreign_keys: db.pragma("foreign_keys", { simple: true }), auto_vacuum: db.pragma("auto_vacuum", { simple: true })
      };
      const wanted = { journal_mode: "wal", synchronous: 2, fullfsync: 1, checkpoint_fullfsync: 1, foreign_keys: 1, auto_vacuum: 2 };
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        throw new EnsoCliError("unsafe_storage", "SQLite did not apply the runner's durability and space settings", { actual, wanted });
      }
      if (identity === "empty") {
        db.transaction(() => {
          db.exec(schema);
          db.pragma(`application_id = ${applicationID}`);
          db.pragma(`user_version = ${schemaVersion}`);
        }).immediate();
        this.verify();
      }
    } catch (error) {
      db.close();
      this.db = undefined;
      throw failure(error, "Runner database could not be initialized");
    }
  }

  private identify(db: Database): "empty" | "store" {
    let application: unknown, version: unknown, objects: unknown;
    try {
      application = db.pragma("application_id", { simple: true });
      version = db.pragma("user_version", { simple: true });
      objects = prepare(db, "SELECT COUNT(*) FROM sqlite_schema").pluck().get();
    } catch (error) { throw failure(error, "Unreadable runner database"); }
    // A file created just before a crash is still empty; anything else must already identify as this store.
    if (application === 0 && version === 0 && objects === 0) return "empty";
    if (application !== applicationID) throw invalid(`${databaseName} is not an Enso runner database`);
    if (version !== schemaVersion) throw invalid(`Unsupported runner storage version ${JSON.stringify(version)}; this runner reads only version ${schemaVersion} and never migrates`);
    return "store";
  }

  /** Validates the whole store before anything is served or dispatched. */
  private verify(): void {
    const db = this.database();
    const check = <T>(statement: () => T, message: string): T => {
      try { return statement(); }
      catch (error) { throw failure(error, message); }
    };
    check(() => { if (this.identify(db) !== "store") throw new Error(); }, `${databaseName} has no runner schema`);
    check(() => { if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error(); }, "Damaged runner database");
    check(() => {
      // Retention deletes only at or below the expired cursor, so the history above it has no gaps.
      const expired = this.expiredThrough(), cursor = this.cursor();
      const above = prepare(db, "SELECT COUNT(*) FROM events WHERE sequence > ?").pluck().get(expired);
      if (expired > cursor || above !== cursor - expired) throw new Error();
    }, "Runner event sequence gap");
    check(() => { if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error(); }, "Runner record references a missing event or session");
    check(() => { for (const row of prepare(db, "SELECT sequence, type, event_json FROM events").iterate()) this.event(row as EventRow); }, "Damaged runner event");
    // Names no row, and stops `check` before it can list differences: see the limitation noted on `check`.
    check(() => { if (prepare(db, linkage).get() !== undefined) throw new Error(); }, "Runner rows do not match their events");
    check(() => this.sessions(), "Damaged runner session");
    check(() => this.runs(), "Damaged runner run");
  }

  /** Folds the whole event history, as a client applies it, and lists where it disagrees with the rows. */
  private rebuild(): StoreCheck {
    const db = this.database();
    const sessions = new Map<string, Session>(), runs = new Map<string, Run>();
    const differences: Difference[] = [];
    let events = 0;
    for (const row of prepare(db, "SELECT sequence, type, event_json FROM events ORDER BY sequence").iterate()) {
      const event = this.event(row as EventRow);
      const { sequence } = event;
      events++;
      if (event.type === "session_created") {
        if (sessions.has(event.session.id)) differences.push({ problem: "session created twice", sequence, sessionID: event.session.id });
        sessions.set(event.session.id, event.session);
      } else if (event.type === "session_updated") {
        const session = sessions.get(event.sessionID);
        if (session) sessions.set(event.sessionID, updatedSession(session, event));
        else differences.push({ problem: "update of an unknown session", sequence, sessionID: event.sessionID });
      } else if (event.type === "run_accepted") {
        const { requestID, sessionID } = event.run.request;
        if (runs.has(requestID)) differences.push({ problem: "run accepted twice", sequence, requestID });
        if (!sessions.has(sessionID)) differences.push({ problem: "run accepted for an unknown session", sequence, requestID, sessionID });
        runs.set(requestID, event.run);
      } else if (event.type === "run_updated") {
        const run = runs.get(event.requestID);
        if (!run) differences.push({ problem: "update of an unknown run", sequence, requestID: event.requestID });
        else {
          if (terminal(run.status)) differences.push({ problem: "update of a finished run", sequence, requestID: event.requestID });
          runs.set(event.requestID, updatedRun(run, event));
        }
      } else {
        // Retention deleted these runs' events with them, so a run absent here is expected.
        for (const requestID of event.requestIDs) {
          const run = runs.get(requestID);
          if (run && !terminal(run.status)) differences.push({ problem: "deletion of an unfinished run", sequence, requestID });
          runs.delete(requestID);
        }
      }
    }
    const stored = this.snapshot();
    const compare = <T>(kind: "session" | "run", rebuilt: Map<string, T>, rows: T[], key: (value: T) => string, id: (key: string) => Omit<Difference, "problem">) => {
      const read = new Map(rows.map(value => [key(value), value]));
      for (const [name, value] of rebuilt) {
        const row = read.get(name);
        if (row === undefined) differences.push({ problem: `${kind} missing from the rows`, ...id(name) });
        else if (canonical(row) !== canonical(value)) differences.push({ problem: `${kind} rows differ from the event history`, ...id(name) });
      }
      for (const name of read.keys()) if (!rebuilt.has(name)) differences.push({ problem: `${kind} row without events`, ...id(name) });
    };
    compare("session", sessions, stored.sessions, session => session.id, sessionID => ({ sessionID }));
    compare("run", runs, stored.runs, run => run.request.requestID, requestID => ({ requestID }));
    return { cursor: stored.cursor, expiredThrough: this.expiredThrough(), events, sessions: sessions.size, runs: runs.size, differences };
  }

  /** Commits every change as one transaction of consecutive events; nothing persists if it throws. */
  commit(changes: Change[]): void {
    const db = this.database();
    if (!this.locked) throw new Error("Storage is not owned");
    db.transaction(() => {
      let sequence = prepare(db, "SELECT COALESCE(MAX(sequence), 0) FROM events").pluck().get() as number;
      for (const change of changes) {
        const event = { sequence: ++sequence, ...change } as RunnerEvent;
        prepare(db, "INSERT INTO events (sequence, type, subject, event_json) VALUES (?, ?, ?, ?)").run(event.sequence, change.type, subject(event), JSON.stringify(change));
        this.apply(db, event);
      }
    }).immediate();
  }

  /**
   * Releases up to `pages` free pages to the file system if at least `minimum` are free, and returns how many it
   * released. Throws what SQLite throws: the caller fails closed, as on any other durable write.
   */
  reclaim(pages: number, minimum = 1): number {
    if (!this.locked) throw new Error("Storage is not owned");
    if (![pages, minimum].every(count => Number.isSafeInteger(count) && count > 0)) throw new Error("Reclaim needs positive page counts");
    const db = this.database();
    const free = () => db.pragma("freelist_count", { simple: true }) as number;
    const before = free();
    // Most passes free little or nothing: skip the write transaction and its full fsync.
    if (before < minimum) return 0;
    db.pragma(`incremental_vacuum(${pages})`);
    // Measured around this step alone, so pages that commits free between steps neither end a pass nor count here.
    return before - free();
  }

  private apply(db: Database, event: RunnerEvent): void {
    let changed: number, expected = 1;
    if (event.type === "session_created") {
      changed = prepare(db, "INSERT INTO sessions (id, sequence, last_sequence) VALUES (?, ?, ?)").run(event.session.id, event.sequence, event.sequence).changes;
    } else if (event.type === "session_updated") {
      changed = prepare(db, "UPDATE sessions SET last_sequence = ? WHERE id = ?").run(event.sequence, event.sessionID).changes;
    } else if (event.type === "run_accepted") {
      const { request, status } = event.run;
      if (status !== "accepted") throw new Error("Runs are accepted before anything else");
      changed = prepare(db, "INSERT INTO runs (request_id, session_id, sequence, last_sequence, status) VALUES (?, ?, ?, ?, ?)")
        .run(request.requestID, request.sessionID, event.sequence, event.sequence, status).changes;
    } else if (event.type === "run_updated") {
      changed = prepare(db, "UPDATE runs SET last_sequence = ?, status = ? WHERE request_id = ?").run(event.sequence, event.status, event.requestID).changes;
    } else {
      // Clients holding a cursor below a deleted event can no longer replay to the current state, so expire them.
      const ids = JSON.stringify(event.requestIDs);
      const owned = `type IN (${runEventsSQL}) AND subject IN (SELECT value FROM json_each(?))`;
      const through = prepare(db, `SELECT MAX(sequence) FROM events WHERE ${owned}`).pluck().get(ids) as number | null;
      if (through === null) throw new Error("Runner runs_deleted names no stored run");
      prepare(db, "UPDATE retention SET expired_through = MAX(expired_through, ?)").run(through);
      expected = event.requestIDs.length;
      changed = prepare(db, "DELETE FROM runs WHERE request_id IN (SELECT value FROM json_each(?))").run(ids).changes;
      prepare(db, `DELETE FROM events WHERE ${owned}`).run(ids);
      // Session checkpoints superseded below the expired cursor, which only expired cursors could still need.
      prepare(db, `DELETE FROM events WHERE sequence IN (SELECT e.sequence FROM sessions s JOIN events e ON e.subject = s.id
        AND e.sequence < s.last_sequence WHERE e.type = 'session_updated' AND e.sequence <= (SELECT expired_through FROM retention))`).run();
    }
    if (changed !== expected) throw new Error(`Runner ${event.type} matched no record`);
  }

  session(id: string): Session | undefined {
    const row = prepare(this.database(), `${sessionSelect} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row && this.toSession(row);
  }
  run(id: string): Run | undefined {
    const row = prepare(this.database(), `${runSelect} WHERE r.request_id = ?`).get(id) as RunRow | undefined;
    return row && this.toRun(row);
  }
  /** Whether the session has its (single) non-terminal run. */
  busy(sessionID: string): boolean {
    return prepare(this.database(), `SELECT 1 FROM runs WHERE session_id = ? AND status IN (${activeSQL})`).get(sessionID) !== undefined;
  }
  /** Non-terminal runs in acceptance order; at most one per session. */
  unfinished(): Run[] { return this.runs(`WHERE r.status IN (${activeSQL})`); }
  /** Finished runs whose last update is before `cutoff` (an ISO timestamp), oldest acceptance first. */
  finishedBefore(cutoff: string, limit: number): string[] {
    return prepare(this.database(), `SELECT r.request_id FROM runs r JOIN events l ON l.sequence = r.last_sequence
      WHERE r.status IN (${terminalSQL}) AND json_extract(l.event_json, '$.updatedAt') < ? ORDER BY r.sequence LIMIT ?`).pluck().all(cutoff, limit) as string[];
  }
  /** Events at or below this sequence may have been deleted: a cursor below it cannot be replayed. */
  expiredThrough(): number { return prepare(this.database(), "SELECT expired_through FROM retention").pluck().get() as number; }
  /** One committed state and the sequence of its last event: the transaction holds one WAL read view across the
   * three reads. */
  snapshot(): StoredSnapshot {
    const db = this.database();
    return db.transaction(() => ({ sessions: this.sessions(), runs: this.runs(), cursor: this.cursor() }))();
  }
  cursor(): number { return prepare(this.database(), "SELECT COALESCE(MAX(sequence), 0) FROM events").pluck().get() as number; }
  /** Events after `after` in order, stopping once `maxBytes` of event data is exceeded (always at least one). */
  events(after: number, maxBytes: number): RunnerEvent[] {
    const events: RunnerEvent[] = [];
    let bytes = 0;
    for (const row of prepare(this.database(), "SELECT sequence, type, event_json FROM events WHERE sequence > ? ORDER BY sequence").iterate(after)) {
      const size = Buffer.byteLength((row as EventRow).event_json);
      if (events.length && bytes + size > maxBytes) break;
      bytes += size;
      events.push(this.event(row as EventRow));
    }
    return events;
  }

  private sessions(): Session[] {
    return (prepare(this.database(), `${sessionSelect} ORDER BY s.sequence`).all() as SessionRow[]).map(row => this.toSession(row));
  }
  private runs(where = ""): Run[] {
    return (prepare(this.database(), `${runSelect} ${where} ORDER BY r.sequence`).all() as RunRow[]).map(row => this.toRun(row));
  }
  /** A row reads as its first event with its latest event applied. */
  private linked(row: LinkedRow): [RunnerEvent, RunnerEvent | undefined] {
    const first = this.event({ sequence: row.sequence, type: row.first_type, event_json: row.first_json });
    return [first, row.last_sequence === row.sequence ? undefined : this.event({ sequence: row.last_sequence, type: row.last_type, event_json: row.last_json })];
  }
  private toSession(row: SessionRow): Session {
    const [created, latest] = this.linked(row);
    if (created.type !== "session_created" || created.session.id !== row.id) throw new Error("Session does not match its session_created event");
    if (!latest) return created.session;
    if (latest.type !== "session_updated" || latest.sessionID !== row.id) throw new Error("Session does not match its latest event");
    return updatedSession(created.session, latest);
  }
  private toRun(row: RunRow): Run {
    const [accepted, latest] = this.linked(row);
    if (accepted.type !== "run_accepted" || accepted.run.request.requestID !== row.request_id || accepted.run.request.sessionID !== row.session_id) {
      throw new Error("Run does not match its run_accepted event");
    }
    if (latest && (latest.type !== "run_updated" || latest.requestID !== row.request_id)) throw new Error("Run does not match its latest event");
    const run = latest ? updatedRun(accepted.run, latest) : accepted.run;
    if (run.status !== row.status) throw new Error("Run status does not match its latest event");
    return run;
  }
  private event(row: EventRow): RunnerEvent {
    const event = eventSchema.parse({ ...JSON.parse(row.event_json), sequence: row.sequence });
    if (event.type !== row.type) throw new Error("Event type mismatch");
    return event;
  }
  private database(): Database {
    if (!this.db) throw new Error("Runner storage is not open");
    return this.db;
  }

  /** Atomic private file replacement: temporary file, fsync, rename, directory fsync. */
  write(name: string, value: unknown): void {
    if (!this.locked) throw new Error("Storage is not owned");
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, join(this.directory, name));
      this.syncDirectory();
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  /** Closes the database, then gives up ownership. Also closes a checking reader. */
  release(): void {
    if (this.db?.open) this.db.close();
    this.db = undefined;
    if (!this.locked) return;
    unlinkSync(join(this.directory, "owner"));
    this.locked = false;
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
