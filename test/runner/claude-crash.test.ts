import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerCall } from "../../src/runner/client.js";
import { ClaudeProvider } from "../../src/runner/claude.js";
import { RunnerEngine } from "../../src/runner/engine.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import { claudeProtocol, claudeReplay, claudeTranscript, nativeSessionID, recordedPrompts, reopen, type ClaudeReplay } from "./replay/claude.js";
import { observeCommits } from "./replay/commits.js";
import { labelled, nothing, variant, type Transcript } from "./replay/transcript.js";
import { durable } from "./replica.js";

let directory: string;
let workspace: string;
let child: ChildProcess | undefined;
let storage: RunnerStorage | undefined;
let engine: RunnerEngine | undefined;
let replay: ClaudeReplay | undefined;
const promptUUID = "00000000-0000-4000-8000-000000000001";
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory: workspace });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "enso-claude-crash-"));
  workspace = join(mkdtempSync(join(tmpdir(), "enso-claude-ws-")), "codebase");
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
  child = spawn(process.execPath, ["--import", "tsx", "test/runner/claude-crash-child.ts", directory, boundary, fixture, workspace], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr!.on("data", chunk => { errors += chunk; });
  // After its output closes, so every reported line is in `errors`.
  const exited = once(child, "close");
  await new Promise<void>((resolve, reject) => {
    child!.stdout!.once("data", () => resolve());
    child!.once("exit", () => reject(new Error(`Runner exited before ready: ${errors}`)));
  });
  const session = await runnerCall("POST", "/v1/sessions", { binding: binding(), provider: "claude" }, directory);
  if (!session.ok) throw new Error(JSON.stringify(session));
  const sessionID = (session.data as { id: string }).id;
  // The kill can drop the connection before the runner replies; a reply that refuses the prompt means no run.
  const prompt = await runnerCall("POST", "/v1/prompts", { requestID: "crash", sessionID, ...recordedPrompts(claudeTranscript(fixture, workspace))[0] }, directory).catch(() => undefined);
  if (prompt && !prompt.ok) throw new Error(`The runner refused the prompt: ${JSON.stringify(prompt)}\nRunner stderr: ${errors}`);
  const exitsWithin = (ms: number) => Promise.race([exited.then(() => true), delay(ms, false, { ref: false })]);
  if (!(await exitsWithin(10_000))) {
    // The child reports where its replay stopped, then kills itself.
    child.kill("SIGTERM");
    if (!(await exitsWithin(2_000))) { child.kill("SIGKILL"); await exited; }
    throw new Error(`The runner never reached ${boundary}: ${crashRun()}\nRunner stderr: ${errors}`);
  }
  expect(child.signalCode, `The runner exited with code ${child.exitCode} before reaching ${boundary}\nRunner stderr: ${errors}`).toBe("SIGKILL");
  return { sessionID };
}
/** The crash run as the store holds it: where it stopped, and why (a replay divergence is the error's cause). */
function crashRun(): string {
  try {
    const run = durable(directory).runs.find(run => run.request.requestID === "crash");
    return run ? `the run is ${run.status}${run.error ? ` with ${JSON.stringify(run.error)}` : ""}` : "the run was never accepted";
  } catch (error) {
    return `the store could not be read: ${String(error)}`;
  }
}
/** Restarts on the crashed store with a provider that may only do what `after` expects: nothing, by default. */
function restart(after: Transcript = nothing("after restart", "claude", claudeProtocol), newID?: () => string) {
  storage = new RunnerStorage(directory);
  storage.acquire();
  const commits = observeCommits(storage);
  replay = claudeReplay(after);
  engine = new RunnerEngine(storage, new ClaudeProvider(replay.query, { permissionMode: "default" }, { stopTimeoutMs: 50, ...(newID ? { newID } : {}) }));
  return commits;
}
/** The fixture's own query, reopened with `resume` for its recorded conversation. */
function resumed(fixture: string, from = 0): Transcript {
  const recorded = claudeTranscript(fixture, workspace);
  return variant(recorded, "resumed", entries => entries.slice(from).map((entry, index) => index === 0 ? reopen(entry, { resume: nativeSessionID(recorded) }) : entry));
}

describe("Claude runs across a runner crash", () => {
  it("after the dispatch marker: interrupted with no identifiers, and nothing is replayed", async () => {
    const { sessionID } = await crashAt("dispatched", "simple");
    restart();
    const run = engine!.run("crash");
    expect(run).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" } });
    expect(run.native).toBeUndefined();
    expect(engine!.session(sessionID).uncertain).toEqual({ requestID: "crash" });
    expect(durable(directory)).toEqual(engine!.snapshot());
  }, 15_000);

  it("after the identifiers are recorded: interrupted with them, and an explicit resume reopens that conversation", async () => {
    const sid = nativeSessionID(claudeTranscript("simple", workspace));
    const { sessionID } = await crashAt("recorded", "simple");
    const commits = restart(resumed("simple"), () => "00000000-0000-4000-8000-000000000002");
    const native = { conversationID: sid, resume: false, promptUUID, model: null, permissionMode: "default" };
    expect(engine!.run("crash")).toMatchObject({ status: "interrupted", native, error: { code: "restart_uncertain" } });
    expect(engine!.session(sessionID)).toMatchObject({ uncertain: { requestID: "crash", native } });
    expect(engine!.session(sessionID).providerState).toBeUndefined();
    expect(() => engine!.submit({ requestID: "next", sessionID, ...recordedPrompts(replay!.replays[0].transcript)[0] })).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "session_uncertain" }) }));
    engine!.submit({ requestID: "next", sessionID, ...recordedPrompts(replay!.replays[0].transcript)[0], recovery: { after: "crash", mode: "resume" } });
    const next = await commits.reached("next", "completed");
    expect(next.native).toMatchObject({ conversationID: sid, resume: true });
    expect(durable(directory).sessions[0]).toMatchObject({ providerState: { conversationID: sid } });
    expect(durable(directory).sessions[0].uncertain).toBeUndefined();
  }, 15_000);

  it("while a permission is pending: interrupted, the request is gone, and a late answer is refused", async () => {
    const recorded = claudeTranscript("tool_call_read_only_on_request", workspace);
    const { sessionID } = await crashAt("waiting_permission", "tool_call_read_only_on_request");
    restart();
    const run = engine!.run("crash");
    expect(run).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" }, native: { conversationID: nativeSessionID(recorded), promptUUID } });
    expect(run.pending).toBeUndefined();
    expect(() => engine!.answer("crash", { pendingID: "crash:toolu_01CUcXE2dtk9uUvh3LpAWzhK", value: "allow" })).toThrow("No matching pending request");
    expect(engine!.session(sessionID).uncertain).toEqual({ requestID: "crash", native: run.native });
    expect(durable(directory)).toEqual(engine!.snapshot());
  }, 15_000);

  it("after the result but before its commit: interrupted, with no checkpoint, and nothing is replayed", async () => {
    const { sessionID } = await crashAt("before_completed", "simple");
    restart();
    expect(engine!.run("crash")).toMatchObject({ status: "interrupted", error: { code: "restart_uncertain" }, native: { promptUUID } });
    expect(engine!.run("crash").result).toBeUndefined();
    expect(engine!.session(sessionID).providerState).toBeUndefined();
    expect(durable(directory)).toEqual(engine!.snapshot());
  }, 15_000);

  it("after the completion commit: the result and checkpoint survive, and the next prompt resumes without recovery", async () => {
    const recorded = claudeTranscript("claude_idle_resume", workspace);
    const sid = nativeSessionID(recorded);
    const { sessionID } = await crashAt("completed", "claude_idle_resume");
    const second = variant(recorded, "second query", entries => entries.slice(labelled(entries, "query.close") + 1));
    const commits = restart(second, () => "00000000-0000-4000-8000-000000000002");
    expect(engine!.run("crash")).toMatchObject({ status: "completed", result: { text: "idle resume first turn complete", conversationID: sid } });
    expect(engine!.session(sessionID)).toMatchObject({ providerState: { conversationID: sid } });
    expect(engine!.session(sessionID).uncertain).toBeUndefined();
    engine!.submit({ requestID: "next", sessionID, ...recordedPrompts(recorded)[1] });
    expect((await commits.reached("next", "completed")).native).toMatchObject({ conversationID: sid, resume: true });
    expect(durable(directory)).toEqual(engine!.snapshot());
  }, 15_000);
});
