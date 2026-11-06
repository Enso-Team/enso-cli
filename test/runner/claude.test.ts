import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../../src/client.js";
import { ClaudeProvider, type ClaudeConfig } from "../../src/runner/claude.js";
import { RunnerEngine } from "../../src/runner/engine.js";
import { FakeProvider, type RunnerProvider } from "../../src/runner/provider.js";
import type { Run } from "../../src/runner/protocol.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import { assistant, init, replay, result, scripted, type InterruptMode, type Script } from "./claude-exchange.js";
import { durable } from "./replica.js";

let directory: string;
let codebase: string;
let storage: RunnerStorage;
let engine: RunnerEngine | undefined;
const fixtures = join(import.meta.dirname, "fixtures", "agent-host");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Deterministic ids: the given ones first, then a counter. */
function ids(...first: string[]): () => string {
  let n = 0;
  return () => first.shift() ?? uuid(++n);
}
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory: codebase });
const context = { selectedNodes: [{ nodeID: "node-a", noteID: "note-a", content: "# Captured\nOriginal note" }, { nodeID: "node-b", content: "Loose text" }] };
const prompt = (sessionID: string, requestID: string, extra: Record<string, unknown> = {}) => ({ requestID, sessionID, text: "Explain this selection", context, ...extra });

function open(scripts: Script[], options: { interrupt?: InterruptMode; newID?: () => string; config?: Partial<ClaudeConfig> } = {}) {
  const sdk = scripted(scripts, { interrupt: options.interrupt });
  const provider = new ClaudeProvider(sdk.query, { permissionMode: "default", ...options.config }, { stopTimeoutMs: 50, newID: options.newID ?? ids() });
  engine = new RunnerEngine(storage, provider);
  return sdk;
}
/** Restarts on the same store, as after a crash: no shutdown, nothing confirmed. */
function crashAndReopen(provider: RunnerProvider) {
  storage.release();
  storage = new RunnerStorage(join(directory, "store"));
  storage.acquire();
  engine = new RunnerEngine(storage, provider);
}
async function status(id: string, wanted: Run["status"]): Promise<Run> {
  for (let n = 0; n < 400; n++) {
    const run = engine!.run(id);
    if (run.status === wanted) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${id} did not reach ${wanted}; last ${engine!.run(id).status}`);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "enso-claude-"));
  codebase = join(directory, "codebase");
  mkdirSync(codebase);
  codebase = realpathSync(codebase);
  storage = new RunnerStorage(join(directory, "store"));
  storage.acquire();
});
afterEach(async () => {
  await engine?.shutdown(); engine = undefined;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); storage.release();
  rmSync(directory, { recursive: true, force: true });
});
const store = () => durable(join(directory, "store"));

describe("starting and resuming", () => {
  it("records the native identifiers before the query, starts in the stored directory, and sends the captured prompt", async () => {
    let atOpen: unknown;
    const sdk = open([exchange => {
      exchange.emit(init(uuid(1)));
      exchange.emit(assistant(uuid(1), "It explains the note"));
      exchange.emit(result(uuid(1), { result: "It explains the note", user_message_uuid: exchange.prompt.uuid }));
      exchange.end();
    }]);
    const query = sdk.query;
    // The run already carries its identifiers, durably, when the SDK is first called.
    (engine as unknown as { provider: ClaudeProvider }).provider = new ClaudeProvider(params => {
      atOpen = store().runs[0].native;
      return query(params);
    }, { permissionMode: "default" }, { stopTimeoutMs: 50, newID: ids() });
    const session = engine!.createSession({ binding: binding(), provider: "claude" });
    engine!.submit(prompt(session.id, "turn-1"));
    const done = await status("turn-1", "completed");
    const native = { conversationID: uuid(1), resume: false, promptUUID: uuid(2), model: null, permissionMode: "default" };
    expect(atOpen).toEqual(native);
    expect(done.native).toEqual(native);
    expect(done.result).toMatchObject({ text: "It explains the note", conversationID: uuid(1), promptUUID: uuid(2), permissionDenials: [] });
    expect(engine!.session(session.id).providerState).toEqual({ conversationID: uuid(1) });
    const { options, prompt: sent } = sdk.queries[0] as { options: any; prompt: any };
    expect(options).toMatchObject({ cwd: codebase, sessionId: uuid(1), permissionMode: "default", systemPrompt: { type: "preset", preset: "claude_code" } });
    expect(options.resume).toBeUndefined();
    expect(options.env.ENSO_RUNNER_BRIDGE).toBe("disabled");
    // Exactly the captured selection and text, in that order, under the recorded prompt uuid.
    expect(sent).toMatchObject({ type: "user", uuid: uuid(2), parent_tool_use_id: null });
    const [selection, text] = sent.message.content;
    expect(selection.text).toContain('<enso_node node_id="node-a" note_id="note-a">\n# Captured\nOriginal note\n</enso_node>');
    expect(selection.text).toContain('<enso_node node_id="node-b">\nLoose text\n</enso_node>');
    expect(text).toEqual({ type: "text", text: "Explain this selection" });
    expect(store().runs[0]).toEqual(done);
  });

  it("replays a recorded completion and resumes the same conversation (agent-host claude_idle_resume)", async () => {
    const recorded = replay(join(fixtures, "claude_idle_resume.ndjson"));
    const sdk = open(recorded.scripts, { newID: ids(recorded.nativeSessionID) });
    const session = engine!.createSession({ binding: binding() });
    engine!.submit({ ...prompt(session.id, "first"), text: recorded.prompts[0] });
    expect((await status("first", "completed")).result).toMatchObject({ text: "idle resume first turn complete", conversationID: recorded.nativeSessionID });
    engine!.submit({ ...prompt(session.id, "second"), text: recorded.prompts[1] });
    const second = await status("second", "completed");
    expect(second.result).toMatchObject({ text: "idle resume second turn complete" });
    expect(second.native).toMatchObject({ conversationID: recorded.nativeSessionID, resume: true });
    expect(sdk.queries.map(query => [query.options.sessionId, query.options.resume])).toEqual([[recorded.nativeSessionID, undefined], [undefined, recorded.nativeSessionID]]);
    expect(sdk.errors).toEqual([]);
  });

  it("fails without querying when the stored working directory is gone, and never substitutes another", async () => {
    const sdk = open([]);
    const session = engine!.createSession({ binding: binding() });
    rmSync(codebase, { recursive: true });
    engine!.submit(prompt(session.id, "gone"));
    const run = await status("gone", "failed");
    expect(run.error).toMatchObject({ code: "working_directory_unavailable", details: { workingDirectory: codebase } });
    expect(run.native).toBeUndefined();
    expect(sdk.queries).toHaveLength(0);
  });

  it("refuses fake controls, and sessions of another provider", async () => {
    open([]);
    const session = engine!.createSession({ binding: binding() });
    expect(() => engine!.submit({ ...prompt(session.id, "x"), fake: { scenario: "success" } })).toThrow("fake options apply only to fake sessions");
    expect(() => engine!.createSession({ binding: binding(), provider: "fake" })).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "provider_mismatch" }) }));
    crashAndReopen(new FakeProvider());
    expect(() => engine!.submit(prompt(session.id, "y"))).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "provider_mismatch" }) }));
  });
});

describe("terminal outcomes from provider evidence", () => {
  it("replays a recorded API error result as a confirmed failure that keeps the conversation (agent-host claude_result_is_error)", async () => {
    const recorded = replay(join(fixtures, "claude_result_is_error.ndjson"));
    open(recorded.scripts, { newID: ids(recorded.nativeSessionID) });
    const session = engine!.createSession({ binding: binding() });
    engine!.submit({ ...prompt(session.id, "auth"), text: recorded.prompts[0] });
    const run = await status("auth", "failed");
    expect(run.error).toMatchObject({ code: "api_error_401", message: expect.stringContaining("Failed to authenticate") });
    // The CLI reported the conversation, so the next prompt resumes it; the session is not uncertain.
    expect(engine!.session(session.id)).toMatchObject({ providerState: { conversationID: recorded.nativeSessionID } });
    expect(engine!.session(session.id).uncertain).toBeUndefined();
  });

  it.each([
    ["a rate limit", { is_error: true, api_error_status: 429, result: "API Error: 429" }, "api_error_429"],
    ["an exhausted turn limit", { subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (1)"] }, "error_max_turns"],
    ["an execution error without a stop request", { subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] x", "Tool crashed"] }, "error_during_execution"],
    ["an abort the runner did not request", { subtype: "error_during_execution", is_error: true, errors: [], terminal_reason: "aborted_streaming" }, "aborted_streaming"]
  ])("reports %s as failed", async (_name, fields, code) => {
    open([exchange => { exchange.emit(init(uuid(1))); exchange.emit(result(uuid(1), fields)); exchange.end(); }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    expect((await status("turn", "failed")).error).toMatchObject({ code });
  });

  it("ignores a result answering another turn and completes on its own", async () => {
    open([exchange => {
      exchange.emit(result(uuid(1), { result: "background wake", user_message_uuid: "99999999-0000-4000-8000-000000000000" }));
      exchange.emit(result(uuid(1), { result: "task notification", origin: { kind: "task-notification" } }));
      exchange.emit(result(uuid(1), { result: "mine", user_message_uuids: [exchange.prompt.uuid] }));
      exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    expect((await status("turn", "completed")).result).toMatchObject({ text: "mine" });
  });

  it.each([
    ["the stream fails", (exchange: Parameters<Script>[0]) => exchange.fail(new Error("socket hang up")), "claude_disconnected"],
    ["the stream ends without a result", (exchange: Parameters<Script>[0]) => exchange.end(), "claude_ended_without_result"]
  ])("is uncertain, never failed or cancelled, when %s", async (_name, finish, code) => {
    open([exchange => { exchange.emit(init(uuid(1))); finish(exchange); }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    const run = await status("turn", "interrupted");
    expect(run.error).toMatchObject({ code, details: { conversationID: uuid(1), promptUUID: uuid(2) } });
    expect(engine!.session(session.id).uncertain).toEqual({ requestID: "turn", native: run.native });
    expect(store().sessions[0].uncertain).toEqual({ requestID: "turn", native: run.native });
  });
});

describe("permissions and user input", () => {
  it("correlates a permission by tool use id, and a denied tool does not fail the turn", async () => {
    let decision: PermissionResult | null | undefined;
    open([async exchange => {
      exchange.emit(init(uuid(1)));
      decision = await exchange.ask("Bash", { command: "rm -rf build" }, "toolu_1", { decisionReason: "\u001b[1mDangerous\u001b[0m rm", suppressAlwaysAllowRule: true }).result;
      exchange.emit(result(uuid(1), { result: "I could not delete build", permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "rm -rf build" } }] }));
      exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    const waiting = await status("turn", "waiting_permission");
    expect(waiting.pending).toEqual({
      id: "turn:toolu_1", kind: "permission", message: "rm -rf build", choices: ["allow", "deny"],
      details: { toolName: "Bash", toolUseID: "toolu_1", reason: "Dangerous rm", input: { command: "rm -rf build" } }
    });
    expect(waiting.native).toBeDefined();
    expect(() => engine!.answer("turn", { pendingID: "turn:toolu_1", value: "allow_session" })).toThrow("Response must match a pending choice");
    engine!.answer("turn", { pendingID: "turn:toolu_1", value: "deny" });
    const done = await status("turn", "completed");
    expect(decision).toMatchObject({ behavior: "deny", message: "User declined tool execution.", toolUseID: "toolu_1" });
    expect(decision).not.toHaveProperty("interrupt");
    expect(done.result).toMatchObject({ permissionDenials: [{ toolName: "Bash", toolUseID: "toolu_1" }] });
  });

  it("grants a session rule for allow_session", async () => {
    let decision: PermissionResult | null | undefined;
    open([async exchange => {
      decision = await exchange.ask("Edit", { file_path: "/x" }, "toolu_1", { title: "Claude wants to edit x" }).result;
      exchange.emit(result(uuid(1))); exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    expect((await status("turn", "waiting_permission")).pending).toMatchObject({ message: "Claude wants to edit x", choices: ["allow", "allow_session", "deny"] });
    engine!.answer("turn", { pendingID: "turn:toolu_1", value: "allow_session" });
    await status("turn", "completed");
    expect(decision).toEqual({
      behavior: "allow", updatedInput: { file_path: "/x" }, toolUseID: "toolu_1", decisionClassification: "user_permanent",
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" }]
    });
  });

  it("asks AskUserQuestion as structured input and returns answers keyed by question", async () => {
    let decision: PermissionResult | null | undefined;
    const questions = [
      { question: "Which layout?", header: "Layout", options: [{ label: "Grid", description: "A grid" }, { label: "Tree" }], multiSelect: false },
      { question: "Which nodes?", header: "", options: [], multiSelect: true }
    ];
    open([async exchange => {
      decision = await exchange.ask("AskUserQuestion", { questions }, "toolu_q").result;
      exchange.emit(result(uuid(1))); exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    const waiting = await status("turn", "waiting_input");
    expect(waiting.pending).toMatchObject({ id: "turn:toolu_q", kind: "input", message: "Which layout?\nWhich nodes?", questions: [
      { id: "Which layout?", header: "Layout", question: "Which layout?", options: [{ label: "Grid", description: "A grid" }, { label: "Tree", description: "Tree" }], multiSelect: false },
      { id: "Which nodes?", header: "Question 2", question: "Which nodes?", options: [], multiSelect: true }
    ] });
    expect(() => engine!.answer("turn", { pendingID: "turn:toolu_q", value: "Grid" })).toThrow("answer every pending question");
    expect(() => engine!.answer("turn", { pendingID: "turn:toolu_q", value: { "Which layout?": "Grid" } })).toThrow("answer every pending question");
    engine!.answer("turn", { pendingID: "turn:toolu_q", value: { "Which layout?": "Grid", "Which nodes?": ["node-a", "node-b"] } });
    await status("turn", "completed");
    expect(decision).toEqual({ behavior: "allow", toolUseID: "toolu_q", updatedInput: { questions, answers: { "Which layout?": "Grid", "Which nodes?": "node-a, node-b" } } });
  });

  it("serializes concurrent callbacks: one is pending at a time, in arrival order", async () => {
    const decisions: Record<string, PermissionResult | null> = {};
    const wait = vi.fn();
    open([async exchange => {
      const first = exchange.ask("Bash", { command: "ls" }, "toolu_a");
      const second = exchange.ask("AskUserQuestion", { questions: [{ question: "Continue?", header: "Go", options: [], multiSelect: false }] }, "toolu_b");
      decisions.a = await first.result;
      decisions.b = await second.result;
      exchange.emit(result(uuid(1))); exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    const original = (engine as any).wait.bind(engine);
    (engine as any).wait = (...args: unknown[]) => { wait(); return original(...args); };
    engine!.submit(prompt(session.id, "turn"));
    expect((await status("turn", "waiting_permission")).pending?.id).toBe("turn:toolu_a");
    // The second callback waits unpersisted: the engine was asked to wait only once.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(wait).toHaveBeenCalledTimes(1);
    expect(store().runs[0].pending?.id).toBe("turn:toolu_a");
    engine!.answer("turn", { pendingID: "turn:toolu_a", value: "allow" });
    const second = await status("turn", "waiting_input");
    expect(second.pending?.id).toBe("turn:toolu_b");
    // A single structured question may be answered with a plain string.
    engine!.answer("turn", { pendingID: "turn:toolu_b", value: "yes" });
    await status("turn", "completed");
    expect(decisions.a).toMatchObject({ behavior: "allow", toolUseID: "toolu_a" });
    expect(decisions.b).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Continue?": "yes" } } });
  });

  it("removes a callback the CLI withdraws, whether pending or still queued, so no answer reaches another request", async () => {
    const decisions: Record<string, PermissionResult | null> = {};
    let withdrawPending!: () => void, withdrawQueued!: () => void;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    open([async exchange => {
      const a = exchange.ask("Bash", { command: "a" }, "toolu_a");
      const b = exchange.ask("Bash", { command: "b" }, "toolu_b");
      const c = exchange.ask("Bash", { command: "c" }, "toolu_c");
      withdrawPending = a.withdraw; withdrawQueued = b.withdraw;
      [decisions.a, decisions.b] = await Promise.all([a.result, b.result]);
      decisions.c = await c.result;
      await released;
      exchange.emit(result(uuid(1))); exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    expect((await status("turn", "waiting_permission")).pending?.id).toBe("turn:toolu_a");
    withdrawQueued();
    withdrawPending();
    expect(() => engine!.answer("turn", { pendingID: "turn:toolu_a", value: "allow" })).toThrow("No matching pending request");
    // The withdrawn queued request is skipped: the next one shown is c.
    expect((await status("turn", "waiting_permission")).pending?.id).toBe("turn:toolu_c");
    engine!.answer("turn", { pendingID: "turn:toolu_c", value: "allow" });
    release();
    await status("turn", "completed");
    expect(decisions.a).toMatchObject({ behavior: "deny", interrupt: true });
    expect(decisions.b).toMatchObject({ behavior: "deny", interrupt: true });
    expect(decisions.c).toMatchObject({ behavior: "allow", toolUseID: "toolu_c" });
    // The withdrawal itself was durable: a running update cleared the pending request.
    expect(store().runs[0].status).toBe("completed");
  });
});

describe("cancellation", () => {
  it("requests an interrupt and confirms cancellation from the aborted result", async () => {
    const sdk = open([async exchange => {
      exchange.emit(init(uuid(1)));
      await exchange.interrupted;
      exchange.emit(result(uuid(1), { subtype: "error_during_execution", is_error: true, errors: [], terminal_reason: "aborted_streaming" }));
      exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    await status("turn", "running");
    await vi.waitFor(() => expect(store().runs[0].native).toBeDefined());
    expect(engine!.cancel("turn").status).toBe("stopping");
    const run = await status("turn", "cancelled");
    expect(sdk.queries[0].interrupts).toBe(1);
    expect(run.native).toMatchObject({ conversationID: uuid(1) });
    // A confirmed cancellation leaves a known conversation: it is checkpointed, and the session is not uncertain.
    expect(engine!.session(session.id)).toMatchObject({ providerState: { conversationID: uuid(1) } });
    expect(engine!.session(session.id).uncertain).toBeUndefined();
  });

  it("reports completion when the turn finishes before the interrupt takes effect", async () => {
    open([async exchange => {
      await exchange.interrupted;
      exchange.emit(result(uuid(1), { result: "finished first" }));
      exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    await vi.waitFor(() => expect(engine!.run("turn").native).toBeDefined());
    engine!.cancel("turn");
    expect((await status("turn", "completed")).result).toMatchObject({ text: "finished first" });
  });

  it("denies a pending permission with interrupt and confirms cancellation", async () => {
    let decision: PermissionResult | null | undefined;
    open([async exchange => {
      const asked = exchange.ask("Bash", { command: "sleep 100" }, "toolu_1");
      await exchange.interrupted;
      decision = await asked.result;
      exchange.emit(result(uuid(1), { subtype: "error_during_execution", is_error: true, errors: [], terminal_reason: "aborted_tools" }));
      exchange.end();
    }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    await status("turn", "waiting_permission");
    const stopping = engine!.cancel("turn");
    expect(stopping).toMatchObject({ status: "stopping" });
    expect(stopping.pending).toBeUndefined();
    await status("turn", "cancelled");
    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
    expect(() => engine!.answer("turn", { pendingID: "turn:toolu_1", value: "allow" })).toThrow("No matching pending request");
  });

  it.each([
    ["the CLI never answers the interrupt", "hang" as const, (_exchange: Parameters<Script>[0]) => {}, "pending"],
    ["the interrupt is refused and the stream then fails", "reject" as const, (exchange: Parameters<Script>[0]) => exchange.fail(new Error("EPIPE")), "failed"],
    ["the interrupt is acknowledged but the stream ends without a result", "acknowledge" as const, (exchange: Parameters<Script>[0]) => exchange.end(), "acknowledged"]
  ])("keeps the run uncertain when %s", async (_name, mode, after, interrupt) => {
    open([async exchange => {
      exchange.emit(init(uuid(1)));
      await exchange.interrupted;
      // Let the interrupt promise settle before the stream does.
      await new Promise(resolve => setTimeout(resolve, 5));
      after(exchange);
    }], { interrupt: mode });
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "turn"));
    await vi.waitFor(() => expect(engine!.run("turn").native).toBeDefined());
    engine!.cancel("turn");
    const run = await status("turn", "interrupted");
    expect(run.error).toMatchObject({ code: "cancel_unconfirmed", details: { interrupt } });
    expect(engine!.session(session.id).uncertain).toEqual({ requestID: "turn", native: run.native });
  });

  it("confirms cancellation of work that never started, without querying", async () => {
    const sdk = open([]);
    engine = new RunnerEngine(storage, (engine as any).provider, { autoDispatch: false });
    const session = engine.createSession({ binding: binding() });
    engine.submit(prompt(session.id, "turn"));
    expect(engine.cancel("turn").status).toBe("cancelled");
    expect(sdk.queries).toHaveLength(0);
  });
});

describe("uncertain sessions", () => {
  async function uncertainSession(scripts: Script[]) {
    const sdk = open([exchange => { exchange.emit(init(uuid(1))); exchange.fail(new Error("socket hang up")); }, ...scripts]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "lost"));
    const lost = await status("lost", "interrupted");
    return { sdk, session, lost };
  }

  it("refuses a prompt that does not acknowledge the uncertain run", async () => {
    const { session } = await uncertainSession([]);
    for (const recovery of [undefined, { after: "other", mode: "resume" }]) {
      expect(() => engine!.submit(prompt(session.id, "next", recovery ? { recovery } : {}))).toThrow(expect.objectContaining({
        body: expect.objectContaining({ code: "session_uncertain", details: { requestID: "lost", modes: ["resume", "fresh"] } })
      }));
    }
    expect(() => engine!.submit(prompt(engine!.createSession({ binding: binding() }).id, "certain", { recovery: { after: "lost", mode: "fresh" } })))
      .toThrow("recovery applies only while the session is uncertain");
  });

  it("resumes the recorded conversation when asked, and a completed turn reconciles the session", async () => {
    const { sdk, session, lost } = await uncertainSession([exchange => { exchange.emit(result(uuid(1), { result: "back" })); exchange.end(); }]);
    engine!.submit(prompt(session.id, "next", { recovery: { after: "lost", mode: "resume" } }));
    await status("next", "completed");
    expect(sdk.queries[1].options).toMatchObject({ resume: (lost.native as any).conversationID });
    expect(engine!.session(session.id)).toMatchObject({ providerState: { conversationID: uuid(1) } });
    expect(engine!.session(session.id).uncertain).toBeUndefined();
  });

  it("starts a new conversation for fresh, and keeps the session uncertain if that turn fails", async () => {
    const { sdk, session } = await uncertainSession([exchange => { exchange.emit(result(uuid(3), { is_error: true, api_error_status: 529 })); exchange.end(); }]);
    engine!.submit(prompt(session.id, "next", { recovery: { after: "lost", mode: "fresh" } }));
    expect((await status("next", "failed")).error).toMatchObject({ code: "api_error_529" });
    expect(sdk.queries[1].options).toMatchObject({ sessionId: uuid(3) });
    expect(sdk.queries[1].options.resume).toBeUndefined();
    expect(engine!.session(session.id).uncertain).toMatchObject({ requestID: "lost" });
  });

  it("carries identifiers recorded before a crash into the restarted session, so recovery resumes them", async () => {
    // The first runner records its identifiers and then dies mid-turn.
    open([exchange => { exchange.emit(init(uuid(1))); }]);
    const session = engine!.createSession({ binding: binding() });
    engine!.submit(prompt(session.id, "lost"));
    await vi.waitFor(() => expect(store().runs[0].native).toBeDefined());
    const native = store().runs[0].native;
    const sdk = scripted([exchange => { exchange.emit(result(uuid(1))); exchange.end(); }]);
    crashAndReopen(new ClaudeProvider(sdk.query, { permissionMode: "default" }, { stopTimeoutMs: 50, newID: ids(uuid(50)) }));
    expect(engine!.run("lost")).toMatchObject({ status: "interrupted", native, error: { code: "restart_uncertain" } });
    expect(engine!.session(session.id).uncertain).toEqual({ requestID: "lost", native });
    engine!.submit(prompt(session.id, "next", { recovery: { after: "lost", mode: "resume" } }));
    await status("next", "completed");
    expect(sdk.queries[0].options).toMatchObject({ resume: uuid(1) });
  });
});

describe("bridge access from runner agents", () => {
  it("refuses every bridge request when the runner disabled it for the agent's process", async () => {
    vi.stubEnv("ENSO_RUNNER_BRIDGE", "disabled");
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(new BridgeClient("http://127.0.0.1:17650", "token").request("/v1/status")).rejects.toMatchObject({ body: { code: "bridge_unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loading the SDK", () => {
  it("reports a missing optional SDK as runner_provider_unavailable", async () => {
    vi.resetModules();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => { throw new Error("Cannot find package"); });
    try {
      const { loadClaudeQuery } = await import("../../src/runner/claude.js");
      await expect(loadClaudeQuery()).rejects.toMatchObject({ body: { code: "runner_provider_unavailable" } });
    } finally { vi.doUnmock("@anthropic-ai/claude-agent-sdk"); vi.resetModules(); }
  });
});
