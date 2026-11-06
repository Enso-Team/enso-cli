/*!
 * The Codex app-server side of a replay, adapted from Enso's T3 Code fork ("agent-host").
 *
 * Source:   https://github.com/Enso-Team/agent-host (branch `enso`)
 * Revision: 322f6544dfad0a3c8a0c8cbecf2c7f7874b14268
 * File:     packages/effect-codex-app-server/src/replay.ts
 *   - makeReplayClientWithState: outbound JSONL is split into lines, parsed and matched against the next expected
 *     frame; inbound entries are written to the client's input as JSONL until playback reaches an expected outbound
 *     frame; runtime_exit success ends the input stream and runtime_exit error fails it
 * Enso: playback happens at the process boundary (`CodexSpawn`, src/runner/codex-connection.ts), under the real
 * transport and the vendored client, rather than in place of the client. A process starts as the next expected
 * `process.spawn`, and closing its stdin is the expected `stdin.close`; a kill is the expected `process.kill`; an exit
 * error writes its message to stderr and exits with code 1; a string frame is written as a raw line (malformed
 * output); writes after the process exited are dropped, as a dead process drops them. Frames are compared exactly
 * through the shared `Replay` cursor rather than normalized, and `<workspace>` (both directions), `<cli-version>` and
 * `<runner-instructions>` are materialized per test.
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
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runnerBridgeEnv, runnerInstructions } from "../../../src/runner/agent-context.js";
import { connectCodex } from "../../../src/runner/codex-app-server.js";
import type { CodexChild, CodexConnect, CodexSpawn } from "../../../src/runner/codex-connection.js";
import { cliVersion } from "../../../src/version.js";
import { readTranscript, Replay, ReplayError, sameFrame, type Entry, type Transcript } from "./transcript.js";

export const codexProtocol = "codex.app-server";
const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));

/** A Codex transcript by name: recorded ones (adapted from agent-host) first, then Enso-authored ones. */
export function codexTranscript(name: string, workspace: string): Transcript {
  let transcript: Transcript | undefined;
  for (const directory of [join("agent-host", "codex"), "codex"]) {
    try { transcript = readTranscript(join(fixtures, directory, `${name}.ndjson`)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!transcript) throw new Error(`No Codex replay transcript named ${name}`);
  if (transcript.provider !== "codex" || transcript.protocol !== codexProtocol) {
    throw new Error(`${name} is a ${transcript.provider}/${transcript.protocol} transcript, not codex/${codexProtocol}`);
  }
  return materialize(transcript, workspace);
}

/** Substitutes the placeholders a transcript may hold, in both directions: a recorded workspace path is the test's. */
export function materialize(transcript: Transcript, workspace: string): Transcript {
  const values: Record<string, string> = { "<workspace>": workspace, "<cli-version>": cliVersion, "<runner-instructions>": runnerInstructions };
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") return values[value] ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
  };
  return { ...transcript, entries: transcript.entries.map(entry => entry.type === "runtime_exit" ? entry : { ...entry, frame: replace(entry.frame) }) };
}

export type RecordedPrompt = { text: string; context: { selectedNodes: { nodeID: string; noteID?: string; content: string }[] } };
export function recordedPrompts(transcript: Transcript): RecordedPrompt[] {
  return (transcript.metadata.prompts as RecordedPrompt[] | undefined) ?? [];
}
export function threadID(transcript: Transcript): string {
  const id = transcript.metadata.threadID;
  if (typeof id !== "string") throw new Error(`${transcript.scenario} records no threadID`);
  return id;
}

type Frame = Record<string, unknown>;
const record = (value: unknown): Frame => (typeof value === "object" && value !== null ? value : {}) as Frame;
const spawnFrame = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => ({
  type: "process.spawn", command, args: [...args], cwd, env: { [runnerBridgeEnv]: env[runnerBridgeEnv] }
});

export type CodexReplayProcess = {
  replay: Replay; pid: number; cwd: string; env: NodeJS.ProcessEnv;
  /** Every frame the provider wrote, parsed, in order. */
  written: unknown[];
  /** Writes after the process exited, which a real process would never read. */
  dropped: unknown[];
  signals: NodeJS.Signals[];
  exited: boolean;
};

let pids = 40_000;

/**
 * A stand-in for spawning `codex app-server` that plays transcripts: each process must start as the next expected
 * `process.spawn` of one of them, and from then on its stdin, stdout, stderr, kill and exit follow that transcript's
 * entries. The provider talks to it through the real transport (src/runner/codex-app-server.ts) and the vendored
 * client, so their framing, routing and decoding are under test too. Nothing is spawned and no model is called.
 */
export function codexReplay(transcripts: Transcript | Transcript[]) {
  const replays = (Array.isArray(transcripts) ? transcripts : [transcripts]).map(transcript => new Replay(transcript));
  const processes: CodexReplayProcess[] = [];

  function route(frame: unknown): Replay {
    const opening = replays.filter(replay => !replay.failure && replay.entry?.type === "expect_outbound" && record(replay.entry.frame).type === "process.spawn");
    const replay = opening.find(candidate => sameFrame(candidate.entry!.type === "expect_outbound" ? candidate.entry!.frame : undefined, frame)) ??
      opening[0] ?? replays.find(candidate => !candidate.done) ?? replays[0];
    replay.expect(frame);
    return replay;
  }

  const spawn: CodexSpawn = (command, args, { cwd, env }) => {
    const events = new EventEmitter();
    const stdout = new PassThrough(), stderr = new PassThrough();
    const stop = new AbortController();
    let replay: Replay;
    try { replay = route(spawnFrame(command, args, cwd, env)); }
    catch (error) {
      // Not a process the transcript expects: fail the spawn, as an executable that cannot start would.
      const child = Object.assign(events, { stdin: new PassThrough(), stdout, stderr, kill: () => {} }) as unknown as CodexChild;
      setImmediate(() => events.emit("error", error));
      return child;
    }
    const state: CodexReplayProcess = { replay, pid: ++pids, cwd, env, written: [], dropped: [], signals: [], exited: false };
    processes.push(state);

    const exit = (code: number, error?: string) => {
      if (state.exited) return;
      state.exited = true;
      stop.abort();
      if (error) stderr.write(`${error}\n`);
      stdout.end(); stderr.end();
      // After the streams have flushed, as a real exit follows the end of its output.
      setImmediate(() => events.emit("exit", code, null));
    };
    const outbound = (frame: unknown) => {
      if (state.exited) { state.dropped.push(frame); return; }
      state.written.push(frame);
      try { replay.expect(frame); }
      catch { /* recorded on the replay; complete() reports it, and the process stops answering */ exit(1); }
    };

    let buffer = "";
    const stdin = new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        buffer += chunk.toString();
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let frame: unknown;
          try { frame = JSON.parse(line); }
          catch { frame = { type: "unparseable", line }; }
          outbound(frame);
        }
        done();
      },
      final(done) { outbound({ type: "stdin.close" }); done(); }
    });

    // Delivers inbound entries, in order, whenever playback is not waiting for the provider to write.
    void (async () => {
      for (;;) {
        if (state.exited) return;
        replay.throwIfFailed();
        const entry = replay.entry;
        if (!entry || record(entry.type === "expect_outbound" ? entry.frame : undefined).type === "process.spawn") {
          // The transcript is over, or its next entry belongs to the next process: this one waits to be closed.
          return;
        }
        if (entry.type === "expect_outbound") { await replay.advanced(stop.signal); continue; }
        const taken = await replay.take(stop.signal);
        if (!taken || state.exited) return;
        if (taken.type === "runtime_exit") return exit(taken.status === "success" ? 0 : 1, taken.status === "error" ? taken.error ?? "codex app-server exited with an error" : undefined);
        stdout.write(`${typeof taken.frame === "string" ? taken.frame : JSON.stringify(taken.frame)}\n`);
      }
    })().catch(() => { /* recorded on the replay; complete() reports it */ exit(1); });

    const child = Object.assign(events, {
      get pid() { return state.pid; },
      stdin, stdout, stderr,
      kill: (signal: NodeJS.Signals) => {
        if (state.exited) return;
        state.signals.push(signal);
        outbound({ type: "process.kill", signal });
      }
    }) as unknown as CodexChild;
    setImmediate(() => events.emit("spawn"));
    return child;
  };

  /** The real transport over replayed processes. */
  const connect: CodexConnect = options => connectCodex({ ...options, spawn });

  return {
    spawn, connect, processes, replays,
    /** Throws the first divergence of any transcript, or the first one with entries never played. */
    complete(): void { for (const replay of replays) replay.complete(); }
  };
}
export type CodexReplay = ReturnType<typeof codexReplay>;

export const spawnEntry: Entry = { type: "expect_outbound", label: "process.spawn", frame: { type: "process.spawn", command: "codex", args: ["app-server"], cwd: "<workspace>", env: { [runnerBridgeEnv]: "disabled" } } };
export const closeEntry: Entry = { type: "expect_outbound", label: "stdin.close", frame: { type: "stdin.close" } };
export const killEntry = (signal: NodeJS.Signals): Entry => ({ type: "expect_outbound", label: "process.kill", frame: { type: "process.kill", signal } });
export const exitEntry = (status: "success" | "error" = "success", error?: string): Entry => ({ type: "runtime_exit", status, ...(error ? { error } : {}) });
export { ReplayError };
