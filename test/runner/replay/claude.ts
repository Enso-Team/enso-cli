/*!
 * The Claude Agent SDK side of a replay, adapted from Enso's T3 Code fork ("agent-host").
 *
 * Source:   https://github.com/Enso-Team/agent-host (branch `enso`)
 * Revision: 322f6544dfad0a3c8a0c8cbecf2c7f7874b14268
 * File:     apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts
 *   - makeReplayQueryRunner: query.open and prompt.offer frames, permission.request entries invoking canUseTool with
 *     the recorded options and expecting the permission.response, query.interrupt, prompt uuid rewriting of
 *     user_message_uuid(s) echoes, and the SDK message type check (isClaudeSdkReplayMessage)
 * Enso: the boundary is `ClaudeQuery` (src/runner/claude.ts) rather than the fork's query runner service. query.open
 * pins the options the runner sets; close() is an expected outbound `query.close`; a permission.request does not block
 * the stream, so concurrent callbacks can be replayed, and `permission.withdraw` aborts one from the CLI side; a
 * `runtime_exit` with status error fails the stream rather than the replay; responses after close are dropped, as the
 * SDK cannot deliver them; several transcripts can play at once, one per conversation, routed by their query.open.
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
import { join } from "node:path";
import type { CanUseTool, Options, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery, ClaudeQueryHandle } from "../../../src/runner/claude.js";
import { runnerBridgeEnv } from "../../../src/runner/claude.js";
import { materializeWorkspace, readTranscript, Replay, ReplayError, sameFrame, type Transcript } from "./transcript.js";

export const claudeProtocol = "claude-agent-sdk.query";
const fixtures = join(import.meta.dirname, "..", "fixtures");

/** A Claude transcript by name: recorded ones (adapted from agent-host) first, then Enso-authored ones. */
export function claudeTranscript(name: string, workspace: string): Transcript {
  let transcript: Transcript | undefined;
  for (const directory of ["agent-host", "claude"]) {
    try { transcript = readTranscript(join(fixtures, directory, `${name}.ndjson`)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!transcript) throw new Error(`No Claude replay transcript named ${name}`);
  if (transcript.provider !== "claude" || transcript.protocol !== claudeProtocol) {
    throw new Error(`${name} is a ${transcript.provider}/${transcript.protocol} transcript, not claude/${claudeProtocol}`);
  }
  return materializeWorkspace(transcript, workspace);
}

/** The prompt a transcript was recorded for, as a runner submission carries it. */
export type RecordedPrompt = { text: string; context: { selectedNodes: { nodeID: string; noteID?: string; content: string }[] } };
export function recordedPrompts(transcript: Transcript): RecordedPrompt[] {
  return (transcript.metadata.prompts as RecordedPrompt[] | undefined) ?? [];
}
export function nativeSessionID(transcript: Transcript): string {
  const id = transcript.metadata.nativeSessionId;
  if (typeof id !== "string") throw new Error(`${transcript.scenario} records no nativeSessionId`);
  return id;
}

/** The query options a transcript pins: conversation identity, directory, permission mode, model and agent environment. */
function openFrame(options: Options) {
  const systemPrompt = options.systemPrompt;
  return { type: "query.open", options: {
    cwd: options.cwd,
    ...(options.resume !== undefined ? { resume: options.resume } : { sessionId: options.sessionId }),
    permissionMode: options.permissionMode,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.pathToClaudeCodeExecutable !== undefined ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {}),
    systemPrompt: typeof systemPrompt === "object" && !Array.isArray(systemPrompt) && systemPrompt !== null && "preset" in systemPrompt ? { type: systemPrompt.type, preset: systemPrompt.preset } : systemPrompt,
    env: { [runnerBridgeEnv]: options.env?.[runnerBridgeEnv] }
  } };
}

type Frame = Record<string, unknown>;
const record = (value: unknown): Frame => (typeof value === "object" && value !== null ? value : {}) as Frame;
function offeredUUID(frame: unknown): string | undefined {
  const uuid = record(record(frame).message).uuid;
  return typeof uuid === "string" ? uuid : undefined;
}
function withoutUUID(frame: unknown): unknown {
  const { uuid: _, ...message } = record(record(frame).message);
  return { ...record(frame), message };
}
const sdkMessageTypes = new Set(["assistant", "user", "result", "system", "stream_event", "rate_limit_event", "command_lifecycle"]);

type Interrupt = { status: "acknowledged" } | { status: "rejected"; error?: string } | { status: "unanswered" };
export type ClaudeReplayQuery = {
  replay: Replay; options: Options; prompt?: SDKUserMessage; interrupts: number; closed: boolean;
  /** Callback responses the provider produced after close(), which the SDK could no longer deliver. */
  dropped: unknown[];
};

/**
 * A stand-in for the SDK's `query()` that plays transcripts: each query must open as the next expected `query.open` of
 * one of them, and from then on its stream, callbacks, interrupt and close follow that transcript's entries. Nothing is
 * spawned and no model is called.
 */
export function claudeReplay(transcripts: Transcript | Transcript[]) {
  const replays = (Array.isArray(transcripts) ? transcripts : [transcripts]).map(transcript => new Replay(transcript));
  const queries: ClaudeReplayQuery[] = [];

  function route(frame: unknown): Replay {
    const opening = replays.filter(replay => !replay.failure && replay.entry?.type === "expect_outbound" && record(replay.entry.frame).type === "query.open");
    const replay = opening.find(candidate => sameFrame(candidate.entry!.type === "expect_outbound" ? candidate.entry!.frame : undefined, frame)) ??
      opening[0] ?? replays.find(candidate => !candidate.done) ?? replays[0];
    replay.expect(frame);
    return replay;
  }

  const query: ClaudeQuery = ({ prompt, options }) => {
    const replay = route(openFrame(options));
    const state: ClaudeReplayQuery = { replay, options, interrupts: 0, closed: false, dropped: [] };
    queries.push(state);
    const stop = new AbortController();
    const callbacks = new Map<string, AbortController>();
    // Prompt uuids are the provider's own; recorded echoes of the transcript's uuid are rewritten to them.
    const uuids = new Map<string, string>();

    void (async () => {
      const first = await prompt[Symbol.asyncIterator]().next();
      if (first.done) return replay.fail(new ReplayError("driver", replay.scenario, replay.cursor, { message: "the provider ended its input without offering a prompt" }));
      state.prompt = first.value;
      const actual = { type: "prompt.offer", message: first.value };
      replay.expect(actual, (expected, offered) => {
        const expectedUUID = offeredUUID(expected), actualUUID = offeredUUID(offered);
        if (!sameFrame(withoutUUID(expected), withoutUUID(offered)) || (expectedUUID !== undefined && actualUUID === undefined)) return false;
        if (expectedUUID !== undefined) uuids.set(expectedUUID, actualUUID!);
        return true;
      });
    })().catch(() => { /* recorded on the replay; complete() reports it */ });

    const echo = (frame: Frame): Frame => {
      const map = (value: unknown) => typeof value === "string" ? uuids.get(value) ?? value : value;
      return {
        ...frame,
        ...(typeof frame.user_message_uuid === "string" ? { user_message_uuid: map(frame.user_message_uuid) } : {}),
        ...(Array.isArray(frame.user_message_uuids) ? { user_message_uuids: frame.user_message_uuids.map(map) } : {})
      };
    };
    const respond = (frame: unknown) => {
      if (state.closed) { state.dropped.push(frame); return; }
      try { replay.expect(frame); } catch { /* recorded on the replay */ }
    };
    const request = (frame: Frame) => {
      const canUseTool: CanUseTool | undefined = options.canUseTool;
      const recorded = record(frame.options) as Parameters<CanUseTool>[2] & { toolUseID: string };
      if (!canUseTool) return replay.fail(new ReplayError("driver", replay.scenario, replay.cursor - 1, { message: "the provider set no canUseTool callback for a permission request" }));
      const controller = new AbortController();
      callbacks.set(recorded.toolUseID, controller);
      let result: Promise<PermissionResult | null>;
      try { result = Promise.resolve(canUseTool(frame.toolName as string, record(frame.input), { ...recorded, signal: controller.signal, requestId: recorded.toolUseID })); }
      catch (error) { result = Promise.reject(error); }
      result.then(
        decision => respond({ type: "permission.response", result: decision }),
        error => respond({ type: "permission.error", message: error instanceof Error ? error.message : String(error) })
      );
    };

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      for (;;) {
        if (state.closed) return;
        replay.throwIfFailed();
        const entry = replay.entry;
        if (!entry) return;
        if (entry.type === "expect_outbound") { await replay.advanced(stop.signal); continue; }
        const taken = await replay.take(stop.signal);
        if (!taken || state.closed) return;
        if (taken.type === "runtime_exit") {
          if (taken.status === "error") throw new Error(taken.error ?? "Claude Code exited with an error");
          return;
        }
        const frame = record(taken.frame);
        if (frame.type === "permission.request") request(frame);
        else if (frame.type === "permission.withdraw") callbacks.get(frame.toolUseID as string)?.abort();
        else if (!sdkMessageTypes.has(frame.type as string)) {
          replay.fail(new ReplayError("driver", replay.scenario, replay.cursor - 1, { label: taken.label, message: "not a Claude Agent SDK message", actual: frame }));
        } else yield echo(frame) as unknown as SDKMessage;
      }
    }
    const stream = messages();

    const handle: ClaudeQueryHandle = {
      [Symbol.asyncIterator]: () => stream,
      interrupt: () => {
        state.interrupts++;
        let reply: Interrupt;
        try { reply = (replay.expect({ type: "query.interrupt" }).reply ?? { status: "acknowledged" }) as Interrupt; }
        catch (error) { return Promise.reject(error); }
        if (reply.status === "rejected") return Promise.reject(new Error(reply.error ?? "Claude Code refused the interrupt"));
        if (reply.status === "unanswered") return new Promise(() => {});
        return Promise.resolve({});
      },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        // Closing the query cancels the CLI's open callbacks, as the SDK does.
        for (const controller of callbacks.values()) controller.abort();
        stop.abort();
        try { replay.expect({ type: "query.close" }); } catch { /* recorded on the replay */ }
      }
    };
    return handle;
  };

  return {
    query, queries, replays,
    /** Throws the first divergence of any transcript, or the first one with entries never played. */
    complete(): void { for (const replay of replays) replay.complete(); }
  };
}
export type ClaudeReplay = ReturnType<typeof claudeReplay>;
