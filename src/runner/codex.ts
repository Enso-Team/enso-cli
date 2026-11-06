import { realpathSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { EnsoCliError } from "../errors.js";
import { cliVersion } from "../version.js";
import { bounded, plain, runnerBridgeEnv, runnerInstructions, selectionText } from "./agent-context.js";
import { CodexRequestError, type CodexConnect, type CodexConnection, type CodexDiagnostic, type CodexTermination, type NotificationParams, type RequestParams, type ServerRequestResponse } from "./codex-connection.js";
import type { Answer, Json, Pending, Prompt, Session } from "./protocol.js";
import type { Execution, ProviderOutcome, RunnerProvider } from "./provider.js";

export const codexApprovalPolicies = ["untrusted", "on-request", "never"] as const;
export const codexSandboxModes = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexConfig = {
  /** The Codex CLI, run as `<executable> app-server`; the CLI resolves it to an absolute path when the runner starts. */
  executable: string;
  model?: string;
  /** Always sent, with `approvalsReviewer: "user"`: left to the user's Codex configuration, approvals could bypass the runner. */
  approvalPolicy: (typeof codexApprovalPolicies)[number];
  sandbox: (typeof codexSandboxModes)[number];
};
/** The session's conversation checkpoint. */
export type CodexState = { threadID: string };
/**
 * Recorded on the run: before the app-server starts (`threadID` is the thread to resume, or null for a new one), once
 * Codex names the thread and before the prompt is sent, and once Codex names the turn and before the runner relies on
 * it.
 */
export type CodexNative = {
  threadID: string | null; resume: boolean; turnID: string | null; model: string | null;
  approvalPolicy: CodexConfig["approvalPolicy"]; sandbox: CodexConfig["sandbox"];
};

/** How long a requested interrupt, and then the turn's end, may take before cancellation is reported unconfirmed. */
export const codexStopTimeoutMs = 10_000;
/** Notifications whose loss leaves the turn's outcome unknown. The vendored client drops one that fails to decode. */
const outcomeNotifications = new Set(["turn/completed"]);

/** Loads the transport, and with it Effect and the vendored client, only for a runner that serves Codex. */
export async function loadCodexConnect(): Promise<CodexConnect> {
  try { return (await import("./codex-app-server.js")).connectCodex; }
  catch (error) {
    throw new EnsoCliError("runner_provider_unavailable", "The Codex provider's app-server transport failed to load", { cause: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Runs one runner prompt as one Codex turn, in a `codex app-server` process of its own started in the session's
 * stored working directory. Approval and user-input requests become runner pending requests, one at a time. Outcomes
 * come only from provider evidence: the `turn/completed` notification for this turn, or a refusal Codex answered
 * before the turn started. A connection that ends, a notification that cannot be read, or a stop that is not confirmed
 * in time leaves the run interrupted (uncertain). Nothing is retried: a failed turn is never resubmitted.
 */
export class CodexProvider implements RunnerProvider {
  readonly name = "codex" as const;
  constructor(
    private readonly connect: CodexConnect,
    private readonly config: CodexConfig,
    private readonly options: { stopTimeoutMs?: number; exitGraceMs?: number } = {}
  ) {}

  async execute({ session, prompt, signal, record, wait }: Execution): Promise<ProviderOutcome> {
    const cwd = session.binding.workingDirectory;
    try { if (!statSync(cwd).isDirectory()) throw new Error(); }
    catch { return { status: "failed", error: { code: "working_directory_unavailable", message: "The session's working directory no longer exists; the runner does not substitute another", details: { workingDirectory: cwd } } }; }
    // Nothing has started yet, so stopping here is a confirmed cancellation.
    if (signal.aborted) return { status: "cancelled" };
    const threadID = this.thread(session, prompt);
    const native: CodexNative = {
      threadID: threadID ?? null, resume: threadID !== undefined, turnID: null, model: this.config.model ?? null,
      approvalPolicy: this.config.approvalPolicy, sandbox: this.config.sandbox
    };
    // Durable before the app-server can resume this thread or create another.
    record(native);
    return new Turn(this.connect, this.config, {
      cwd, prompt, signal, wait, record, native,
      stopTimeoutMs: this.options.stopTimeoutMs ?? codexStopTimeoutMs, exitGraceMs: this.options.exitGraceMs
    }).run();
  }

  /**
   * Which thread this prompt continues, if any. An uncertain session continues only as its prompt's recovery says:
   * `fresh` starts a new thread; `resume` continues the one the uncertain run recorded (or the checkpoint, when that
   * run recorded none, so never sent its prompt).
   */
  private thread(session: Readonly<Session>, prompt: Readonly<Prompt>): string | undefined {
    const state = threadOf(session.providerState);
    if (session.uncertain) {
      if (prompt.recovery?.mode !== "resume") return undefined;
      const recorded = threadOf(session.uncertain.native);
      if (recorded) return recorded;
    }
    return state;
  }
}

function threadOf(value: Json | undefined): string | undefined {
  const id = value && typeof value === "object" && !Array.isArray(value) ? value.threadID : undefined;
  return typeof id === "string" ? id : undefined;
}

type TurnInput = {
  cwd: string; prompt: Readonly<Prompt>; signal: AbortSignal; wait: Execution["wait"]; record: Execution["record"];
  native: CodexNative; stopTimeoutMs: number; exitGraceMs?: number;
};
type Completion = NotificationParams<"turn/completed">;
/** What ends the wait for this turn: its completion, the connection's end, an unreadable outcome, or the stop deadline. */
type Settled =
  | { kind: "completed"; completion: Completion }
  | { kind: "terminated"; termination: CodexTermination }
  | { kind: "malformed"; diagnostic: CodexDiagnostic }
  | { kind: "expired" };
type TurnError = NonNullable<Completion["turn"]["error"]>;
type Decision = "allow" | "allow_session" | "deny";

class Turn {
  private native: CodexNative;
  private connection?: CodexConnection;
  private turnID?: string;
  private interruptRequested = false;
  private interrupt: "pending" | "acknowledged" | "failed" | undefined;
  private timer?: NodeJS.Timeout;
  private termination?: CodexTermination;
  private settle!: (settled: Settled) => void;
  private readonly settled = new Promise<Settled>(resolve => { this.settle = resolve; });
  private outcomeSettled = false;
  /** This turn has ended: requests still queued have nothing left to ask in. */
  private finished = false;
  /** Serializes requests: the runner keeps one pending request per run. */
  private callbacks = Promise.resolve();
  private readonly pendingIDs = new Set<string>();
  /** Notifications about this thread, by turn: a completion can arrive before turn/start's answer is read. */
  private readonly completions = new Map<string, Completion>();
  private readonly messages = new Map<string, { text: string; final: boolean }>();
  private readonly errors = new Map<string, TurnError>();
  private readonly usage = new Map<string, Json>();
  private readonly fileChanges = new Map<string, Json>();
  private readonly diagnostics: string[] = [];

  constructor(private readonly connect: CodexConnect, private readonly config: CodexConfig, private readonly input: TurnInput) {
    this.native = input.native;
  }

  async run(): Promise<ProviderOutcome> {
    const { cwd, signal } = this.input;
    let connection: CodexConnection;
    try {
      connection = await this.connect({
        command: this.config.executable, args: ["app-server"], cwd,
        env: { ...process.env, [runnerBridgeEnv]: "disabled" },
        onDiagnostic: diagnostic => this.diagnostic(diagnostic),
        ...(this.input.exitGraceMs === undefined ? {} : { exitGraceMs: this.input.exitGraceMs })
      });
    } catch (error) {
      return { status: "failed", error: { code: "codex_unavailable", message: "Codex could not be started; nothing was sent", details: plain({
        executable: this.config.executable, cause: error instanceof Error ? error.message : String(error)
      }) as Record<string, Json> } };
    }
    this.connection = connection;
    this.listen(connection);
    void connection.terminated.then(termination => {
      this.termination = termination;
      if (termination.code !== "closed") this.resolve({ kind: "terminated", termination });
    });
    const stop = () => this.stop();
    signal.addEventListener("abort", stop, { once: true });
    try { return await this.drive(connection); }
    finally {
      signal.removeEventListener("abort", stop);
      clearTimeout(this.timer);
      this.finished = true;
      // The process and everything it started are gone before the outcome is reported.
      await connection.close();
    }
  }

  private async drive(connection: CodexConnection): Promise<ProviderOutcome> {
    const { signal } = this.input;
    // Until turn/start is sent nothing can act on the prompt: a failure is confirmed, and a stop is a cancellation.
    let thread: { id: string; cwd: string };
    try {
      await connection.request("initialize", { clientInfo: { name: "enso-cli", title: "Enso CLI", version: cliVersion } });
      await connection.notify("initialized");
      if (signal.aborted) return { status: "cancelled" };
      thread = await this.openThread(connection);
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      return this.notStarted(connection, error);
    }
    const requested = this.native.threadID;
    if (requested !== null && thread.id !== requested) {
      return this.failed("codex_thread_mismatch", "Codex resumed another thread than the one requested; the prompt was not sent", { requested, actual: thread.id });
    }
    if (!sameDirectory(thread.cwd, this.input.cwd)) {
      return this.failed("working_directory_mismatch", "Codex opened the thread in another directory than the session's; the prompt was not sent", { workingDirectory: this.input.cwd, codexDirectory: thread.cwd, threadID: thread.id });
    }
    this.native = { ...this.native, threadID: thread.id };
    // Durable before the prompt can run in this thread.
    this.input.record(this.native);
    if (signal.aborted) return { status: "cancelled" };
    // A connection already known to be gone cannot carry turn/start: the prompt is certainly not sent.
    const gone = this.termination;
    if (gone && gone.code !== "closed") {
      const lost = terminationCode(gone);
      return this.failed(lost.code, `${lost.message}; the prompt was not sent`, { threadID: thread.id, ...terminationDetails(gone) });
    }

    let turnID: string;
    try { turnID = (await connection.request("turn/start", this.turnParams(thread.id))).turn.id; }
    catch (error) {
      if (error instanceof CodexRequestError && (error.kind === "rejected" || error.kind === "not_sent")) {
        if (signal.aborted) return { status: "cancelled" };
        return this.failed(error.kind === "rejected" ? "codex_turn_rejected" : "codex_invalid_request", `Codex did not start the turn: ${error.message}`, { threadID: thread.id, ...(error.rpcCode === undefined ? {} : { rpcCode: error.rpcCode }) });
      }
      // turn/start may have reached Codex: the prompt may be running.
      return this.uncertain(await this.lost(connection, error), error);
    }
    this.turnID = turnID;
    this.native = { ...this.native, turnID };
    // Durable before the runner interrupts or attributes anything by it.
    this.input.record(this.native);
    if (this.interruptRequested) this.sendInterrupt(connection);
    const early = this.completions.get(turnID);
    if (early) return this.completed(early);

    const settled = await this.settled;
    // A completion is evidence even when it arrived after another ending was noted.
    const completion = this.completions.get(turnID);
    if (completion) return this.completed(completion);
    if (settled.kind === "terminated") return this.uncertain(terminationCode(settled.termination), undefined, settled.termination);
    if (settled.kind === "malformed") {
      return this.uncertain({ code: "codex_malformed_message", message: `Codex sent a ${String(settled.diagnostic.annotations.method)} notification that could not be read; this turn's outcome is unknown` });
    }
    if (settled.kind === "expired") return this.uncertain({ code: "cancel_unconfirmed", message: "Codex did not confirm the stop in time; it may still be running or have finished" });
    return this.completed(settled.completion);
  }

  private async openThread(connection: CodexConnection): Promise<{ id: string; cwd: string }> {
    const { approvalPolicy, sandbox, model } = this.config;
    const common = {
      cwd: this.input.cwd, approvalPolicy, approvalsReviewer: "user" as const, sandbox,
      developerInstructions: runnerInstructions,
      config: { [`shell_environment_policy.set.${runnerBridgeEnv}`]: "disabled" },
      ...(model ? { model } : {})
    };
    const response = this.native.threadID !== null
      ? await connection.request("thread/resume", { threadId: this.native.threadID, excludeTurns: true, ...common })
      : await connection.request("thread/start", common);
    return { id: response.thread.id, cwd: response.cwd };
  }

  private turnParams(threadID: string): RequestParams<"turn/start"> {
    const { text, context } = this.input.prompt;
    const captured = selectionText(context);
    const { approvalPolicy, sandbox, model } = this.config;
    return {
      threadId: threadID, cwd: this.input.cwd,
      input: [...(captured === undefined ? [] : [{ type: "text" as const, text: captured }]), { type: "text", text }],
      approvalPolicy, approvalsReviewer: "user", sandboxPolicy: sandboxPolicy(sandbox),
      ...(model ? { model } : {})
    };
  }

  private listen(connection: CodexConnection): void {
    const ours = (threadID: string) => threadID === this.native.threadID;
    connection.onNotification("turn/completed", params => {
      if (!ours(params.threadId)) return;
      this.completions.set(params.turn.id, params);
      if (params.turn.id === this.turnID) this.resolve({ kind: "completed", completion: params });
    });
    connection.onNotification("item/started", params => {
      if (ours(params.threadId) && params.item.type === "fileChange") this.fileChanges.set(params.item.id, bounded(params.item.changes));
    });
    connection.onNotification("item/completed", params => {
      if (!ours(params.threadId) || params.item.type !== "agentMessage") return;
      const final = params.item.phase === "final_answer";
      // The final answer wins over later commentary; otherwise the latest message is the turn's text.
      if (final || !this.messages.get(params.turnId)?.final) this.messages.set(params.turnId, { text: params.item.text, final });
    });
    connection.onNotification("error", params => {
      if (ours(params.threadId) && !params.willRetry) this.errors.set(params.turnId, params.error);
    });
    connection.onNotification("thread/tokenUsage/updated", params => {
      if (ours(params.threadId)) this.usage.set(params.turnId, plain(params.tokenUsage));
    });

    connection.onRequest("item/commandExecution/requestApproval", (params, withdrawn) => this.serialized(withdrawn, () => ({ decision: "cancel" as const }), async () => {
      const decision = await this.approve(params.itemId, withdrawn, {
        message: params.command ?? params.reason ?? "Codex asks to run a command", reason: params.reason,
        details: { method: "item/commandExecution/requestApproval", threadID: params.threadId, turnID: params.turnId, itemID: params.itemId,
          command: params.command ?? null, cwd: params.cwd ?? null, commandActions: bounded(params.commandActions ?? null),
          ...(params.networkApprovalContext ? { networkApprovalContext: bounded(params.networkApprovalContext) } : {}) }
      });
      return { decision: decision === undefined ? "cancel" : approvalDecision(decision) };
    }));
    connection.onRequest("item/fileChange/requestApproval", (params, withdrawn) => this.serialized(withdrawn, () => ({ decision: "cancel" as const }), async () => {
      const decision = await this.approve(params.itemId, withdrawn, {
        message: params.reason ?? "Codex asks to change files", reason: params.reason,
        details: { method: "item/fileChange/requestApproval", threadID: params.threadId, turnID: params.turnId, itemID: params.itemId,
          grantRoot: params.grantRoot ?? null, changes: this.fileChanges.get(params.itemId) ?? null }
      });
      return { decision: decision === undefined ? "cancel" : approvalDecision(decision) };
    }));
    connection.onRequest("item/permissions/requestApproval", (params, withdrawn) => this.serialized<ServerRequestResponse<"item/permissions/requestApproval">>(withdrawn, () => ({ permissions: {}, scope: "turn" }), async () => {
      const decision = await this.approve(params.itemId, withdrawn, {
        message: params.reason ?? "Codex asks for additional permissions", reason: params.reason,
        details: { method: "item/permissions/requestApproval", threadID: params.threadId, turnID: params.turnId, itemID: params.itemId,
          cwd: params.cwd, permissions: bounded(params.permissions) }
      });
      // Granted as requested, for this turn or (allow_session) the rest of the app-server process, which is this turn.
      if (decision === "allow" || decision === "allow_session") return { permissions: params.permissions, scope: decision === "allow" ? "turn" : "session" };
      return { permissions: {}, scope: "turn" };
    }));
    connection.onRequest("item/tool/requestUserInput", (params, withdrawn) => this.serialized(withdrawn, () => ({ answers: {} }), async () => {
      const questions = params.questions.map(question => ({
        id: question.id, header: question.header, question: question.question, multiSelect: false,
        options: (question.options ?? []).map(option => ({ label: option.label, description: option.description || option.label }))
      }));
      if (!questions.length) return { answers: {} };
      const answer = await this.ask({
        id: this.pendingID(params.itemId), kind: "input", message: questions.map(question => question.question).join("\n"), questions,
        details: plain({ method: "item/tool/requestUserInput", threadID: params.threadId, turnID: params.turnId, itemID: params.itemId,
          secret: params.questions.filter(question => question.isSecret).map(question => question.id),
          other: params.questions.filter(question => question.isOther).map(question => question.id) }) as Record<string, Json>
      }, withdrawn);
      if (!answer) return { answers: {} };
      const values = typeof answer.value === "string" ? { [questions[0].id]: answer.value } : answer.value;
      return { answers: Object.fromEntries(questions.map(question => {
        const value = values[question.id] ?? [];
        return [question.id, { answers: Array.isArray(value) ? value : [value] }];
      })) };
    }));
    // MCP servers' own forms are not offered through the runner.
    connection.onRequest("mcpServer/elicitation/request", async () => ({ action: "decline" }));
  }

  /** The user's decision, or undefined when the run was cancelled or Codex withdrew the request. */
  private async approve(itemID: string, withdrawn: AbortSignal, request: { message: string; reason?: string | null; details: Record<string, unknown> }): Promise<Decision | undefined> {
    const reason = request.reason?.trim();
    const answer = await this.ask({
      id: this.pendingID(itemID), kind: "permission", message: request.message, choices: ["allow", "allow_session", "deny"],
      details: plain({ ...request.details, ...(reason && reason !== request.message ? { reason } : {}) }) as Record<string, Json>
    }, withdrawn);
    return answer?.value as Decision | undefined;
  }

  /**
   * Requests can arrive concurrently (parallel tool calls). Each waits its turn here, unpersisted, and becomes the run's
   * pending request only when the earlier one is settled; one withdrawn or cancelled while waiting, or reaching its turn
   * after the turn ended, is refused without ever being shown.
   */
  private serialized<T>(withdrawn: AbortSignal, refuse: () => T, decide: () => Promise<T>): Promise<T> {
    const turn = this.callbacks.then(async () => {
      if (withdrawn.aborted || this.input.signal.aborted || this.finished) return refuse();
      return decide();
    });
    this.callbacks = turn.then(() => undefined, () => undefined);
    return turn;
  }

  /** Undefined when the run was cancelled or Codex withdrew the request. */
  private async ask(pending: Pending, withdrawn: AbortSignal): Promise<Answer | undefined> {
    try { return await this.input.wait(pending, withdrawn); }
    catch (error) {
      if (this.input.signal.aborted || withdrawn.aborted) return undefined;
      throw error;
    }
  }

  /** `<requestID>:<itemID>`, kept unique within the run when Codex asks about one item twice. */
  private pendingID(itemID: string): string {
    const base = `${this.input.prompt.requestID}:${itemID.slice(0, 100)}`;
    let id = base;
    for (let n = 2; this.pendingIDs.has(id); n++) id = `${base}:${n}`;
    this.pendingIDs.add(id);
    return id;
  }

  private stop(): void {
    this.interruptRequested = true;
    // Time for Codex to acknowledge the interrupt and then end the turn.
    this.timer = setTimeout(() => {
      this.resolve({ kind: "expired" });
      // drive() can still be awaiting initialize, a thread, or turn/start, before it awaits settled. Closing the
      // transport rejects those RPCs too; no late answer can advance the prompt. run() awaits the same close in finally.
      void this.connection?.close().catch(() => { /* observed by run()'s finally */ });
    }, 2 * this.input.stopTimeoutMs);
    // Before turn/start answers there is no turn to name; drive() interrupts it once there is.
    if (this.turnID !== undefined && this.connection) this.sendInterrupt(this.connection);
  }
  private sendInterrupt(connection: CodexConnection): void {
    this.interrupt = "pending";
    connection.request("turn/interrupt", { threadId: this.native.threadID!, turnId: this.turnID! }).then(
      () => { this.interrupt = "acknowledged"; },
      error => {
        this.interrupt = "failed";
        // A refused interrupt will not be confirmed: stop waiting (a completion already read still wins). A connection
        // that ended is reported by its termination, and an answer that could not be read leaves the deadline to decide.
        if (!(error instanceof CodexRequestError) || error.kind === "rejected" || error.kind === "not_sent") this.resolve({ kind: "expired" });
      }
    );
  }
  private resolve(settled: Settled): void {
    if (this.outcomeSettled) return;
    this.outcomeSettled = true;
    this.finished = true;
    this.settle(settled);
  }

  private diagnostic(diagnostic: CodexDiagnostic): void {
    this.diagnostics.push(diagnostic.message);
    if (this.diagnostics.length > 5) this.diagnostics.shift();
    if (this.turnID !== undefined || this.native.threadID !== null) {
      const method = diagnostic.annotations.method;
      if (typeof method === "string" && outcomeNotifications.has(method)) this.resolve({ kind: "malformed", diagnostic });
    }
  }

  private completed({ turn }: Completion): ProviderOutcome {
    const threadID = this.native.threadID!;
    const providerState = { threadID } satisfies CodexState;
    const ids = { threadID, turnID: turn.id };
    if (turn.status === "completed") {
      return { status: "completed", providerState, result: plain({
        text: this.messages.get(turn.id)?.text ?? itemsText(turn.items), ...ids,
        durationMs: turn.durationMs ?? null, tokenUsage: this.usage.get(turn.id) ?? null
      }) };
    }
    if (turn.status === "interrupted") {
      // Codex confirms the turn ended interrupted; only a runner stop makes that a cancellation.
      if (this.interruptRequested) return { status: "cancelled", providerState };
      return { status: "failed", providerState, error: { code: "codex_turn_interrupted", message: "Codex interrupted the turn without a runner cancellation", details: ids } };
    }
    if (turn.status === "failed") {
      const error = this.errors.get(turn.id) ?? turn.error ?? undefined;
      return { status: "failed", providerState, error: {
        code: errorCode(error?.codexErrorInfo), message: error?.additionalDetails?.trim() || error?.message || "Codex reported that the turn failed",
        details: plain({ ...ids, codexErrorInfo: error?.codexErrorInfo ?? null }) as Record<string, Json>
      } };
    }
    return this.uncertain({ code: "codex_malformed_message", message: `Codex reported the turn's end with status ${String(turn.status)}` });
  }

  private failed(code: string, message: string, details: Record<string, unknown>): ProviderOutcome {
    return { status: "failed", error: { code, message, details: plain(details) as Record<string, Json> } };
  }

  /** A failure before turn/start was sent: Codex never had the prompt. */
  private async notStarted(connection: CodexConnection, error: unknown): Promise<ProviderOutcome> {
    if (!(error instanceof CodexRequestError)) throw error;
    const details = { method: error.method, ...(error.rpcCode === undefined ? {} : { rpcCode: error.rpcCode }), threadID: this.native.threadID };
    if (error.kind === "rejected") {
      return this.failed(error.method === "thread/resume" ? "codex_resume_failed" : "codex_rejected", `Codex refused ${error.method}: ${error.message}`, details);
    }
    if (error.kind === "not_sent") return this.failed("codex_invalid_request", `The runner could not send ${error.method}: ${error.message}`, details);
    const lost = await this.lost(connection, error);
    return this.failed(lost.code, `${lost.message}; the prompt was not sent`, { ...details, ...lost.details });
  }

  /** Why the connection could not carry a request, with how the process ended when that is known shortly. */
  private async lost(connection: CodexConnection, error: unknown): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
    if (error instanceof CodexRequestError && error.kind === "malformed") {
      return { code: "codex_malformed_message", message: `Codex answered ${error.method} in a shape that could not be read`, details: { cause: error.message } };
    }
    const termination = this.termination ?? await Promise.race([connection.terminated, delay(250, undefined, { ref: false })]);
    if (termination && termination.code !== "closed") return { ...terminationCode(termination), details: terminationDetails(termination) };
    return { code: "codex_disconnected", message: "The Codex connection failed", details: { cause: error instanceof Error ? error.message : String(error) } };
  }

  private uncertain(reason: { code: string; message: string; details?: Record<string, unknown> }, cause?: unknown, termination?: CodexTermination): ProviderOutcome {
    const stopped = this.interruptRequested && reason.code !== "cancel_unconfirmed";
    const process = termination ?? (this.termination?.code === "closed" ? undefined : this.termination);
    return { status: "interrupted", error: {
      code: stopped ? "cancel_unconfirmed" : reason.code,
      message: stopped ? `${reason.message}; the stop was not confirmed` : reason.message,
      details: plain({
        threadID: this.native.threadID, turnID: this.turnID ?? null,
        ...(stopped ? { reason: reason.code } : {}),
        ...(this.interruptRequested ? { interrupt: this.interrupt ?? "pending" } : {}),
        ...reason.details,
        ...(process ? terminationDetails(process) : {}),
        ...(cause instanceof Error ? { cause: cause.message } : {}),
        ...(this.diagnostics.length ? { diagnostics: this.diagnostics } : {}),
        ...(!process?.stderr && this.connection?.stderr() ? { stderr: this.connection.stderr().slice(-2048) } : {})
      }) as Record<string, Json>
    } };
  }
}

function terminationCode(termination: CodexTermination): { code: string; message: string } {
  if (termination.code === "codex_malformed_message") return { code: "codex_malformed_message", message: "Codex sent output that is not a protocol message" };
  if (termination.code === "codex_exited") return { code: "codex_exited", message: "Codex exited before reporting this turn's end" };
  return { code: "codex_disconnected", message: "The Codex connection failed before reporting this turn's end" };
}
function terminationDetails(termination: CodexTermination): Record<string, unknown> {
  return {
    termination: termination.message,
    ...(termination.exitCode === undefined ? {} : { exitCode: termination.exitCode }),
    ...(termination.signal === undefined ? {} : { signal: termination.signal }),
    ...(termination.stderr ? { stderr: termination.stderr } : {})
  };
}

function approvalDecision(decision: Decision): "accept" | "acceptForSession" | "decline" {
  return decision === "allow" ? "accept" : decision === "allow_session" ? "acceptForSession" : "decline";
}
function sandboxPolicy(mode: CodexConfig["sandbox"]): RequestParams<"turn/start">["sandboxPolicy"] {
  if (mode === "read-only") return { type: "readOnly" };
  if (mode === "workspace-write") return { type: "workspaceWrite" };
  return { type: "dangerFullAccess" };
}
/** `codex_<info>` from Codex's error info, such as `codex_usage_limit_exceeded`. */
function errorCode(info: TurnError["codexErrorInfo"] | undefined): string {
  const name = typeof info === "string" ? info : info ? Object.keys(info)[0] : undefined;
  return name ? `codex_${name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}` : "codex_turn_failed";
}
function itemsText(items: Completion["turn"]["items"]): string {
  const messages = items.flatMap(item => item.type === "agentMessage" ? [item] : []);
  return (messages.findLast(item => item.phase === "final_answer") ?? messages.at(-1))?.text ?? "";
}
/** The same directory, allowing for symlinks (on macOS, /var is /private/var). */
function sameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); }
  catch { return false; }
}
