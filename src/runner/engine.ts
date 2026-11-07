import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { EnsoCliError } from "../errors.js";
import { answerSchema, canonical, defaultFakeOptions, outcomeSchema, parse, pendingSchema, sessionInputSchema, sessionSchema, submitSchema, terminal, type Answer, type Change, type Json, type Pending, type Prompt, type Run, type RunnerEvent, type Session, type SessionInput } from "./protocol.js";
import type { RunnerProvider } from "./provider.js";
import type { RunnerStorage } from "./storage.js";

type Active = { controller: AbortController; task: Promise<void>; answer?: (answer: Answer) => void };
type Fields = Omit<Extract<Change, { type: "run_updated" }>, "type" | "requestID" | "status" | "updatedAt">;
/** Event data per /v1/events reply, beyond its first event. */
const eventPageBytes = 1024 * 1024;
/** Runs deleted per retention transaction, which bounds the size of its runs_deleted event. */
const retentionBatch = 500;
/** Pages released per step (8 MiB at SQLite's default 4 KiB page; the file shrinks at the next WAL checkpoint). Each
 * step is a write transaction with a full fsync, so a step stays short while a large backlog takes several steps with
 * requests served between them. */
const reclaimStep = 2048;
/** Free pages (1 MiB at 4 KiB pages) below which a pass releases nothing: ordinary churn frees a few pages between
 * passes, and later writes reuse them for less than a write transaction and a full fsync would cost. */
const reclaimMinimum = 256;

/** Durable state lives only in storage. Every decision and its commit run without yielding, and storage calls are
 * synchronous, so an idempotency or active-slot check cannot interleave with another request's commit. */
export class RunnerEngine {
  private active = new Map<string, Active>();
  private accepting = true;
  private healthy = true;
  private shutdownTask?: Promise<void>;
  constructor(
    private readonly storage: RunnerStorage,
    private readonly provider: RunnerProvider,
    private readonly options: { autoDispatch?: boolean; onFatal?: () => void; reclaimStep?: number } = {}
  ) {
    // Anything past its dispatch marker may have executed: record it as uncertain, never dispatch it again, and mark
    // its session uncertain so the next prompt has to choose how to continue.
    this.commit(this.read(() => storage.unfinished()).filter(run => run.status !== "accepted").flatMap(run => this.uncertain(run, {
      code: "restart_uncertain", message: "Runner stopped after dispatch was recorded; execution may have begun or completed. No automatic replay."
    })));
  }

  /**
   * Validates a session request without committing it, and returns the bridge origin the session must pin, or
   * undefined when this runner's provider gives its agent no bridge.
   */
  bridgeToPin(input: unknown): string | undefined {
    const { binding } = this.sessionRequest(input);
    return this.provider.pinsBridge ? binding.bridgeUrl : undefined;
  }

  /**
   * `bridgeInstanceID`: the instance read from the session's bridge to pin, which the service supplies for a provider
   * that `pinsBridge`. A session without one keeps the bridge disabled for its whole life. A client's expected
   * `binding.bridgeInstanceID` must equal it.
   */
  createSession(input: unknown, bridgeInstanceID?: string): Session {
    const { binding } = this.sessionRequest(input);
    const expected = binding.bridgeInstanceID;
    delete binding.bridgeInstanceID;
    if (expected !== undefined && bridgeInstanceID === undefined) {
      throw new EnsoCliError("invalid_input", "binding.bridgeInstanceID applies only when the runner pins a bridge instance, which it does not for this provider");
    }
    if (expected !== undefined && expected !== bridgeInstanceID) {
      throw new EnsoCliError("bridge_instance_mismatch", "The bridge instance answering at bridgeUrl is not the one the client expected; no session was created", {
        bridgeUrl: binding.bridgeUrl, expectedInstanceID: expected, instanceID: bridgeInstanceID!
      });
    }
    if (bridgeInstanceID !== undefined) binding.bridgeInstanceID = bridgeInstanceID;
    const session: Session = parse(sessionSchema, { id: randomUUID(), binding, provider: this.provider.name, createdAt: new Date().toISOString() });
    this.commit([{ type: "session_created", session }]);
    return session;
  }

  private sessionRequest(input: unknown): SessionInput {
    this.assertAccepting();
    const request = parse(sessionInputSchema, input);
    const { binding, provider } = request;
    if (provider !== undefined && provider !== this.provider.name) throw this.mismatch(provider);
    if (!isAbsolute(binding.workingDirectory)) throw new EnsoCliError("invalid_input", "workingDirectory must be absolute");
    try {
      binding.workingDirectory = realpathSync(binding.workingDirectory);
      if (!statSync(binding.workingDirectory).isDirectory()) throw new Error();
    } catch { throw new EnsoCliError("invalid_input", "workingDirectory must be an existing codebase directory"); }
    return request;
  }

  submit(input: unknown): Run {
    this.assertHealthy();
    const parsed = parse(submitSchema, input);
    const existing = this.read(() => this.storage.run(parsed.requestID));
    // A run's session is retained, so a stored run always finds the session that normalizes its payload.
    const session = this.read(() => this.storage.session(parsed.sessionID));
    const request = session ? normalized(parsed, session) : parsed;
    // Idempotency precedes busy/stopping checks, including after a service restart.
    if (existing) {
      if (canonical(existing.request) !== canonical(request)) throw new EnsoCliError("request_conflict", "requestID already belongs to a different payload");
      return existing;
    }
    this.assertAccepting();
    if (!session) throw new EnsoCliError("session_not_found", "Session not found");
    if (session.provider !== this.provider.name) throw this.mismatch(session.provider);
    if (this.read(() => this.storage.busy(request.sessionID))) {
      throw new EnsoCliError("session_busy", "Only one active prompt is allowed per session");
    }
    // An uncertain session never continues by default: the client names the uncertain run and a recovery mode.
    if (session.uncertain && request.recovery?.after !== session.uncertain.requestID) {
      throw new EnsoCliError("session_uncertain", "The session's last run ended uncertain; resubmit with recovery naming it and a mode (resume or fresh)", {
        requestID: session.uncertain.requestID, modes: ["resume", "fresh"]
      });
    }
    if (!session.uncertain && request.recovery) throw new EnsoCliError("invalid_input", "recovery applies only while the session is uncertain");
    const now = new Date().toISOString();
    const run: Run = { request, status: "accepted", createdAt: now, updatedAt: now };
    this.commit([{ type: "run_accepted", run }]);
    if (this.options.autoDispatch !== false) setImmediate(() => this.dispatch(request.requestID));
    return run;
  }

  snapshot(): { sessions: Session[]; runs: Run[]; cursor: number } {
    this.assertHealthy();
    return this.read(() => this.storage.snapshot());
  }
  /** Committed events after `after`, a page at a time: `cursor` is the last one returned, or `after` when caught up. */
  events(after: number): { events: RunnerEvent[]; cursor: number } {
    this.assertHealthy();
    if (!Number.isSafeInteger(after) || after < 0 || after > this.read(() => this.storage.cursor())) {
      throw new EnsoCliError("invalid_cursor", "Cursor must be an existing sequence in this runner's durable history");
    }
    if (after < this.read(() => this.storage.expiredThrough())) {
      throw new EnsoCliError("cursor_expired", "Retention deleted events after this cursor; take a new snapshot");
    }
    const events = this.read(() => this.storage.events(after, eventPageBytes));
    return { events, cursor: events.at(-1)?.sequence ?? after };
  }
  session(id: string): Session {
    this.assertHealthy();
    const session = this.read(() => this.storage.session(id));
    if (!session) throw new EnsoCliError("session_not_found", "Session not found");
    return session;
  }
  run(id: string): Run {
    this.assertHealthy();
    const run = this.read(() => this.storage.run(id));
    if (!run) throw new EnsoCliError("run_not_found", "Run not found");
    return run;
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
    validateAnswer(run.pending, response.value);
    // The answer is not replayed on restart: crossing this boundary is uncertain execution.
    this.commit([this.update(id, "running")]);
    const resolve = active.answer;
    delete active.answer;
    resolve(response);
    return this.run(id);
  }

  /**
   * Retention: deletes finished runs last updated before `cutoff`, with their events, and returns how many. Yields
   * between batches so requests are served meanwhile, and stops once the runner stops accepting. Each batch is still
   * chosen and committed without yielding, and a finished run never changes, so interleaving is safe.
   *
   * Then, once at least `reclaimMinimum` pages are free, returns them all to the file system in bounded steps, also
   * yielding between them. It goes by the pages actually free rather than by what this pass deleted, so a pass cut
   * short by shutdown is finished by the next one. A failure there fails the runner closed, like any durable write:
   * an I/O or corruption error is a fault the next commit would meet anyway.
   */
  async deleteFinishedBefore(cutoff: Date): Promise<number> {
    this.assertAccepting();
    let deleted = 0;
    for (;;) {
      if (deleted) await yieldTurn();
      if (!this.accepting) return deleted;
      const requestIDs = this.read(() => this.storage.finishedBefore(cutoff.toISOString(), retentionBatch));
      if (requestIDs.length) this.commit([{ type: "runs_deleted", requestIDs }]);
      deleted += requestIDs.length;
      // A short batch drained the backlog.
      if (requestIDs.length < retentionBatch) break;
    }
    const step = this.options.reclaimStep ?? reclaimStep;
    // Stops below the minimum and on a step that released nothing, which could otherwise repeat forever. Each step
    // measures only itself, so pages that commits free between steps are drained too.
    for (let minimum = reclaimMinimum; this.accepting; minimum = 1) {
      this.assertHealthy();
      let released: number;
      try { released = this.storage.reclaim(step, minimum); }
      catch { throw this.fail("Returning freed space failed; runner stopped. Restart and inspect durable state"); }
      if (!released) break;
      await yieldTurn();
    }
    return deleted;
  }

  dispatchAccepted(): void {
    if (!this.healthy) return;
    for (const run of this.read(() => this.storage.unfinished())) if (run.status === "accepted") this.dispatch(run.request.requestID);
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.accepting = false;
    this.shutdownTask = (async () => {
      // A failed cancel commit aborts every provider; still await them before storage is released.
      try {
        // Accepted work for another provider must survive this runner's shutdown for its matching provider to resume.
        const changes = this.healthy ? this.read(() => this.storage.unfinished())
          .filter(run => this.session(run.request.sessionID).provider === this.provider.name)
          .flatMap(run => this.cancelling(run)) : [];
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
    let run: Run | undefined;
    try { run = this.read(() => this.storage.run(id)); } catch { return; }
    if (run?.status !== "accepted") return;
    const sessionID = run.request.sessionID;
    try {
      // Restart recovery bypasses submit(), so check the persisted provider before recording dispatch too.
      if (this.session(sessionID).provider !== this.provider.name) return;
      // Write-ahead dispatch marker: a crash from here onward must never redispatch.
      this.commit([this.update(id, "running")]);
    } catch { return; } // A failed durable read or write has already failed the service closed.
    const controller = new AbortController();
    const active: Active = { controller, task: Promise.resolve() };
    this.active.set(id, active);
    active.task = (async () => {
      try {
        // An outcome that fails validation is unconfirmed and falls through to interrupted.
        const outcome = outcomeSchema.parse(await this.provider.execute({
          session: this.session(sessionID), prompt: run.request, signal: controller.signal,
          record: native => this.record(id, native),
          wait: (pending, withdrawn) => this.wait(id, pendingSchema.parse(pending), controller.signal, withdrawn)
        }));
        if (!this.healthy) return;
        if (outcome.status === "interrupted") return this.commit(this.uncertain(this.run(id), outcome.error));
        const { status, ...fields } = outcome;
        const session = this.session(sessionID);
        // A completed turn reconciles an uncertain session, and so does a confirmed one that set the checkpoint: the
        // recovery then decided which conversation continues. Otherwise the marker stays for the next prompt. A null
        // checkpoint clears it. The result and the session's checkpoint commit together or not at all.
        const checkpointed = outcome.providerState !== undefined;
        const providerState = checkpointed ? outcome.providerState ?? undefined : session.providerState;
        const uncertain = status === "completed" || checkpointed ? undefined : session.uncertain;
        const changed = checkpointed || uncertain !== session.uncertain;
        this.commit([this.update(id, status, fields), ...(changed ? [this.sessionUpdate(sessionID, providerState, uncertain)] : [])]);
      } catch {
        if (this.healthy) this.commit(this.uncertain(this.run(id), {
          code: "provider_uncertain", message: "Provider ended without confirming an outcome; no automatic replay"
        }));
      } finally { this.active.delete(id); }
    })().catch(() => { /* A failed durable write already poisoned the service. */ });
  }

  /**
   * Persists `pending` and resolves with its answer. Rejects when the run is cancelled, and when the provider withdraws
   * the request (`withdrawn` aborts): a withdrawn request is removed durably, so no answer can reach a later one.
   */
  private wait(id: string, pending: Pending, signal: AbortSignal, withdrawn?: AbortSignal): Promise<Answer> {
    signal.throwIfAborted();
    withdrawn?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const active = this.active.get(id)!;
      // One pending per run: refuse a concurrent wait so the first stays persisted and answerable.
      if (active.answer) return reject(new Error("Provider contract violation: wait() called while another wait is pending"));
      const settle = () => {
        signal.removeEventListener("abort", aborted);
        withdrawn?.removeEventListener("abort", withdraw);
        if (active.answer === answer) delete active.answer;
      };
      const aborted = () => { settle(); reject(new Error("Cancelled")); };
      const withdraw = () => {
        if (active.answer !== answer) return;
        settle();
        try {
          const run = this.run(id);
          if (run.pending?.id === pending.id && !terminal(run.status)) this.commit([this.update(id, run.status === "stopping" ? "stopping" : "running")]);
          reject(new Error("Withdrawn"));
        } catch (error) { reject(error); }
      };
      const answer = (value: Answer) => { settle(); resolve(value); };
      active.answer = answer;
      signal.addEventListener("abort", aborted, { once: true });
      withdrawn?.addEventListener("abort", withdraw, { once: true });
      try { this.commit([this.update(id, pending.kind === "permission" ? "waiting_permission" : "waiting_input", { pending })]); }
      catch (error) { settle(); reject(error); }
    });
  }

  /** Commits the provider's native identifiers, keeping the run's status and pending request. */
  private record(id: string, native: Json): void {
    const run = this.run(id);
    if (terminal(run.status)) throw new Error("Provider contract violation: record() after the run finished");
    this.commit([this.update(id, run.status, { ...(run.pending ? { pending: run.pending } : {}), native })]);
  }
  /** The run becomes interrupted and its session uncertain, carrying the native identifiers the run recorded. */
  private uncertain(run: Run, error: NonNullable<Run["error"]>): Change[] {
    const session = this.read(() => this.storage.session(run.request.sessionID))!;
    const uncertain = { requestID: run.request.requestID, ...(run.native !== undefined ? { native: run.native } : {}) };
    return [this.update(run.request.requestID, "interrupted", { error }), this.sessionUpdate(session.id, session.providerState, uncertain)];
  }
  private sessionUpdate(sessionID: string, providerState: Json | undefined, uncertain: Session["uncertain"]): Change {
    return { type: "session_updated", sessionID, ...(providerState !== undefined ? { providerState } : {}), ...(uncertain ? { uncertain } : {}) };
  }
  private mismatch(provider: string): EnsoCliError {
    return new EnsoCliError("provider_mismatch", `This runner serves the ${this.provider.name} provider`, { provider, runnerProvider: this.provider.name });
  }

  private cancelling(run: Run): Change[] {
    return terminal(run.status) || run.status === "stopping" ? [] : [this.update(run.request.requestID, run.status === "accepted" ? "cancelled" : "stopping")];
  }
  /** Every update replaces the run's mutable fields; the recorded native identifiers carry forward unless replaced. */
  private update(requestID: string, status: Run["status"], fields: Fields = {}): Change {
    const native = "native" in fields ? fields.native : this.read(() => this.storage.run(requestID))?.native;
    return { type: "run_updated", requestID, status, updatedAt: new Date().toISOString(), ...fields, ...(native !== undefined ? { native } : {}) };
  }
  /** One durable transaction. If it fails (rolled back, or a commit whose outcome is unknown), the service fails
   * closed: nothing further is served or dispatched, and a restart shows which state is durable. */
  private commit(changes: Change[]): void {
    this.assertHealthy();
    if (!changes.length) return;
    try { this.storage.commit(changes); }
    catch { throw this.fail("Durable write failed; runner stopped. Reconnect after restart to inspect the outcome"); }
  }
  private read<T>(statement: () => T): T {
    this.assertHealthy();
    try { return statement(); }
    catch (error) {
      if (error instanceof EnsoCliError) throw error;
      throw this.fail("Durable read failed; runner stopped. Restart and inspect durable state");
    }
  }
  private fail(message: string): EnsoCliError {
    this.healthy = false;
    this.accepting = false;
    for (const active of this.active.values()) active.controller.abort();
    this.options.onFatal?.();
    return new EnsoCliError("runner_storage_failure", message);
  }
  private assertHealthy(): void {
    if (!this.healthy) throw new EnsoCliError("runner_storage_failure", "Runner storage failed; restart and inspect durable state");
  }
  private assertAccepting(): void {
    this.assertHealthy();
    if (!this.accepting) throw new EnsoCliError("runner_stopping", "Runner is shutting down");
  }
}

/** Fake sessions store the default test controls; other providers refuse them. */
function normalized(request: Prompt, session: Session): Prompt {
  if (session.provider === "fake") return { ...request, fake: request.fake ?? { ...defaultFakeOptions } };
  if (request.fake) throw new EnsoCliError("invalid_input", "fake options apply only to fake sessions");
  return request;
}

/** Choices take one of them; structured questions take an object answering each question id; free input a string. */
function validateAnswer(pending: Pending, value: Answer["value"]): void {
  if (pending.questions) {
    const ids = pending.questions.map(question => question.id).sort();
    if (typeof value === "string" ? ids.length !== 1 : canonical(Object.keys(value).sort()) !== canonical(ids)) {
      throw new EnsoCliError("invalid_input", "Response must answer every pending question by id", { questions: ids });
    }
    return;
  }
  if (typeof value !== "string") throw new EnsoCliError("invalid_input", "Response must be a string");
  if (pending.choices && !pending.choices.includes(value)) throw new EnsoCliError("invalid_input", "Response must match a pending choice");
}
