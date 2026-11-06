import { readFileSync } from "node:fs";
import type { CanUseTool, Options, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery } from "../../src/runner/claude.js";

/** One SDK query as a test drives it: what the provider sent, and the CLI's side of the exchange. */
export type Exchange = {
  options: Options;
  prompt: SDKUserMessage;
  emit(frame: Record<string, unknown>): void;
  /** The stream ends (the CLI exited) without further frames. */
  end(): void;
  /** The stream fails (the CLI disconnected or crashed). */
  fail(error: Error): void;
  /** Calls the provider's canUseTool as the CLI would; `withdraw` aborts the request from the CLI side. */
  ask(toolName: string, input: Record<string, unknown>, toolUseID: string, extra?: Partial<Parameters<CanUseTool>[2]>): { result: Promise<PermissionResult | null>; withdraw: () => void };
  /** Resolves when the provider calls interrupt(). */
  interrupted: Promise<void>;
  closed: Promise<void>;
};
export type Script = (exchange: Exchange) => void | Promise<void>;
export type InterruptMode = "acknowledge" | "reject" | "hang";

/**
 * A stand-in for the SDK's `query()`: each call runs the next script against an in-memory stream. Nothing is spawned.
 * `interrupt` says how the CLI answers an interrupt request.
 */
export function scripted(scripts: Script[], { interrupt = "acknowledge" }: { interrupt?: InterruptMode } = {}) {
  const queries: { options: Options; prompt?: SDKUserMessage; interrupts: number; closed: boolean }[] = [];
  const errors: unknown[] = [];
  const query: ClaudeQuery = ({ prompt, options }) => {
    const script = scripts[queries.length];
    if (!script) throw new Error(`Unexpected query ${queries.length + 1}`);
    const record: (typeof queries)[number] = { options, interrupts: 0, closed: false };
    queries.push(record);
    const frames: SDKMessage[] = [];
    const waiters: { resolve: (value: IteratorResult<SDKMessage>) => void; reject: (error: unknown) => void }[] = [];
    let finished: { done: true } | { error: unknown } | undefined;
    const flush = () => {
      while (waiters.length && (frames.length || finished)) {
        const waiter = waiters.shift()!;
        if (frames.length) waiter.resolve({ value: frames.shift()!, done: false });
        else if (finished && "error" in finished) waiter.reject(finished.error);
        else waiter.resolve({ value: undefined, done: true });
      }
    };
    let markInterrupted!: () => void, markClosed!: () => void;
    const interrupted = new Promise<void>(resolve => { markInterrupted = resolve; });
    const closed = new Promise<void>(resolve => { markClosed = resolve; });
    const controllers = new Set<AbortController>();
    void (async () => {
      const first = await prompt[Symbol.asyncIterator]().next();
      record.prompt = first.value as SDKUserMessage;
      await script({
        options, prompt: record.prompt, interrupted, closed,
        emit: frame => { if (!finished && !record.closed) { frames.push(frame as unknown as SDKMessage); flush(); } },
        end: () => { finished ??= { done: true }; flush(); },
        fail: error => { finished ??= { error }; flush(); },
        ask: (toolName, input, toolUseID, extra = {}) => {
          const controller = new AbortController();
          controllers.add(controller);
          const result = options.canUseTool!(toolName, input, { signal: controller.signal, toolUseID, requestId: `request-${toolUseID}`, ...extra });
          return { result, withdraw: () => controller.abort() };
        }
      });
    })().catch(error => errors.push(error));
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<SDKMessage>>((resolve, reject) => { waiters.push({ resolve, reject }); flush(); })
      }),
      interrupt: () => {
        record.interrupts++;
        markInterrupted();
        if (interrupt === "reject") return Promise.reject(new Error("CLI did not accept the interrupt"));
        if (interrupt === "hang") return new Promise(() => {});
        return Promise.resolve({ still_queued: [] });
      },
      close: () => {
        record.closed = true;
        // Closing the query tells the CLI's pending callbacks they were cancelled, as the SDK does.
        for (const controller of controllers) controller.abort();
        finished ??= { done: true };
        flush();
        markClosed();
      }
    };
  };
  return { query, queries, errors };
}

export const init = (sessionID: string) => ({ type: "system", subtype: "init", session_id: sessionID, uuid: "11111111-0000-4000-8000-000000000001", cwd: "/", tools: [], model: "claude-test", permissionMode: "default" });
export const assistant = (sessionID: string, text: string) => ({
  type: "assistant", session_id: sessionID, parent_tool_use_id: null, uuid: "11111111-0000-4000-8000-000000000002",
  message: { role: "assistant", content: [{ type: "text", text }] }
});
export function result(sessionID: string, fields: Record<string, unknown> = {}) {
  return {
    type: "result", subtype: "success", is_error: false, result: "done", session_id: sessionID, uuid: "11111111-0000-4000-8000-000000000003",
    duration_ms: 10, duration_api_ms: 8, num_turns: 1, stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {},
    permission_denials: [], terminal_reason: "completed", ...fields
  };
}

type Entry = { type: string; label?: string; frame?: Record<string, any>; metadata?: Record<string, any> };
/**
 * Scripts that replay a recorded transcript from test/runner/fixtures/agent-host: one per recorded `query.open`, each
 * checking the provider opened the same conversation identity and then emitting that query's inbound frames.
 */
export function replay(path: string): { scripts: Script[]; nativeSessionID: string; prompts: string[] } {
  const entries = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Entry);
  const start = entries[0];
  const queries: { open: Record<string, any>; frames: Record<string, any>[] }[] = [];
  for (const entry of entries.slice(1)) {
    if (entry.type === "expect_outbound" && entry.frame?.type === "query.open") queries.push({ open: entry.frame.options, frames: [] });
    else if (entry.type === "emit_inbound") queries.at(-1)!.frames.push(entry.frame!);
  }
  const scripts = queries.map(({ open, frames }): Script => exchange => {
    const identity = (options: Record<string, unknown>) => ({ sessionId: options.sessionId, resume: options.resume });
    if (JSON.stringify(identity(exchange.options as Record<string, unknown>)) !== JSON.stringify(identity(open))) {
      exchange.fail(new Error(`Replay expected ${JSON.stringify(identity(open))}, received ${JSON.stringify(identity(exchange.options as Record<string, unknown>))}`));
      return;
    }
    for (const frame of frames) exchange.emit(frame);
    exchange.end();
  });
  return { scripts, nativeSessionID: start.metadata!.nativeSessionId, prompts: start.metadata!.prompts };
}
