/*!
 * Claude Agent SDK helpers adapted from Enso's T3 Code fork ("agent-host").
 *
 * Source:   https://github.com/Enso-Team/agent-host (branch `enso`)
 * Revision: 322f6544dfad0a3c8a0c8cbecf2c7f7874b14268
 * File:     apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
 *   - claudeApprovalPresentation, permissionResultFromDecision, toSessionPermissionUpdates
 *   - summarizeClaudeToolRequest, firstStringInputField, jsonStringifyForTool, and the approval prompt choice in
 *     the adapter's canUseTool
 *   - claudeUserInputQuestions, claudeSdkUserInputAnswers, and the AskUserQuestion branch of canUseTool
 *   - resultUserFacingError, terminalResultError, isOverloadedResult, terminalStatusFromResult,
 *     providerFailureFromResult (failure text and code only)
 *   - claudeEchoedPromptUuids, isClaudeResultForOtherTurn, isClaudePromptUuid
 *   - makeClaudeQueryOptions (thread identity: `sessionId` for a new conversation, `resume` for an existing one)
 *   - CLAUDE_STOP_CONFIRM_TIMEOUT_MS from interruptTurn
 * The Effect runtime, orchestration events, rate-limit/usage handling, subagents and background tasks were not
 * taken; Enso-specific changes are marked "Enso:" below.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { stripVTControlCharacters } from "node:util";
import type { CanUseTool, Options, PermissionResult, PermissionUpdate, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Pending } from "./protocol.js";

/** How long a requested interrupt, and then the turn's end, may take before cancellation is reported unconfirmed. */
export const stopConfirmTimeoutMs = 10_000;

type CallbackOptions = Parameters<CanUseTool>[2];
export type PermissionDecision = "allow" | "allow_session" | "deny";
type Question = NonNullable<Pending["questions"]>[number];

function firstStringInputField(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
function jsonStringifyForTool(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}
function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const command = firstStringInputField(input, ["command", "cmd", "script"]);
  if (command !== undefined) return `${toolName}: ${command.slice(0, 400)}`;
  const path = firstStringInputField(input, ["file_path", "path", "filename", "fileName"]);
  if (path !== undefined) return `${toolName}: ${path.slice(0, 400)}`;
  const serialized = jsonStringifyForTool(input);
  return serialized.length <= 400 ? `${toolName}: ${serialized}` : `${toolName}: ${serialized.slice(0, 397)}...`;
}

/**
 * The approval text: the user approves the command itself; Claude's title and description only summarize it. The
 * reason can carry terminal escapes from the CLI's own prompt renderer.
 * Enso: choices are runner pending choices, and a session grant is withheld when the CLI suppresses "always allow".
 */
export function permissionRequest(toolName: string, input: Record<string, unknown>, options: CallbackOptions): { message: string; choices: PermissionDecision[]; reason?: string } {
  const command = input.command;
  const message = (typeof command === "string" && command.trim() !== "" ? command : undefined) ??
    options.title ?? options.description ?? options.decisionReason ?? summarizeToolRequest(toolName, input);
  const reason = stripVTControlCharacters(options.decisionReason ?? "").trim();
  return {
    message,
    choices: options.suppressAlwaysAllowRule === true ? ["allow", "deny"] : ["allow", "allow_session", "deny"],
    ...(reason === "" || reason === message ? {} : { reason })
  };
}

/** Enso: there is no `cancel` decision; the provider handles cancellation with its own deny-with-interrupt. */
export function permissionResultFromDecision(input: {
  toolName: string; decision: PermissionDecision; toolInput: Record<string, unknown>; toolUseID: string;
  suggestions?: PermissionUpdate[];
}): PermissionResult {
  if (input.decision === "allow" || input.decision === "allow_session") {
    return {
      behavior: "allow", updatedInput: input.toolInput, toolUseID: input.toolUseID,
      decisionClassification: input.decision === "allow_session" ? "user_permanent" : "user_temporary",
      ...(input.decision === "allow_session" ? { updatedPermissions: toSessionPermissionUpdates(input.toolName, input.suggestions) } : {})
    };
  }
  return { behavior: "deny", message: "User declined tool execution.", toolUseID: input.toolUseID, decisionClassification: "user_reject" };
}

function toSessionPermissionUpdates(toolName: string, suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  const updates = (suggestions ?? []).map((suggestion): PermissionUpdate => ({ ...suggestion, destination: "session" }));
  return updates.length > 0 ? updates : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
}

/**
 * AskUserQuestion input as runner questions.
 * Enso: option previews are dropped, and the id and question keep the untrimmed text the CLI expects as answer keys.
 */
export function userInputQuestions(input: unknown): Question[] {
  const questions = typeof input === "object" && input !== null ? Reflect.get(input, "questions") : undefined;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((value: unknown, index: number): Question[] => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question : "";
    if (question.trim().length === 0) return [];
    const header = typeof record.header === "string" && record.header.trim().length > 0 ? record.header.trim() : `Question ${index + 1}`;
    const options = Array.isArray(record.options) ? record.options.flatMap(option => {
      if (typeof option !== "object" || option === null) return [];
      const optionRecord = option as Record<string, unknown>;
      const label = typeof optionRecord.label === "string" ? optionRecord.label.trim() : "";
      if (label.length === 0) return [];
      const description = typeof optionRecord.description === "string" ? optionRecord.description.trim() : "";
      return [{ label, description: description || label }];
    }) : [];
    return [{ id: question, header, question, options, multiSelect: record.multiSelect === true }];
  });
}

/** Answers keyed by question text, as AskUserQuestion's `answers` input expects. */
export function sdkUserInputAnswers(answers: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, Array.isArray(answer) ? answer.join(", ") : answer]));
}

/** Exclude CLI-internal "[ede_diagnostic] ..." telemetry from error text. */
function resultUserFacingError(result: SDKResultMessage): string | undefined {
  if (result.subtype === "success" && !result.is_error) return undefined;
  const errors = "errors" in result && Array.isArray(result.errors) ? result.errors : [];
  return errors.find((error): error is string => typeof error === "string" && !error.startsWith("[ede_diagnostic]"));
}

const contextWindowFull = "Claude stopped: the prompt exceeds the model's context window. Start a new conversation or compact it.";
function terminalResultError(reason: SDKResultMessage["terminal_reason"]): string | undefined {
  switch (reason) {
    case "api_error": return "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted": return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted": return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted": return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable": return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed": return "Claude could not start the turn.";
    case "blocking_limit": return contextWindowFull;
    case "rapid_refill_breaker": return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long": return contextWindowFull;
    case "image_error": return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error": return "Claude stopped: the model returned an error.";
    default: return undefined;
  }
}
const isOverloadedResult = (result: SDKResultMessage) => result.subtype === "success" && result.api_error_status === 529;
const isAbortResult = (result: SDKResultMessage) => result.terminal_reason === "aborted_tools" || result.terminal_reason === "aborted_streaming";

export type ResultOutcome =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; error: { code: string; message: string } };
/**
 * The confirmed outcome a result frame proves. The SDK can report API failures as subtype "success" with is_error set,
 * and explicit abort reasons override success envelopes.
 * Enso: an abort or error_during_execution is a confirmed cancellation only when the runner requested the interrupt;
 * otherwise the turn's end is confirmed but it failed. The fork reports such turns `interrupted`, which in the runner
 * would mean uncertain. Usage-limit and rate-limit evidence beyond the result frame is not tracked.
 */
export function resultOutcome(result: SDKResultMessage, interruptRequested: boolean): ResultOutcome {
  if (isAbortResult(result) || result.subtype === "error_during_execution") {
    if (interruptRequested) return { status: "cancelled" };
    if (isAbortResult(result)) return { status: "failed", error: { code: result.terminal_reason!, message: "Claude aborted the turn without a runner cancellation" } };
  }
  if (result.subtype === "success") {
    const structured = isOverloadedResult(result) ? "Claude API is overloaded (529). Try again shortly." :
      result.api_error_status === 429 ? "Claude API rate limit reached. Try again later." : terminalResultError(result.terminal_reason);
    if (!result.is_error && structured === undefined) return { status: "completed" };
    const status = result.api_error_status ?? null;
    return { status: "failed", error: {
      code: status === null ? result.terminal_reason ?? "sdk_result_error" : `api_error_${status}`,
      message: (resultUserFacingError(result) ?? structured ?? result.result) || "Claude reported an error"
    } };
  }
  return { status: "failed", error: {
    code: result.subtype,
    message: resultUserFacingError(result) ?? terminalResultError(result.terminal_reason) ?? (result.errors.join("\n") || "Claude stopped with an error")
  } };
}

/**
 * Enso: whether the CLI refused to resume `conversationID` because its transcript no longer exists. The CLI reports
 * this as an error result before running anything, with its own wording as the only marker.
 */
export function isConversationNotFound(result: SDKResultMessage, conversationID: string): boolean {
  return result.subtype === "error_during_execution" && result.num_turns === 0 &&
    result.errors.includes(`No conversation found with session ID: ${conversationID}`);
}

/** Enso: whether the SDK failed to start Claude Code at all (missing or unexecutable binary). */
export function isLaunchError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "EACCES") return true;
  // SDK 0.3.318 throws this plain Error from query(), before spawning, when its optional platform package is absent.
  return error instanceof Error && /^Native CLI binary for [\w-]+ not found\. Reinstall @anthropic-ai\/claude-agent-sdk without --omit=optional, or set options\.pathToClaudeCodeExecutable\.$/.test(error.message);
}

/**
 * Whether a result frame answers another turn than the prompt this query sent. The CLI echoes the client prompt uuid;
 * without an echo, a non-human origin (a background task notification) marks another turn.
 * Enso: one prompt per query, so the fork's echo-mode tracking is replaced by always honoring the origin.
 */
export function isResultForOtherTurn(result: SDKResultMessage, promptUUID: string): boolean {
  const uuids = Reflect.get(result, "user_message_uuids");
  const uuid = Reflect.get(result, "user_message_uuid");
  const echoed = Array.isArray(uuids) ? uuids.filter((value): value is string => typeof value === "string") : typeof uuid === "string" ? [uuid] : [];
  if (echoed.length > 0) return !echoed.includes(promptUUID);
  return result.origin !== undefined && result.origin.kind !== "human";
}

export function isPromptUUID(value: string): value is `${string}-${string}-${string}-${string}-${string}` {
  return /^[^-]+-[^-]+-[^-]+-[^-]+-[^-]+$/.test(value);
}

/** A new conversation takes the preallocated id as `sessionId`; an existing one is resumed by it. */
export function conversationOptions(conversationID: string, resume: boolean): Pick<Options, "sessionId" | "resume"> {
  return resume ? { resume: conversationID } : { sessionId: conversationID };
}

/** The conversation id a frame reports, if any. */
export function messageSessionID(message: SDKMessage): string | undefined {
  const value = Reflect.get(message, "session_id");
  return typeof value === "string" ? value : undefined;
}
