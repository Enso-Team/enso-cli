import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { CanUseTool, Options, PermissionResult, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { EnsoCliError } from "../errors.js";
import { cliVersion } from "../version.js";
import { conversationOptions, isPromptUUID, isResultForOtherTurn, messageSessionID, permissionRequest, permissionResultFromDecision, resultOutcome, sdkUserInputAnswers, stopConfirmTimeoutMs, userInputQuestions, type PermissionDecision } from "./claude-sdk.js";
import type { Answer, Json, Pending, Prompt, Session } from "./protocol.js";
import type { Execution, ProviderOutcome, RunnerProvider } from "./provider.js";

/** The part of the SDK's `query()` the provider uses; tests replace it with a scripted exchange. */
export type ClaudeQueryHandle = AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };
export type ClaudeQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQueryHandle;
export const claudePermissionModes = ["default", "acceptEdits", "plan", "auto"] as const;
export type ClaudeConfig = {
  model?: string;
  /** Always passed explicitly: left out, the CLI may pick a mode that never asks through the runner. */
  permissionMode: (typeof claudePermissionModes)[number];
  /** A Claude Code executable to use instead of the SDK's bundled one. */
  executable?: string;
};
/** The session's conversation checkpoint. */
export type ClaudeState = { conversationID: string };
/** Recorded on the run before the query starts. */
export type ClaudeNative = { conversationID: string; resume: boolean; promptUUID: string; model: string | null; permissionMode: ClaudeConfig["permissionMode"] };

/** Child processes inherit this; the `enso` CLI refuses bridge requests while it is set (see src/client.ts). */
export const runnerBridgeEnv = "ENSO_RUNNER_BRIDGE";
const instructions = [
  "You are running for Enso's local runner, on behalf of a user working on an Enso canvas.",
  "The selected canvas nodes in the prompt were captured when the prompt was submitted; treat them as the selection.",
  "The Enso app bridge is not available to this session: do not use the `enso` CLI or the app's HTTP bridge to read or change canvases."
].join(" ");
const detailsLimit = 32 * 1024;
const stderrTail = 2048;

export async function loadClaudeQuery(): Promise<ClaudeQuery> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return sdk.query as ClaudeQuery;
  } catch (error) {
    throw claudeLoadError(error);
  }
}

/** Only the package itself missing means it was omitted; a missing dependency of it, or a throw while loading, is reported with its cause. */
export function claudeLoadError(error: unknown): EnsoCliError {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if ((code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && /['"]@anthropic-ai\/claude-agent-sdk['"]/.test(message)) {
    return new EnsoCliError("runner_provider_unavailable", "The Claude provider needs the optional @anthropic-ai/claude-agent-sdk package; reinstall the CLI without omitting optional dependencies");
  }
  return new EnsoCliError("runner_provider_unavailable", "The Claude provider's @anthropic-ai/claude-agent-sdk package failed to load", { cause: message });
}

/**
 * Runs one runner prompt as one Claude Agent SDK query in the session's stored working directory. Permission and
 * AskUserQuestion callbacks become runner pending requests, one at a time. Outcomes come only from provider evidence:
 * the result frame answering this prompt, or a cancellation the CLI confirmed. A stream that ends or fails without that
 * evidence, or a stop that is not confirmed in time, is interrupted (uncertain).
 */
export class ClaudeProvider implements RunnerProvider {
  readonly name = "claude" as const;
  constructor(
    private readonly query: ClaudeQuery,
    private readonly config: ClaudeConfig = { permissionMode: "default" },
    private readonly options: { stopTimeoutMs?: number; newID?: () => string } = {}
  ) {}

  async execute({ session, prompt, signal, record, wait }: Execution): Promise<ProviderOutcome> {
    const cwd = session.binding.workingDirectory;
    try { if (!statSync(cwd).isDirectory()) throw new Error(); }
    catch { return { status: "failed", error: { code: "working_directory_unavailable", message: "The session's working directory no longer exists; the runner does not substitute another", details: { workingDirectory: cwd } } }; }
    // Nothing has started yet, so stopping here is a confirmed cancellation.
    if (signal.aborted) return { status: "cancelled" };
    const newID = this.options.newID ?? randomUUID;
    const { conversationID, resume } = this.conversation(session, prompt, newID);
    const promptUUID = newID();
    if (!isPromptUUID(promptUUID)) throw new Error("Claude prompt uuids must be UUIDs");
    const native: ClaudeNative = { conversationID, resume, promptUUID, model: this.config.model ?? null, permissionMode: this.config.permissionMode };
    // Durable before the query can create or advance the conversation under these identifiers.
    record(native);
    return new Turn(this.query, this.config, { cwd, conversationID, resume, promptUUID, prompt, signal, wait, stopTimeoutMs: this.options.stopTimeoutMs ?? stopConfirmTimeoutMs }).run();
  }

  /**
   * Which conversation this prompt continues. An uncertain session continues only as its prompt's recovery says:
   * `fresh` starts a new conversation; `resume` continues the one the uncertain run recorded (or the checkpoint, when
   * that run recorded nothing and so never started a query).
   */
  private conversation(session: Readonly<Session>, prompt: Readonly<Prompt>, newID: () => string): { conversationID: string; resume: boolean } {
    const state = conversationOf(session.providerState);
    if (session.uncertain) {
      if (prompt.recovery?.mode !== "resume") return { conversationID: newID(), resume: false };
      const recorded = conversationOf(session.uncertain.native);
      if (recorded) return { conversationID: recorded, resume: true };
    }
    return state ? { conversationID: state, resume: true } : { conversationID: newID(), resume: false };
  }
}

function conversationOf(value: Json | undefined): string | undefined {
  const id = value && typeof value === "object" && !Array.isArray(value) ? value.conversationID : undefined;
  return typeof id === "string" ? id : undefined;
}

type TurnInput = {
  cwd: string; conversationID: string; resume: boolean; promptUUID: string; prompt: Readonly<Prompt>;
  signal: AbortSignal; wait: Execution["wait"]; stopTimeoutMs: number;
};

class Turn {
  private interruptRequested = false;
  private interrupt: "pending" | "acknowledged" | "failed" | undefined;
  private sawConversation = false;
  private stderr = "";
  /** Serializes callbacks: the runner keeps one pending request per run. */
  private callbacks = Promise.resolve();
  constructor(private readonly query: ClaudeQuery, private readonly config: ClaudeConfig, private readonly input: TurnInput) {}

  async run(): Promise<ProviderOutcome> {
    const { signal, stopTimeoutMs } = this.input;
    let endInput!: () => void;
    const inputEnded = new Promise<void>(resolve => { endInput = resolve; });
    const message = this.message();
    const handle = this.query({
      prompt: (async function* () { yield message; await inputEnded; })(),
      options: this.options()
    });
    const iterator = handle[Symbol.asyncIterator]();
    let expire!: () => void;
    const expired = new Promise<"expired">(resolve => { expire = () => resolve("expired"); });
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
      this.interruptRequested = true;
      this.interrupt = "pending";
      // A refused interrupt will not be confirmed: stop waiting.
      handle.interrupt().then(() => { this.interrupt = "acknowledged"; }, () => { this.interrupt = "failed"; expire(); });
      // Time for the CLI to acknowledge the interrupt and then end the turn.
      timer = setTimeout(expire, 2 * stopTimeoutMs);
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        let step: IteratorResult<SDKMessage> | "expired";
        try { step = await Promise.race([iterator.next(), expired]); }
        catch (error) { return this.uncertain("claude_disconnected", "The Claude stream failed before reporting this turn's result", error); }
        if (step === "expired") return this.uncertain("cancel_unconfirmed", "Claude did not confirm the stop in time; it may still be running or have finished");
        if (step.done) return this.uncertain("claude_ended_without_result", "The Claude stream ended before reporting this turn's result");
        const frame = step.value;
        if (messageSessionID(frame) === this.input.conversationID) this.sawConversation = true;
        if (frame.type !== "result" || isResultForOtherTurn(frame, this.input.promptUUID)) continue;
        const outcome = this.outcome(frame);
        // Let the CLI finish writing the conversation and exit on end of input before it is closed.
        endInput();
        await Promise.race([drain(iterator), new Promise(resolve => setTimeout(resolve, stopTimeoutMs).unref())]);
        return outcome;
      }
    } finally {
      signal.removeEventListener("abort", stop);
      clearTimeout(timer);
      endInput();
      handle.close();
    }
  }

  private outcome(result: SDKResultMessage): ProviderOutcome {
    const decided = resultOutcome(result, this.interruptRequested);
    const conversationID = result.session_id || this.input.conversationID;
    const providerState = { conversationID };
    if (decided.status === "completed") {
      return { status: "completed", providerState, result: plain({
        text: result.subtype === "success" ? result.result : "",
        conversationID, promptUUID: this.input.promptUUID,
        numTurns: result.num_turns, durationMs: result.duration_ms, totalCostUSD: result.total_cost_usd,
        stopReason: result.stop_reason, terminalReason: result.terminal_reason ?? null,
        // A denied tool is part of the turn, not its failure.
        permissionDenials: result.permission_denials.map(denial => ({ toolName: denial.tool_name, toolUseID: denial.tool_use_id }))
      }) };
    }
    // A confirmed end still leaves a conversation to continue once the CLI has reported it.
    const checkpoint = this.sawConversation ? { providerState } : {};
    if (decided.status === "cancelled") return { status: "cancelled", ...checkpoint };
    return { status: "failed", error: { ...decided.error, details: { conversationID, promptUUID: this.input.promptUUID } }, ...checkpoint };
  }

  private uncertain(code: string, message: string, cause?: unknown): ProviderOutcome {
    const interrupt = this.interruptRequested ? { interrupt: this.interrupt ?? "pending" } : {};
    return { status: "interrupted", error: {
      code: this.interruptRequested && code !== "cancel_unconfirmed" ? "cancel_unconfirmed" : code,
      message: this.interruptRequested && code !== "cancel_unconfirmed" ? `${message}; the stop was not confirmed` : message,
      details: plain({
        conversationID: this.input.conversationID, promptUUID: this.input.promptUUID, ...interrupt,
        ...(cause instanceof Error ? { cause: cause.message } : {}),
        ...(this.stderr ? { stderr: this.stderr } : {})
      }) as Record<string, Json>
    } };
  }

  private options(): Options {
    const canUseTool: CanUseTool = (toolName, toolInput, options) => this.serialized(options.signal, () => this.decide(toolName, toolInput, options));
    return {
      cwd: this.input.cwd,
      ...conversationOptions(this.input.conversationID, this.input.resume),
      permissionMode: this.config.permissionMode,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.executable ? { pathToClaudeCodeExecutable: this.config.executable } : {}),
      canUseTool,
      systemPrompt: { type: "preset", preset: "claude_code", append: instructions },
      env: { ...process.env, [runnerBridgeEnv]: "disabled", CLAUDE_AGENT_SDK_CLIENT_APP: `enso-cli/${cliVersion}` },
      stderr: data => { this.stderr = (this.stderr + data).slice(-stderrTail); }
    };
  }

  /** The captured prompt and selection, as submitted except for escaped framing tags; nothing is reread from the canvas. */
  private message(): SDKUserMessage {
    const { text, context } = this.input.prompt;
    const nodes = context.selectedNodes.map(node => {
      const attributes = `node_id=${JSON.stringify(node.nodeID)}${node.noteID === undefined ? "" : ` note_id=${JSON.stringify(node.noteID)}`}`;
      // Content cannot close its node or open another; nothing else in it is escaped.
      const content = node.content.replace(/<(\/?enso_node)/gi, "&lt;$1");
      return `<enso_node ${attributes}>\n${content}\n</enso_node>`;
    });
    const selection = nodes.length ? [{ type: "text" as const, text: `Selected Enso canvas nodes, captured when this prompt was submitted:\n\n${nodes.join("\n\n")}` }] : [];
    return {
      type: "user", parent_tool_use_id: null, uuid: this.input.promptUUID as SDKUserMessage["uuid"],
      message: { role: "user", content: [...selection, { type: "text", text }] }
    };
  }

  /**
   * Callbacks can arrive concurrently (parallel tool calls). Each waits its turn here, unpersisted, and becomes the
   * run's pending request only when the earlier one is settled; a callback withdrawn or cancelled while waiting is
   * denied without ever being shown.
   */
  private serialized(withdrawn: AbortSignal, decide: () => Promise<PermissionResult>): Promise<PermissionResult> {
    const turn = this.callbacks.then(async () => {
      if (withdrawn.aborted || this.input.signal.aborted) return cancelled();
      return decide();
    });
    this.callbacks = turn.then(() => undefined, () => undefined);
    return turn;
  }

  private async decide(toolName: string, toolInput: Record<string, unknown>, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const id = `${this.input.prompt.requestID}:${options.toolUseID}`;
    const details = { toolName, toolUseID: options.toolUseID, ...(options.agentID ? { agentID: options.agentID } : {}), ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}) };
    if (toolName === "AskUserQuestion") {
      const questions = userInputQuestions(toolInput);
      if (!questions.length) return { behavior: "allow", updatedInput: toolInput, toolUseID: options.toolUseID };
      const answer = await this.ask({ id, kind: "input", message: questions.map(question => question.question).join("\n"), questions, details }, options.signal);
      if (!answer) return cancelled(options.toolUseID);
      const answers = typeof answer.value === "string" ? { [questions[0].id]: answer.value } : answer.value;
      return { behavior: "allow", toolUseID: options.toolUseID, updatedInput: { questions: toolInput.questions, answers: sdkUserInputAnswers(answers) } };
    }
    const request = permissionRequest(toolName, toolInput, options);
    const answer = await this.ask({
      id, kind: "permission", message: request.message, choices: request.choices,
      details: { ...details, ...(request.reason ? { reason: request.reason } : {}), input: bounded(toolInput) }
    }, options.signal);
    if (!answer) return cancelled(options.toolUseID);
    return permissionResultFromDecision({
      toolName, decision: answer.value as PermissionDecision, toolInput, toolUseID: options.toolUseID,
      ...(options.suggestions ? { suggestions: options.suggestions } : {})
    });
  }

  /** Undefined when the run was cancelled or the CLI withdrew the request. */
  private async ask(pending: Pending, withdrawn: AbortSignal): Promise<Answer | undefined> {
    try { return await this.input.wait(pending, withdrawn); }
    catch (error) {
      if (this.input.signal.aborted || withdrawn.aborted) return undefined;
      throw error;
    }
  }
}

function cancelled(toolUseID?: string): PermissionResult {
  return { behavior: "deny", message: "User cancelled tool execution.", interrupt: true, decisionClassification: "user_reject", ...(toolUseID ? { toolUseID } : {}) };
}
/** JSON as JSON.stringify writes it: drops undefined and non-plain values. */
function plain(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
function bounded(value: Record<string, unknown>): Json {
  const text = JSON.stringify(value) ?? "{}";
  return text.length <= detailsLimit ? JSON.parse(text) as Json : { truncated: true, preview: text.slice(0, 1024) };
}
async function drain(iterator: AsyncIterator<SDKMessage>): Promise<void> {
  try { while (!(await iterator.next()).done) { /* the outcome is decided */ } } catch { /* likewise */ }
}
