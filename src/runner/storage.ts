import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "../config.js";
import { EnsoCliError } from "../errors.js";
import { stateSchema, terminal, type State } from "./protocol.js";

export function runnerDirectory(): string { return join(configDir(), "runner", "v1"); }

/** Single writer, atomic snapshots. Every acknowledged transaction fsyncs both file and directory. */
export class RunnerStorage {
  readonly directory: string;
  private locked = false;
  constructor(directory = runnerDirectory()) { this.directory = resolve(directory); }

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

  load(): State {
    const path = join(this.directory, "state.json");
    if (!existsSync(path)) return { storageVersion: 1, sequence: 0, sessions: [], runs: [], events: [] };
    let state: State;
    try { state = stateSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
    catch { throw new EnsoCliError("invalid_runner_storage", "Unsupported or damaged runner state; refusing to overwrite it"); }
    const sessions = new Set(state.sessions.map(session => session.id));
    const requests = new Set(state.runs.map(run => run.request.requestID));
    const activeSessions = state.runs.filter(run => !terminal(run.status)).map(run => run.request.sessionID);
    if (sessions.size !== state.sessions.length || requests.size !== state.runs.length ||
      activeSessions.length !== new Set(activeSessions).size || state.runs.some(run => !sessions.has(run.request.sessionID)) ||
      state.sequence !== state.events.length || state.events.some((event, index) => event.sequence !== index + 1)) {
      throw new EnsoCliError("invalid_runner_storage", "Runner state invariants failed; refusing to dispatch");
    }
    return state;
  }

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
      const directoryFD = openSync(this.directory, "r");
      try { fsyncSync(directoryFD); } finally { closeSync(directoryFD); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  release(): void {
    if (!this.locked) return;
    unlinkSync(join(this.directory, "owner"));
    this.locked = false;
  }
}
