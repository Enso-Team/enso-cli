import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerEngine } from "../../src/runner/engine.js";
import { FakeProvider, type Execution, type ProviderOutcome, type RunnerProvider } from "../../src/runner/provider.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import type { Change, Run } from "../../src/runner/protocol.js";
import { durable } from "./replica.js";

let directory: string;
let storage: RunnerStorage;
let engine: RunnerEngine | undefined;
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory: realpathSync(directory) });
const prompt = (sessionID: string, requestID: string, scenario = "success", delayMs = 20) =>
  ({ requestID, sessionID, text: "Explain", context: { selectedNodes: [] }, fake: { scenario, delayMs } });
const stub = (execute: (execution: Execution) => Promise<ProviderOutcome>): RunnerProvider => ({ name: "fake", execute });
const pending = (id: string) => ({ id, kind: "input" as const, message: "Enter input" });
async function status(id: string, wanted: Run["status"]): Promise<Run> {
  for (let n = 0; n < 200; n++) {
    const run = engine!.run(id);
    if (run.status === wanted) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${id} did not reach ${wanted}; last ${engine!.run(id).status}`);
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "enso-engine-")); storage = new RunnerStorage(directory); storage.acquire(); });
afterEach(async () => {
  await engine?.shutdown(); engine = undefined;
  vi.restoreAllMocks(); storage.release();
  rmSync(directory, { recursive: true, force: true });
});

describe("provider waits", () => {
  it("refuses a concurrent second wait and keeps the first answerable", async () => {
    let refused: unknown;
    engine = new RunnerEngine(storage, stub(async ({ wait }) => {
      const first = wait(pending("first"));
      refused = await wait(pending("second")).catch(error => error);
      return { status: "completed", result: { answer: (await first).value } };
    }));
    const s = engine.createSession({ binding: binding() });
    engine.submit(prompt(s.id, "double"));
    const waiting = await status("double", "waiting_input");
    expect(waiting.pending?.id).toBe("first");
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/another wait is pending/);
    engine.answer("double", { pendingID: "first", value: "yes" });
    const done = await status("double", "completed");
    expect(done.result).toEqual({ answer: "yes" });
    expect(done.pending).toBeUndefined();
  });

  it("ends as interrupted, not hung, when the provider fails on the refused wait", async () => {
    engine = new RunnerEngine(storage, stub(async ({ wait }) => {
      await Promise.all([wait(pending("first")), wait(pending("second"))]);
      return { status: "completed", result: null };
    }));
    const s = engine.createSession({ binding: binding() });
    engine.submit(prompt(s.id, "double"));
    const run = await status("double", "interrupted");
    expect(run.error?.code).toBe("provider_uncertain");
    expect(run.pending).toBeUndefined();
    expect(() => engine!.answer("double", { pendingID: "first", value: "late" })).toThrow("No matching pending request");
    expect(durable(directory).runs[0]).toEqual(run);
  });
});

describe("shutdown", () => {
  it("cancels accepted and active runs across sessions in a single commit", async () => {
    engine = new RunnerEngine(storage, new FakeProvider(), { autoDispatch: false });
    const [a, b, c, d] = Array.from({ length: 4 }, () => engine!.createSession({ binding: binding() }));
    engine.submit(prompt(a.id, "running", "success", 60_000));
    engine.submit(prompt(b.id, "waiting", "input", 0));
    engine.dispatchAccepted();
    await status("running", "running");
    await status("waiting", "waiting_input");
    engine.submit(prompt(c.id, "accepted-1"));
    engine.submit(prompt(d.id, "accepted-2"));
    const commit = vi.spyOn(storage, "commit");
    const stopped = engine.shutdown();
    expect(commit).toHaveBeenCalledTimes(1);
    const intent = commit.mock.calls[0][0] as Extract<Change, { type: "run_updated" }>[];
    expect(Object.fromEntries(intent.map(event => [event.requestID, event.status]))).toEqual({
      running: "stopping", waiting: "stopping", "accepted-1": "cancelled", "accepted-2": "cancelled"
    });
    expect(intent.find(event => event.requestID === "waiting")!.pending).toBeUndefined();
    expect(engine.run("waiting").pending).toBeUndefined();
    await stopped;
    expect(engine.shutdown()).toBe(stopped);
    // The remaining transactions are the two providers confirming cancellation.
    expect(commit).toHaveBeenCalledTimes(3);
    expect(engine.snapshot().runs.map(run => run.status)).toEqual(Array(4).fill("cancelled"));
    expect(durable(directory).runs.map(run => run.status)).toEqual(Array(4).fill("cancelled"));
  });
});

describe("outcomes", () => {
  it("commits a completed providerState to the run and its session", async () => {
    engine = new RunnerEngine(storage, stub(async () => ({ status: "completed", result: { text: "done" }, providerState: { cursor: "c-1" } })));
    const s = engine.createSession({ binding: binding() });
    engine.submit(prompt(s.id, "turn"));
    const run = await status("turn", "completed");
    expect(run).toMatchObject({ result: { text: "done" }, providerState: { cursor: "c-1" } });
    expect(run.error).toBeUndefined();
    expect(engine.session(s.id).providerState).toEqual({ cursor: "c-1" });
  });
});

describe("native identifiers and session uncertainty", () => {
  it("keeps recorded native identifiers through waits, stopping and the confirmed outcome", async () => {
    engine = new RunnerEngine(storage, stub(async ({ record, wait, signal }) => {
      record({ conversation: "c-1" });
      await wait(pending("ask")).catch(() => {});
      signal.throwIfAborted();
      return { status: "completed", result: null };
    }));
    const s = engine.createSession({ binding: binding() });
    engine.submit(prompt(s.id, "turn"));
    expect((await status("turn", "waiting_input")).native).toEqual({ conversation: "c-1" });
    expect(engine.cancel("turn")).toMatchObject({ status: "stopping", native: { conversation: "c-1" } });
    // The provider threw after the stop: unconfirmed, so interrupted, and the session carries what was recorded.
    const run = await status("turn", "interrupted");
    expect(run.native).toEqual({ conversation: "c-1" });
    expect(engine.session(s.id).uncertain).toEqual({ requestID: "turn", native: { conversation: "c-1" } });
    expect(durable(directory)).toEqual(engine.snapshot());
  });

  it("checkpoints confirmed outcomes; a completed turn, or a confirmed one that sets or clears the checkpoint, clears uncertainty", async () => {
    const outcomes: ProviderOutcome[] = [
      { status: "interrupted", error: { code: "x", message: "unknown" } },
      { status: "failed", error: { code: "f", message: "failed" } },
      { status: "cancelled", providerState: { c: 3 } },
      { status: "interrupted", error: { code: "y", message: "unknown" } },
      { status: "failed", error: { code: "gone", message: "conversation gone" }, providerState: null },
      { status: "interrupted", error: { code: "z", message: "unknown" } },
      { status: "completed", result: null }
    ];
    engine = new RunnerEngine(storage, stub(async () => outcomes.shift()!));
    const s = engine.createSession({ binding: binding() });
    engine.submit(prompt(s.id, "a"));
    await status("a", "interrupted");
    // A confirmed failure that leaves the checkpoint alone has not settled recovery.
    engine.submit({ ...prompt(s.id, "b"), recovery: { after: "a", mode: "fresh" } });
    await status("b", "failed");
    expect(engine.session(s.id).uncertain).toEqual({ requestID: "a" });
    expect(engine.session(s.id).providerState).toBeUndefined();
    // One that sets it has: the session continues from that checkpoint.
    engine.submit({ ...prompt(s.id, "c"), recovery: { after: "a", mode: "resume" } });
    await status("c", "cancelled");
    expect(engine.session(s.id).providerState).toEqual({ c: 3 });
    expect(engine.session(s.id).uncertain).toBeUndefined();
    engine.submit(prompt(s.id, "d"));
    await status("d", "interrupted");
    // A null checkpoint clears both the checkpoint and the marker.
    engine.submit({ ...prompt(s.id, "e"), recovery: { after: "d", mode: "resume" } });
    await status("e", "failed");
    expect(engine.session(s.id)).not.toHaveProperty("providerState");
    expect(engine.session(s.id)).not.toHaveProperty("uncertain");
    engine.submit(prompt(s.id, "f"));
    await status("f", "interrupted");
    engine.submit({ ...prompt(s.id, "g"), recovery: { after: "f", mode: "resume" } });
    await status("g", "completed");
    expect(engine.session(s.id).uncertain).toBeUndefined();
    expect(() => engine!.submit({ ...prompt(s.id, "h"), recovery: { after: "f", mode: "resume" } })).toThrow("recovery applies only while the session is uncertain");
    expect(durable(directory)).toEqual(engine.snapshot());
  });

  it("fills fake defaults before comparing resubmissions", async () => {
    engine = new RunnerEngine(storage, new FakeProvider(), { autoDispatch: false });
    const s = engine.createSession({ binding: binding() });
    const bare = { requestID: "bare", sessionID: s.id, text: "Explain", context: { selectedNodes: [] } };
    const accepted = engine.submit(bare);
    expect(accepted.request.fake).toEqual({ scenario: "success", delayMs: 20 });
    expect(engine.submit({ ...bare, fake: { scenario: "success" } })).toEqual(accepted);
    expect(() => engine!.submit({ ...bare, fake: { scenario: "failure" } })).toThrow("different payload");
  });
});
