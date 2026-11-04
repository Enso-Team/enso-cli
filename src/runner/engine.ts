import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { EnsoCliError } from "../errors.js";
import { answerSchema, canonical, outcomeSchema, parse, pendingSchema, promptSchema, sessionInputSchema, terminal, type Answer, type Change, type Pending, type Run, type RunnerEvent, type Session } from "./protocol.js";
import type { RunnerProvider } from "./provider.js";
import { transact, type State } from "./state.js";
import { RunnerStorage } from "./storage.js";

type Active = { controller: AbortController; task: Promise<void>; answer?: (answer: Answer) => void };
type Fields = Omit<Extract<Change, { type: "run_updated" }>, "type" | "requestID" | "status" | "updatedAt">;

export class RunnerEngine {
  private state: State;
  // Retained events are exactly the log: those after the last compaction (`base`). Older cursors need a new snapshot.
  private history: RunnerEvent[];
  private base: number;
  private active = new Map<string, Active>();
  private accepting = true;
  private healthy = true;
  private shutdownTask?: Promise<void>;
  constructor(
    private readonly storage: RunnerStorage,
    private readonly provider: RunnerProvider,
    private readonly options: { autoDispatch?: boolean; onFatal?: () => void } = {}
  ) {
    const { state, events } = storage.load();
    this.state = state;
    this.history = events;
    this.base = state.sequence - events.length;
    this.commit(this.unfinished().filter(run => run.status !== "accepted").map(run => this.update(run.request.requestID, "interrupted", {
      error: { code: "restart_uncertain", message: "Runner stopped after dispatch was recorded; execution may have begun or completed. No automatic replay." }
    })));
  }

  createSession(input: unknown): Session {
    this.assertAccepting();
    const { binding } = parse(sessionInputSchema, input);
    if (!isAbsolute(binding.workingDirectory)) throw new EnsoCliError("invalid_input", "workingDirectory must be absolute");
    try {
      binding.workingDirectory = realpathSync(binding.workingDirectory);
      if (!statSync(binding.workingDirectory).isDirectory()) throw new Error();
    } catch { throw new EnsoCliError("invalid_input", "workingDirectory must be an existing codebase directory"); }
    const session: Session = { id: randomUUID(), binding, provider: this.provider.name, createdAt: new Date().toISOString() };
    this.commit([{ type: "session_created", session }]);
    return structuredClone(session);
  }

  submit(input: unknown): Run {
    this.assertHealthy();
    const request = parse(promptSchema, input);
    const existing = this.state.runs.get(request.requestID);
    // Idempotency precedes busy/stopping checks, including after a service restart.
    if (existing) {
      if (canonical(existing.request) !== canonical(request)) throw new EnsoCliError("request_conflict", "requestID already belongs to a different payload");
      return structuredClone(existing);
    }
    this.assertAccepting();
    this.session(request.sessionID);
    if (this.state.busy.has(request.sessionID)) {
      throw new EnsoCliError("session_busy", "Only one active prompt is allowed per session");
    }
    const now = new Date().toISOString();
    const run: Run = { request, status: "accepted", createdAt: now, updatedAt: now };
    this.commit([{ type: "run_accepted", run }]);
    if (this.options.autoDispatch !== false) setImmediate(() => this.dispatch(request.requestID));
    return structuredClone(run);
  }

  snapshot(): { sessions: Session[]; runs: Run[]; cursor: number } {
    this.assertHealthy();
    return structuredClone({ sessions: [...this.state.sessions.values()], runs: [...this.state.runs.values()], cursor: this.state.sequence });
  }
  events(after: number): { events: RunnerEvent[]; cursor: number } {
    this.assertHealthy();
    if (!Number.isSafeInteger(after) || after < 0 || after > this.state.sequence) {
      throw new EnsoCliError("invalid_cursor", "Cursor must be an existing sequence in this runner's durable history");
    }
    if (after < this.base) throw new EnsoCliError("cursor_expired", "Events before this cursor were compacted; read a new snapshot and continue from its cursor");
    return structuredClone({ events: this.history.slice(after - this.base), cursor: this.state.sequence });
  }
  session(id: string): Session {
    this.assertHealthy();
    const session = this.state.sessions.get(id);
    if (!session) throw new EnsoCliError("session_not_found", "Session not found");
    return structuredClone(session);
  }
  run(id: string): Run {
    this.assertHealthy();
    const run = this.state.runs.get(id);
    if (!run) throw new EnsoCliError("run_not_found", "Run not found");
    return structuredClone(run);
  }

  cancel(id: string): Run {
    const run = this.run(id);
    if (terminal(run.status) || run.status === "stopping") return run;
    this.commit(this.cancelling(run));
    this.active.get(id)?.controller.abort();
    return this.run(id);
  }

  answer(id: string, input: unknown): Run {
    const response = parse(answerSchema, input);
    const run = this.run(id);
    const active = this.active.get(id);
    if (!run.pending || !active?.answer || run.pending.id !== response.pendingID ||
      !["waiting_permission", "waiting_input"].includes(run.status)) {
      throw new EnsoCliError("pending_not_found", "No matching pending request; inspect the current run");
    }
    if (run.pending.choices && !run.pending.choices.includes(response.value)) throw new EnsoCliError("invalid_input", "Response must match a pending choice");
    // The answer is not replayed on restart: crossing this boundary is uncertain execution.
    this.commit([this.update(id, "running")]);
    const resolve = active.answer;
    delete active.answer;
    resolve(response);
    return this.run(id);
  }

  dispatchAccepted(): void {
    for (const run of this.unfinished()) if (run.status === "accepted") this.dispatch(run.request.requestID);
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.accepting = false;
    this.shutdownTask = (async () => {
      // A failed cancel commit aborts every provider; still await them before storage is released.
      try {
        const changes = this.healthy ? this.unfinished().flatMap(run => this.cancelling(run)) : [];
        if (changes.length) {
          this.commit(changes);
          for (const active of this.active.values()) active.controller.abort();
        }
      } finally { await Promise.all([...this.active.values()].map(active => active.task)); }
    })();
    return this.shutdownTask;
  }

  private dispatch(id: string): void {
    if (!this.accepting || !this.healthy || this.active.has(id)) return;
    const run = this.state.runs.get(id);
    if (run?.status !== "accepted") return;
    // Write-ahead dispatch marker: a crash from here onward must never redispatch.
    try { this.commit([this.update(id, "running")]); }
    catch { return; } // commit has already failed the service closed.
    const controller = new AbortController();
    const active: Active = { controller, task: Promise.resolve() };
    this.active.set(id, active);
    active.task = (async () => {
      try {
        // An outcome that fails validation is unconfirmed and falls through to interrupted.
        const outcome = outcomeSchema.parse(await this.provider.execute({
          session: this.session(run.request.sessionID), prompt: structuredClone(run.request), signal: controller.signal,
          wait: pending => this.wait(id, pendingSchema.parse(pending), controller.signal)
        }));
        if (!this.healthy) return;
        const { status, ...fields } = outcome;
        this.commit([this.update(id, status, fields), ...(outcome.status === "completed" && outcome.providerState !== undefined
          ? [{ type: "session_updated" as const, sessionID: run.request.sessionID, providerState: outcome.providerState }] : [])]);
      } catch {
        if (this.healthy) this.commit([this.update(id, "interrupted", {
          error: { code: "provider_uncertain", message: "Provider ended without confirming an outcome; no automatic replay" }
        })]);
      } finally { this.active.delete(id); }
    })().catch(() => { /* A failed durable write already poisoned the service. */ });
  }

  private wait(id: string, pending: Pending, signal: AbortSignal): Promise<Answer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const active = this.active.get(id)!;
      // One pending per run: refuse a concurrent wait so the first stays persisted and answerable.
      if (active.answer) return reject(new Error("Provider contract violation: wait() called while another wait is pending"));
      const aborted = () => { delete active.answer; reject(new Error("Cancelled")); };
      active.answer = answer => { signal.removeEventListener("abort", aborted); resolve(answer); };
      signal.addEventListener("abort", aborted, { once: true });
      try { this.commit([this.update(id, pending.kind === "permission" ? "waiting_permission" : "waiting_input", { pending })]); }
      catch (error) { signal.removeEventListener("abort", aborted); delete active.answer; reject(error); }
    });
  }

  private unfinished(): Run[] { return [...this.state.busy.values()].map(id => this.state.runs.get(id)!); }
  private cancelling(run: Run): Change[] {
    return terminal(run.status) || run.status === "stopping" ? [] : [this.update(run.request.requestID, run.status === "accepted" ? "cancelled" : "stopping")];
  }
  private update(requestID: string, status: Run["status"], fields: Fields = {}): Change {
    return { type: "run_updated", requestID, status, updatedAt: new Date().toISOString(), ...fields };
  }
  /** Validates via the reducer, appends one log line, then keeps the result. Any failure leaves memory untouched. */
  private commit(changes: Change[]): void {
    this.assertHealthy();
    if (!changes.length) return;
    const events = changes.map((change, index) => ({ sequence: this.state.sequence + index + 1, ...change }) as RunnerEvent);
    try {
      transact(this.state, events, () => this.storage.append(events));
      for (const event of events) this.history.push(event);
      if (this.storage.compactionDue()) {
        this.storage.compact(this.state);
        this.history = [];
        this.base = this.state.sequence;
      }
    } catch {
      this.healthy = false;
      this.accepting = false;
      for (const active of this.active.values()) active.controller.abort();
      this.options.onFatal?.();
      throw new EnsoCliError("runner_storage_failure", "Durable write failed; runner stopped. Reconnect after restart to inspect the outcome");
    }
  }
  private assertHealthy(): void {
    if (!this.healthy) throw new EnsoCliError("runner_storage_failure", "Runner storage failed; restart and inspect durable state");
  }
  private assertAccepting(): void {
    this.assertHealthy();
    if (!this.accepting) throw new EnsoCliError("runner_stopping", "Runner is shutting down");
  }
}
