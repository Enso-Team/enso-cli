import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import { configDir } from "../config.js";
import { EnsoCliError } from "../errors.js";
import { eventSchema, runSchema, sessionSchema, type Change, type Run, type RunnerEvent, type Session } from "./protocol.js";

export function runnerDirectory(): string { return join(configDir(), "runner", "v1"); }

export const databaseName = "runner.sqlite";
/** `PRAGMA application_id` ("Enso") marks the file as a runner store; `user_version` is its schema version. */
const applicationID = 0x456e736f;
const schemaVersion = 1;
/** Files of the pre-SQLite store. Their presence refuses startup: they are neither migrated nor modified. */
const legacy = (name: string) => name === "state.json" || name === "log.jsonl" || /^\.(state\.json|log\.jsonl)\..+\.tmp$/.test(name);
const terminalSQL = "'completed', 'failed', 'cancelled', 'interrupted'";
const activeSQL = "'accepted', 'running', 'waiting_permission', 'waiting_input', 'stopping'";
const abort = (message: string) => `BEGIN SELECT RAISE(ABORT, '${message}'); END`;
/** Invariants live in the schema, so a bug or hand edit cannot commit a state the runner would refuse to load. */
const schema = `
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('session_created', 'session_updated', 'run_accepted', 'run_updated')),
  event_json TEXT NOT NULL
) STRICT;
CREATE TRIGGER events_gap_free BEFORE INSERT ON events
  WHEN NEW.sequence IS NOT (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events) ${abort("event sequence must be gap-free")};
CREATE TRIGGER events_no_update BEFORE UPDATE ON events ${abort("events are append-only")};
CREATE TRIGGER events_no_delete BEFORE DELETE ON events ${abort("events are append-only")};

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  provider_state_json TEXT
) STRICT;
CREATE TRIGGER sessions_binding_immutable BEFORE UPDATE OF id, sequence, provider, binding_json, created_at ON sessions
  ${abort("session identity and binding are immutable")};
CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions ${abort("sessions are retained")};

CREATE TABLE runs (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  sequence INTEGER NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${activeSQL}, ${terminalSQL})),
  updated_at TEXT NOT NULL,
  pending_json TEXT,
  result_json TEXT,
  error_json TEXT,
  provider_state_json TEXT
) STRICT;
CREATE UNIQUE INDEX runs_one_active_per_session ON runs (session_id) WHERE status IN (${activeSQL});
CREATE TRIGGER runs_request_immutable BEFORE UPDATE OF request_id, session_id, sequence, request_json, created_at ON runs
  ${abort("run requests and captured context are immutable")};
CREATE TRIGGER runs_terminal_final BEFORE UPDATE ON runs
  WHEN OLD.status IN (${terminalSQL}) OR NEW.status = 'accepted' ${abort("terminal runs are final and accepted is only initial")};
CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs ${abort("runs are retained")};
`;

type Database = BetterSqlite3.Database;
type SessionRow = { id: string; provider: string; binding_json: string; created_at: string; provider_state_json: string | null };
type RunRow = {
  request_id: string; session_id: string; request_json: string; created_at: string; status: string; updated_at: string;
  pending_json: string | null; result_json: string | null; error_json: string | null; provider_state_json: string | null;
};
type EventRow = { sequence: number; type: string; event_json: string };
export type StoredSnapshot = { sessions: Session[]; runs: Run[]; cursor: number };

const json = (value: unknown) => value === undefined ? null : JSON.stringify(value);
const optional = (key: string, text: string | null) => text === null ? {} : { [key]: JSON.parse(text) };

/** Loaded lazily, and probed, so other CLI commands never depend on the native module and a missing binding is
 * reported before any runner file is created. */
function sqlite(): typeof BetterSqlite3 {
  try {
    const Sqlite: typeof BetterSqlite3 = createRequire(import.meta.url)("better-sqlite3");
    new Sqlite(":memory:").close();
    return Sqlite;
  } catch { throw unavailable(); }
}
function openDatabase(Sqlite: typeof BetterSqlite3, path: string, options: BetterSqlite3.Options): Database {
  try { return new Sqlite(path, options); }
  catch { throw new EnsoCliError("invalid_runner_storage", "Unreadable runner database; refusing to dispatch or overwrite it"); }
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
    catch (error) { this.release(); throw error; }
  }

  /** Reads a store without ownership or modification (beyond SQLite's -wal/-shm files), e.g. to inspect a live runner. */
  static inspect(directory = runnerDirectory()): RunnerStorage {
    const storage = new RunnerStorage(directory);
    storage.db = openDatabase(sqlite(), join(storage.directory, databaseName), { readonly: true, fileMustExist: true });
    try { storage.verify(); } catch (error) { storage.release(); throw error; }
    return storage;
  }

  private open(): void {
    const fail = (message: string, details?: Record<string, unknown>): never => {
      throw new EnsoCliError("invalid_runner_storage", `${message}; refusing to dispatch or overwrite it`, details);
    };
    const found = readdirSync(this.directory).filter(legacy);
    if (found.length) {
      fail("Found a pre-SQLite runner store, which this runner does not migrate. Keep it with a runner build that reads it, or move it out of this directory to start empty", { legacyFiles: found.sort() });
    }
    const Sqlite = sqlite();
    const path = join(this.directory, databaseName);
    let identity: "empty" | "store" = "empty";
    try {
      // Created private, with a durable directory entry: SQLite gives -wal/-shm this mode but syncs the directory only for those.
      closeSync(openSync(path, "wx", 0o600));
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
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL"); // WAL commits sync the log (NORMAL defers to checkpoints and can lose commits).
      db.pragma("fullfsync = ON"); // macOS: F_FULLFSYNC flushes the drive's volatile cache; plain fsync does not.
      db.pragma("checkpoint_fullfsync = ON");
      db.pragma("foreign_keys = ON");
      db.pragma("journal_size_limit = 8388608");
      const actual = {
        journal_mode: db.pragma("journal_mode", { simple: true }), synchronous: db.pragma("synchronous", { simple: true }),
        fullfsync: db.pragma("fullfsync", { simple: true }), checkpoint_fullfsync: db.pragma("checkpoint_fullfsync", { simple: true }),
        foreign_keys: db.pragma("foreign_keys", { simple: true })
      };
      const wanted = { journal_mode: "wal", synchronous: 2, fullfsync: 1, checkpoint_fullfsync: 1, foreign_keys: 1 };
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        throw new EnsoCliError("unsafe_storage", "SQLite did not apply the runner's durability settings", { actual, wanted });
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
      if (error instanceof EnsoCliError) throw error;
      fail("Runner database could not be initialized");
    }
  }

  private identify(db: Database): "empty" | "store" {
    const fail = (message: string): never => { throw new EnsoCliError("invalid_runner_storage", `${message}; refusing to dispatch or overwrite it`); };
    let application: unknown, version: unknown, objects: unknown;
    try {
      application = db.pragma("application_id", { simple: true });
      version = db.pragma("user_version", { simple: true });
      objects = db.prepare("SELECT COUNT(*) FROM sqlite_schema").pluck().get();
    } catch { return fail("Unreadable runner database"); }
    // A file created just before a crash is still empty; anything else must already identify as this store.
    if (application === 0 && version === 0 && objects === 0) return "empty";
    if (application !== applicationID) return fail(`${databaseName} is not an Enso runner database`);
    if (version !== schemaVersion) return fail(`Unsupported runner storage version ${JSON.stringify(version)}; this runner reads only version ${schemaVersion} and never migrates`);
    return "store";
  }

  /** Validates the whole store before anything is served or dispatched. */
  private verify(): void {
    const db = this.database();
    const check = <T>(statement: () => T, message: string): T => {
      try { return statement(); }
      catch (error) {
        if (error instanceof EnsoCliError) throw error;
        throw new EnsoCliError("invalid_runner_storage", `${message}; refusing to dispatch or overwrite it`);
      }
    };
    check(() => { if (this.identify(db) !== "store") throw new Error(); }, `${databaseName} has no runner schema`);
    check(() => { if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error(); }, "Damaged runner database");
    check(() => { if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error(); }, "Runner run references a missing session");
    check(() => { if (db.prepare("SELECT COUNT(*) FROM events").pluck().get() !== this.cursor()) throw new Error(); }, "Runner event sequence gap");
    check(() => { for (const row of db.prepare("SELECT * FROM events").iterate()) this.event(row as EventRow); }, "Damaged runner event");
    check(() => this.sessions(), "Damaged runner session");
    check(() => this.runs(), "Damaged runner run");
  }

  /** Commits every change as one transaction of consecutive events and returns them; nothing persists if it throws. */
  commit(changes: Change[]): RunnerEvent[] {
    const db = this.database();
    if (!this.locked) throw new Error("Storage is not owned");
    return db.transaction(() => {
      let sequence = db.prepare("SELECT COALESCE(MAX(sequence), 0) FROM events").pluck().get() as number;
      return changes.map(change => {
        const event = { sequence: ++sequence, ...change } as RunnerEvent;
        db.prepare("INSERT INTO events (sequence, type, event_json) VALUES (?, ?, ?)").run(event.sequence, change.type, JSON.stringify(change));
        this.apply(db, event);
        return event;
      });
    }).immediate();
  }

  private apply(db: Database, event: RunnerEvent): void {
    let changed: number;
    if (event.type === "session_created") {
      const { id, provider, binding, createdAt, providerState } = event.session;
      changed = db.prepare("INSERT INTO sessions (id, sequence, provider, binding_json, created_at, provider_state_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, event.sequence, provider, JSON.stringify(binding), createdAt, json(providerState)).changes;
    } else if (event.type === "session_updated") {
      changed = db.prepare("UPDATE sessions SET provider_state_json = ? WHERE id = ?").run(json(event.providerState), event.sessionID).changes;
    } else if (event.type === "run_accepted") {
      const { request, status, createdAt, updatedAt } = event.run;
      if (status !== "accepted") throw new Error("Runs are accepted before anything else");
      changed = db.prepare("INSERT INTO runs (request_id, session_id, sequence, request_json, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(request.requestID, request.sessionID, event.sequence, JSON.stringify(request), createdAt, status, updatedAt).changes;
    } else {
      // Every mutable field is replaced; an absent one is cleared.
      changed = db.prepare("UPDATE runs SET status = ?, updated_at = ?, pending_json = ?, result_json = ?, error_json = ?, provider_state_json = ? WHERE request_id = ?")
        .run(event.status, event.updatedAt, json(event.pending), json(event.result), json(event.error), json(event.providerState), event.requestID).changes;
    }
    if (changed !== 1) throw new Error(`Runner ${event.type} matched no record`);
  }

  session(id: string): Session | undefined {
    const row = this.database().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row && this.toSession(row);
  }
  run(id: string): Run | undefined {
    const row = this.database().prepare("SELECT * FROM runs WHERE request_id = ?").get(id) as RunRow | undefined;
    return row && this.toRun(row);
  }
  /** Whether the session has its (single) non-terminal run. */
  busy(sessionID: string): boolean {
    return this.database().prepare(`SELECT 1 FROM runs WHERE session_id = ? AND status IN (${activeSQL})`).get(sessionID) !== undefined;
  }
  /** Non-terminal runs in acceptance order; at most one per session. */
  unfinished(): Run[] { return this.runs(`WHERE status IN (${activeSQL})`); }
  /** One committed state and the sequence of its last event. */
  snapshot(): StoredSnapshot {
    const db = this.database();
    return db.transaction(() => ({ sessions: this.sessions(), runs: this.runs(), cursor: this.cursor() }))();
  }
  cursor(): number { return this.database().prepare("SELECT COALESCE(MAX(sequence), 0) FROM events").pluck().get() as number; }
  /** Events after `after` in order, stopping once `maxBytes` of event data is exceeded (always at least one). */
  events(after: number, maxBytes: number): RunnerEvent[] {
    const events: RunnerEvent[] = [];
    let bytes = 0;
    for (const row of this.database().prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence").iterate(after)) {
      const size = Buffer.byteLength((row as EventRow).event_json);
      if (events.length && bytes + size > maxBytes) break;
      bytes += size;
      events.push(this.event(row as EventRow));
    }
    return events;
  }

  private sessions(): Session[] {
    return (this.database().prepare("SELECT * FROM sessions ORDER BY sequence").all() as SessionRow[]).map(row => this.toSession(row));
  }
  private runs(where = ""): Run[] {
    return (this.database().prepare(`SELECT * FROM runs ${where} ORDER BY sequence`).all() as RunRow[]).map(row => this.toRun(row));
  }
  private toSession(row: SessionRow): Session {
    const session = sessionSchema.parse({
      id: row.id, binding: JSON.parse(row.binding_json), provider: row.provider, createdAt: row.created_at,
      ...optional("providerState", row.provider_state_json)
    });
    if (session.id !== row.id) throw new Error("Session key mismatch");
    return session;
  }
  private toRun(row: RunRow): Run {
    const run = runSchema.parse({
      request: JSON.parse(row.request_json), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      ...optional("pending", row.pending_json), ...optional("result", row.result_json),
      ...optional("error", row.error_json), ...optional("providerState", row.provider_state_json)
    });
    if (run.request.requestID !== row.request_id || run.request.sessionID !== row.session_id) throw new Error("Run key mismatch");
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

  /** Closes the database, then gives up ownership. Also closes an inspecting reader. */
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
