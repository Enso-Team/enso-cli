import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerCall } from "../../src/runner/client.js";
import { CodexProvider, type CodexNative } from "../../src/runner/codex.js";
import { RunnerEngine } from "../../src/runner/engine.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import { codexProtocol, codexReplay, codexTranscript, materialize, recordedPrompts, threadID, type CodexReplay } from "./replay/codex.js";
import { observeCommits } from "./replay/commits.js";
import { nothing, variant, type Entry, type Transcript } from "./replay/transcript.js";
import { durable } from "./replica.js";

let directory: string;
let workspace: string;
let child: ChildProcess | undefined;
let storage: RunnerStorage | undefined;
let engine: RunnerEngine | undefined;
let replay: CodexReplay | undefined;
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory: workspace });
const native = (fields: Partial<CodexNative>): CodexNative => ({ threadID: null, resume: false, turnID: null, model: null, approvalPolicy: "on-request", sandbox: "workspace-write", ...fields });
const transcript = (name: string) => codexTranscript(name, workspace);
const turnOf = (from: Transcript) => from.entries.flatMap(entry => entry.type === "emit_inbound" && (entry.frame as any)?.result?.turn?.id ? [(entry.frame as any).result.turn.id as string] : [])[0];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "enso-codex-crash-"));
  workspace = join(mkdtempSync(join(tmpdir(), "enso-codex-ws-")), "codebase");
  mkdirSync(workspace);
  workspace = realpathSync(workspace);
});
afterEach(async () => {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    await engine?.shutdown();
    replay?.complete();
  } finally {
    child = undefined; engine = undefined; replay = undefined;
    storage?.release(); storage = undefined;
    rmSync(directory, { recursive: true, force: true });
    rmSync(join(workspace, ".."), { recursive: true, force: true });
  }
});

/** Runs `fixture`'s first prompt in a child runner that is SIGKILLed when its commits cross `boundary`. */
async function crashAt(boundary: string, fixture: string): Promise<{ sessionID: string }> {
  child = spawn(process.execPath, ["--import", "tsx", "test/runner/codex-crash-child.ts", directory, boundary, fixture, workspace], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr!.on("data", chunk => { errors += chunk; });
  const exited = once(child, "close");
  await new Promise<void>((resolve, reject) => {
    child!.stdout!.once("data", () => resolve());
    child!.once("exit", () => reject(new Error(`Runner exited before ready: ${errors}`)));
  });
  const session = await runnerCall("POST", "/v1/sessions", { binding: binding(), provider: "codex" }, directory);
  if (!session.ok) throw new Error(JSON.stringify(session));
  const sessionID = (session.data as { id: string }).id;
  // The kill can drop the connection before the runner replies; a reply that refuses the prompt means no run.
  const prompt = await runnerCall("POST", "/v1/prompts", { requestID: "crash", sessionID, ...recordedPrompts(transcript(fixture))[0] }, directory).catch(() => undefined);
  if (prompt && !prompt.ok) throw new Error(`The runner refused the prompt: ${JSON.stringify(prompt)}\nRunner stderr: ${errors}`);
  const exitsWithin = (ms: number) => Promise.race([exited.then(() => true), delay(ms, false, { ref: false })]);
  if (!(await exitsWithin(10_000))) {
    child.kill("SIGTERM");
    if (!(await exitsWithin(2_000))) { child.kill("SIGKILL"); await exited; }
    throw new Error(`The runner never reached ${boundary}\nRunner stderr: ${errors}`);
  }
  expect(child.signalCode, `The runner exited with code ${child.exitCode} before reaching ${boundary}\nRunner stderr: ${errors}`).toBe("SIGKILL");
  return { sessionID };
}
/** Restarts on the crashed store with a provider that may only do what `after` expects: nothing, by default. */
function restart(after: Transcript = nothing("after restart", "codex", codexProtocol)) {
  storage = new RunnerStorage(directory);
  storage.acquire();
  const commits = observeCommits(storage);
  replay = codexReplay(after);
  engine = new RunnerEngine(storage, new CodexProvider(replay.connect, { executable: "codex", approvalPolicy: "on-request", sandbox: "workspace-write" }, { stopTimeoutMs: 50, exitGraceMs: 50 }));
  return commits;
}
/** The fixture's first process, its thread request rewritten to resume `thread`. */
function resumed(fixture: string, thread: string): Transcript {
  return materialize(variant(transcript(fixture), "resumed", entries => entries.map((entry): Entry => {
    if (entry.type !== "expect_outbound" || entry.label !== "thread/start") return entry;
    const { id, params } = entry.frame as { id: number; params: object };
    return { ...entry, label: "thread/resume", frame: { id, method: "thread/resume", params: { threadId: thread, excludeTurns: true, ...params } } };
  })), workspace);
}

describe("Codex runs across a runner crash", () => {
  it("after the dispatch marker: interrupted with no identifiers, and nothing is replayed", async () => {
    const { sessionID } = await crashAt("dispatched", "simple");
    restart();
    const run = engine!.run("crash");
    expect(run).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" } });
    expect(run.native).toBeUndefined();
    expect(engine!.session(sessionID).uncertain).toEqual({ requestID: "crash" });
    expect(durable(directory)).toEqual(engine!.snapshot());
  }, 15_000);

  it("before Codex named a thread: interrupted with no thread, so resume starts one rather than guess", async () => {
    const { sessionID } = await crashAt("recorded", "simple");
    const commits = restart(transcript("simple"));
    expect(engine!.run("crash")).toMatchObject({ status: "interrupted", native: native({}), error: { code: "restart_uncertain" } });
    expect(engine!.session(sessionID).uncertain).toEqual({ requestID: "crash", native: native({}) });
    engine!.submit({ requestID: "next", sessionID, ...recordedPrompts(transcript("simple"))[0], recovery: { after: "crash", mode: "resume" } });
    expect((await commits.reached("next", "completed")).native).toMatchObject({ resume: false });
  }, 15_000);

  it("after the thread is recorded, before the prompt was sent: an explicit resume continues that thread", async () => {
    const thread = threadID(transcript("simple"));
    const { sessionID } = await crashAt("thread", "simple");
    const commits = restart(resumed("simple", thread));
    expect(engine!.run("crash")).toMatchObject({ status: "interrupted", native: native({ threadID: thread }), error: { code: "restart_uncertain" } });
    expect(engine!.session(sessionID).providerState).toBeUndefined();
    expect(() => engine!.submit({ requestID: "next", sessionID, ...recordedPrompts(transcript("simple"))[0] })).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "session_uncertain" }) }));
    engine!.submit({ requestID: "next", sessionID, ...recordedPrompts(transcript("simple"))[0], recovery: { after: "crash", mode: "resume" } });
    const next = await commits.reached("next", "completed");
    expect(next.native).toMatchObject({ threadID: thread, resume: true });
    expect(durable(directory).sessions[0]).toMatchObject({ providerState: { threadID: thread } });
    expect(durable(directory).sessions[0].uncertain).toBeUndefined();
  }, 15_000);

  it("after the turn is recorded: interrupted with the thread and turn, and nothing is replayed", async () => {
    const simple = transcript("simple");
    const { sessionID } = await crashAt("turn", "simple");
    restart();
    const run = engine!.run("crash");
    expect(run).toMatchObject({ status: "interrupted", native: native({ threadID: threadID(simple), turnID: turnOf(simple) }), error: { code: "restart_uncertain" } });
    expect(engine!.session(sessionID).uncertain).toEqual({ requestID: "crash", native: run.native });
    expect(durable(directory)).toEqual(engine!.snapshot());
  }, 15_000);

  it("while an approval is pending: interrupted, the request is gone, and a late answer is refused", async () => {
    const recorded = transcript("tool_call_read_only_on_request");
    const { sessionID } = await crashAt("waiting_permission", "tool_call_read_only_on_request");
    restart();
    const run = engine!.run("crash");
    expect(run).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" }, native: { threadID: threadID(recorded), turnID: turnOf(recorded) } });
    expect(run.pending).toBeUndefined();
    expect(() => engine!.answer("crash", { pendingID: "crash:exec-02c3fc6e-7a54-4c15-afda-bc59a03b138a", value: "allow" })).toThrow("No matching pending request");
    expect(engine!.session(sessionID).uncertain).toEqual({ requestID: "crash", native: run.native });
  }, 15_000);

  it("after the turn completed but before its commit: interrupted, with no checkpoint", async () => {
    const { sessionID } = await crashAt("before_completed", "simple");
    restart();
    expect(engine!.run("crash")).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" } });
    expect(engine!.run("crash").result).toBeUndefined();
    expect(engine!.session(sessionID).providerState).toBeUndefined();
    expect(durable(directory)).toEqual(engine!.snapshot());
  }, 15_000);

  it("after the completion commit: the result and checkpoint survive, and the next prompt resumes without recovery", async () => {
    const recorded = transcript("provider_thread_resume");
    const thread = threadID(recorded);
    const { sessionID } = await crashAt("completed", "provider_thread_resume");
    const second = materialize(variant(recorded, "second process", entries => entries.slice(entries.findIndex((entry, index) => index > 0 && entry.label === "process.spawn"))), workspace);
    const commits = restart(second);
    expect(engine!.run("crash")).toMatchObject({ status: "completed", result: { text: "provider thread resume fixture first turn complete", threadID: thread } });
    expect(engine!.session(sessionID)).toMatchObject({ providerState: { threadID: thread } });
    engine!.submit({ requestID: "next", sessionID, ...recordedPrompts(recorded)[1] });
    expect((await commits.reached("next", "completed")).native).toMatchObject({ threadID: thread, resume: true });
    expect(durable(directory)).toEqual(engine!.snapshot());
  }, 15_000);
});
