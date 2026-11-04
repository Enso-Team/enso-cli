import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "../config.js";
import { EnsoCliError } from "../errors.js";
import { snapshotSchema, storageVersion, transactionSchema, type RunnerEvent, type Snapshot } from "./protocol.js";
import { restore, toSnapshot, transact, type State } from "./state.js";

export function runnerDirectory(): string { return join(configDir(), "runner", "v1"); }

/** Single writer. `state.json` is an atomic snapshot at some sequence; `log.jsonl` holds one line per acknowledged
 * transaction (O_APPEND, fsync). Only newline-terminated lines were ever acknowledged. Load replays the records past
 * the snapshot, so a crash at any compaction step neither loses nor double-applies a transaction. */
export class RunnerStorage {
  readonly directory: string;
  private locked = false;
  private log?: number;
  private logBytes?: number; // Acknowledged bytes; a torn tail past this is truncated before the next append.
  private snapshotBytes = 0;
  private settledBytes = 0; // Log bytes the next compaction ignores: the retained tail, or all of it after a failed attempt.
  private readonly compactBytes: number;
  constructor(directory = runnerDirectory(), options: { compactBytes?: number } = {}) {
    this.directory = resolve(directory);
    this.compactBytes = options.compactBytes ?? 8 * 1024 * 1024;
  }

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
  }

  /** Reads without modifying anything. `events` are every logged event: the replayed ones after the snapshot, preceded by
   * any lines it already covers (the tail a compaction retained for cursors). */
  load(): { state: State; events: RunnerEvent[] } {
    const fail = (message: string): never => { throw new EnsoCliError("invalid_runner_storage", `${message}; refusing to dispatch or overwrite it`); };
    const read = (name: string) => {
      try { return readFileSync(join(this.directory, name)); }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : fail(`Unreadable runner ${name}`); }
    };
    const file = read("state.json");
    let snapshot: Snapshot = { storageVersion, sequence: 0, sessions: [], runs: [] };
    if (file) {
      let value: unknown;
      try { value = JSON.parse(file.toString("utf8")); } catch { fail("Damaged runner snapshot"); }
      const version = (value as { storageVersion?: unknown } | null)?.storageVersion;
      if (version !== storageVersion) fail(`Unsupported runner storage version ${JSON.stringify(version) ?? "(none)"}; this runner reads only version ${storageVersion} and never migrates`);
      const parsed = snapshotSchema.safeParse(value);
      snapshot = parsed.success ? parsed.data : fail("Damaged runner snapshot");
    }
    let state!: State;
    try { state = restore(snapshot); } catch { fail("Runner snapshot invariants failed"); }
    const log = read("log.jsonl") ?? Buffer.alloc(0);
    const end = log.lastIndexOf(0x0a) + 1;
    const events: RunnerEvent[] = [];
    let last: number | undefined;
    let covered = 0;
    for (const line of end ? log.subarray(0, end - 1).toString("utf8").split("\n") : []) {
      let transaction!: RunnerEvent[];
      try { transaction = transactionSchema.parse(JSON.parse(line)).events; } catch { fail("Damaged runner log record"); }
      const first = transaction[0].sequence;
      if ((last !== undefined && first !== last + 1) || transaction.some((event, index) => event.sequence !== first + index)) fail("Runner log sequence gap");
      last = transaction.at(-1)!.sequence;
      // Records the snapshot already covers remain after a crash between snapshot rename and log truncation.
      if (last <= snapshot.sequence) covered += Buffer.byteLength(line) + 1;
      else try { transact(state, transaction); } catch { fail("Runner log does not continue its snapshot, or its invariants failed"); }
      events.push(...transaction);
    }
    if (last !== undefined && last < snapshot.sequence) fail("Runner log does not reach its snapshot");
    this.logBytes = end;
    this.snapshotBytes = file?.length ?? 0;
    this.settledBytes = covered;
    return { state, events };
  }

  /** Appends one transaction as one line and fsyncs it. Throws if it may not be durable. */
  append(events: RunnerEvent[]): void {
    if (!this.locked || this.logBytes === undefined) throw new Error("Storage is not owned and loaded");
    const line = Buffer.from(JSON.stringify({ events }) + "\n");
    if (this.log === undefined) {
      const path = join(this.directory, "log.jsonl");
      const created = !existsSync(path);
      const fd = openSync(path, "a", 0o600);
      try {
        const size = fstatSync(fd).size;
        if (size < this.logBytes) throw new Error("Runner log shrank while owned");
        if (size > this.logBytes) { ftruncateSync(fd, this.logBytes); fsyncSync(fd); }
        if (created) this.syncDirectory();
      } catch (error) { closeSync(fd); throw error; }
      this.log = fd;
    }
    for (let offset = 0; offset < line.length;) offset += writeSync(this.log, line, offset);
    fsyncSync(this.log);
    this.logBytes += line.length;
  }

  /** Amortized: appends may reach the snapshot's size, so rewriting the snapshot costs O(1) per appended byte. */
  compactionDue(): boolean {
    return this.log !== undefined && this.logBytes! - this.settledBytes >= Math.max(this.compactBytes, this.snapshotBytes);
  }

  /** Atomically replaces the snapshot with `state`, then the log with its newest lines (the last, plus earlier ones
   * within an eighth of `compactBytes`) so recent cursors survive. Returns the sequence before the oldest one kept.
   * Throws without losing an acknowledged line; the next attempt waits for another threshold of appends. */
  compact(state: State): number {
    if (this.log === undefined) throw new Error("Runner log is not open");
    this.settledBytes = this.logBytes!;
    this.snapshotBytes = this.write("state.json", toSnapshot(state));
    const log = readFileSync(join(this.directory, "log.jsonl")).subarray(0, this.logBytes);
    const lineStart = (end: number) => log.lastIndexOf(0x0a, end - 2) + 1;
    let start = lineStart(log.length);
    while (start > 0 && log.length - lineStart(start) <= this.compactBytes / 8) start = lineStart(start);
    const tail = log.subarray(start);
    const base = (JSON.parse(tail.subarray(0, tail.indexOf(0x0a)).toString("utf8")) as { events: RunnerEvent[] }).events[0].sequence - 1;
    // The next append reopens and size-checks whichever log survives, so a replacement that may have landed fails closed.
    const fd = this.log;
    this.log = undefined;
    closeSync(fd);
    this.replace("log.jsonl", tail);
    this.logBytes = this.settledBytes = tail.length;
    return base;
  }

  /** Atomic private file replacement: temporary file, fsync, rename, directory fsync. Returns bytes written. */
  write(name: string, value: unknown): number { return this.replace(name, Buffer.from(JSON.stringify(value) + "\n")); }

  private replace(name: string, text: Buffer): number {
    if (!this.locked) throw new Error("Storage is not owned");
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, text);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, join(this.directory, name));
      this.syncDirectory();
      return text.length;
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  release(): void {
    if (!this.locked) return;
    if (this.log !== undefined) { closeSync(this.log); this.log = undefined; }
    this.logBytes = undefined;
    unlinkSync(join(this.directory, "owner"));
    this.locked = false;
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
