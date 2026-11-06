/*!
 * Provider replay transcripts and their playback cursor, adapted from Enso's T3 Code fork ("agent-host").
 *
 * Source:   https://github.com/Enso-Team/agent-host (branch `enso`)
 * Revision: 322f6544dfad0a3c8a0c8cbecf2c7f7874b14268
 * Files:
 *   - packages/provider-testing/src/replayTranscript.ts (NDJSON decoding, the `<workspace>` placeholder)
 *   - packages/provider-testing/src/replayGate.ts (label gates: hold, reached, release)
 *   - packages/contracts/src/orchestrationV2.ts (ProviderReplayEntry, ProviderReplayTranscriptHeader)
 *   - apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts, makeReplayQueryRunner: the single
 *     cursor, stableStringify/sameFrame, the cursor-advance signal, and the exhausted, unexpected-outbound,
 *     mismatch and incomplete failures
 * Enso: Effect and Schema are replaced by plain promises and zod; transcripts carry a `format` version; an expected
 * outbound frame may carry the `reply` its boundary gives; and failures are thrown as one ReplayError whose message
 * shows the cursor, label, expected and actual frames.
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
import { readFileSync } from "node:fs";
import { z } from "zod";

/** The transcript format this harness reads. A change to entry semantics bumps it, and old files fail to load. */
export const replayFormat = "enso-provider-replay/1";

const label = z.string().trim().min(1).optional();
const entrySchema = z.discriminatedUnion("type", [
  /** A frame the provider must send next, compared exactly; `reply` is what the boundary answers with, if anything. */
  z.object({ type: z.literal("expect_outbound"), label, frame: z.unknown(), reply: z.unknown().optional() }).strict(),
  /** A frame the provider's runtime delivers next. */
  z.object({ type: z.literal("emit_inbound"), label, frame: z.unknown() }).strict(),
  /** The runtime's stream ends: cleanly, or failing with `error` and, for a system error, its errno `code`. */
  z.object({ type: z.literal("runtime_exit"), label, status: z.enum(["success", "error"]), error: z.string().optional(), code: z.string().optional() }).strict()
]);
const headerSchema = z.object({
  type: z.literal("transcript_start"),
  format: z.literal(replayFormat),
  provider: z.string().min(1),
  protocol: z.string().min(1),
  /** The provider runtime version the frames were recorded with (or, for synthetic transcripts, shaped after). */
  version: z.string().min(1),
  scenario: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({})
}).strict();

export type Entry = z.infer<typeof entrySchema>;
export type Transcript = Omit<z.infer<typeof headerSchema>, "type"> & { entries: Entry[] };

export function parseTranscript(text: string, source = "transcript"): Transcript {
  const lines = text.split(/\r?\n/u).map((line, index) => ({ line: line.trim(), number: index + 1 })).filter(({ line }) => line);
  if (!lines.length) throw new Error(`${source} has no records`);
  const record = ({ line, number }: { line: string; number: number }) => {
    try { return JSON.parse(line) as unknown; } catch (error) { throw new Error(`${source}:${number} is not JSON: ${(error as Error).message}`); }
  };
  const header = headerSchema.safeParse(record(lines[0]));
  if (!header.success) throw new Error(`${source}:1 is not a ${replayFormat} transcript_start header: ${header.error.message}`);
  const entries = lines.slice(1).map(line => {
    const entry = entrySchema.safeParse(record(line));
    if (!entry.success) throw new Error(`${source}:${line.number} is not a replay entry: ${entry.error.message}`);
    return entry.data;
  });
  const { type: _, ...metadata } = header.data;
  return { ...metadata, entries };
}
export function readTranscript(path: string): Transcript {
  return parseTranscript(readFileSync(path, "utf8"), path);
}

/** A transcript derived from another, under its own scenario name; recorded entries stay as they were. */
export function variant(transcript: Transcript, scenario: string, edit: (entries: Entry[]) => Entry[]): Transcript {
  return { ...transcript, scenario: `${transcript.scenario}~${scenario}`, entries: edit(structuredClone(transcript.entries)) };
}
/** The index of the first entry labelled `label`. */
export function labelled(entries: Entry[], label: string): number {
  const index = entries.findIndex(entry => entry.label === label);
  if (index < 0) throw new Error(`No entry labelled ${label}`);
  return index;
}
/** A transcript with no entries: any outbound operation fails it. */
export function nothing(scenario: string, provider: string, protocol: string): Transcript {
  return { format: replayFormat, provider, protocol, version: "none", scenario, metadata: {}, entries: [] };
}

const workspacePlaceholder = "<workspace>";
/** Replaces the `<workspace>` placeholder in expected outbound frames with the directory a test runs in. */
export function materializeWorkspace(transcript: Transcript, workspace: string): Transcript {
  const replace = (value: unknown): unknown => {
    if (value === workspacePlaceholder) return workspace;
    if (Array.isArray(value)) return value.map(replace);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
  };
  return { ...transcript, entries: transcript.entries.map(entry => entry.type === "expect_outbound" ? { ...entry, frame: replace(entry.frame) } : entry) };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const sameFrame = (left: unknown, right: unknown) => stableStringify(left) === stableStringify(right);

export type ReplayFailure = "exhausted" | "unexpected_outbound" | "mismatch" | "incomplete" | "driver";
/** Why playback diverged from the transcript. Its message is the test's failure message, so it carries the frames. */
export class ReplayError extends Error {
  constructor(readonly kind: ReplayFailure, readonly scenario: string, readonly cursor: number, detail: { label?: string; expected?: unknown; actual?: unknown; message?: string } = {}) {
    const lines = [`Replay ${kind.replace("_", " ")} in ${scenario} at entry ${cursor + 1}${detail.label ? ` (${detail.label})` : ""}${detail.message ? `: ${detail.message}` : ""}`];
    if ("expected" in detail) lines.push(`  expected: ${JSON.stringify(detail.expected)}`);
    if ("actual" in detail) lines.push(`  actual:   ${JSON.stringify(detail.actual)}`);
    super(lines.join("\n"));
    this.name = "ReplayError";
  }
}

type Signal = { promise: Promise<void>; resolve: () => void };
function signal(): Signal {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}
/** Resolves on `promise` or on `abort`, whichever is first. */
function until(promise: Promise<void>, abort?: AbortSignal): Promise<void> {
  if (!abort) return promise;
  if (abort.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { abort.removeEventListener("abort", done); resolve(); };
    abort.addEventListener("abort", done, { once: true });
    void promise.then(done);
  });
}

/**
 * One transcript's playback. A single cursor walks the entries in order: the provider's boundary consumes inbound
 * entries as the runtime would deliver them, and every outbound operation must equal the next expected frame. The first
 * divergence is recorded and thrown; `complete()` rethrows it, or reports entries never played.
 */
export class Replay {
  private position = 0;
  private advancedSignal = signal();
  private gates = new Map<string, { reached: Signal; released: Signal; hasReached: boolean }>();
  failure?: ReplayError;

  constructor(readonly transcript: Transcript) {}

  get scenario(): string { return this.transcript.scenario; }
  get cursor(): number { return this.position; }
  get entry(): Entry | undefined { return this.transcript.entries[this.position]; }
  get done(): boolean { return this.position >= this.transcript.entries.length; }

  /** Records the first divergence, wakes every waiter so playback stops, and throws it. */
  fail(error: ReplayError): never {
    this.failure ??= error;
    for (const gate of this.gates.values()) { gate.released.resolve(); gate.reached.resolve(); }
    this.advancedSignal.resolve();
    throw this.failure;
  }
  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  /** Matches an outbound operation against the next entry and returns that entry (for its `reply`). */
  expect(actual: unknown, compare: (expected: unknown, actual: unknown) => boolean = sameFrame): Extract<Entry, { type: "expect_outbound" }> {
    this.throwIfFailed();
    const entry = this.entry;
    if (!entry) return this.fail(new ReplayError("exhausted", this.scenario, this.position, { message: "the transcript has no more entries", actual }));
    if (entry.type !== "expect_outbound") {
      return this.fail(new ReplayError("unexpected_outbound", this.scenario, this.position, {
        label: entry.label, message: `the transcript expects ${entry.type === "emit_inbound" ? "the runtime to deliver a frame" : "the runtime to exit"} next`,
        expected: entry.type === "emit_inbound" ? entry.frame : { runtime_exit: entry.status }, actual
      }));
    }
    if (!compare(entry.frame, actual)) return this.fail(new ReplayError("mismatch", this.scenario, this.position, { label: entry.label, expected: entry.frame, actual }));
    this.advance();
    return entry;
  }

  /** Consumes the next inbound or exit entry, after any gate on its label opens. Undefined once `abort` fires. */
  async take(abort?: AbortSignal): Promise<Exclude<Entry, { type: "expect_outbound" }> | undefined> {
    this.throwIfFailed();
    const entry = this.entry;
    if (!entry || entry.type === "expect_outbound") throw new Error("take() needs an inbound or exit entry");
    const gate = entry.label === undefined ? undefined : this.gates.get(entry.label);
    if (gate && !gate.hasReached) {
      gate.hasReached = true;
      gate.reached.resolve();
      await until(gate.released.promise, abort);
      this.throwIfFailed();
      if (abort?.aborted) return undefined;
    }
    this.advance();
    return entry;
  }

  /** Resolves when the cursor next moves (or playback fails, or `abort` fires). */
  advanced(abort?: AbortSignal): Promise<void> {
    return until(this.advancedSignal.promise, abort);
  }

  /** Resolves once the cursor is at the first entry labelled `label` (for example an outbound frame not yet sent). */
  async arrival(label: string): Promise<void> {
    if (!this.transcript.entries.some(entry => entry.label === label)) throw new Error(`${this.scenario} has no entry labelled ${label}`);
    while (this.entry?.label !== label) {
      this.throwIfFailed();
      if (this.done) throw new Error(`${this.scenario} played past ${label}`);
      await this.advanced();
    }
  }

  /**
   * Holds the first inbound entry with `label` until `release(label)`: the test acts while the runtime is known to be
   * at that point. `reached` resolves once playback arrives there.
   */
  hold(label: string): { reached: Promise<void>; release: () => void } {
    if (!this.transcript.entries.some(entry => entry.type !== "expect_outbound" && entry.label === label)) {
      throw new Error(`${this.scenario} has no inbound entry labelled ${label}`);
    }
    if (this.gates.has(label)) throw new Error(`${this.scenario} already holds ${label}`);
    const gate = { reached: signal(), released: signal(), hasReached: false };
    this.gates.set(label, gate);
    // Playback that fails before arriving settles `reached` too, rejecting with the divergence.
    return { reached: gate.reached.promise.then(() => this.throwIfFailed()), release: gate.released.resolve };
  }

  /** Throws the recorded divergence, or an incomplete-playback failure if entries remain. */
  complete(): void {
    this.throwIfFailed();
    if (!this.done) {
      const entry = this.entry!;
      throw new ReplayError("incomplete", this.scenario, this.position, {
        label: entry.label, message: `${this.transcript.entries.length - this.position} entries were never played`,
        expected: entry.type === "runtime_exit" ? { runtime_exit: entry.status } : entry.frame
      });
    }
  }

  private advance(): void {
    this.position++;
    const advanced = this.advancedSignal;
    this.advancedSignal = signal();
    advanced.resolve();
  }
}
