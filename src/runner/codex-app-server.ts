/**
 * The Codex app-server transport behind a promise interface. This module is the runner's only Effect boundary: the
 * vendored JSON-RPC client (src/vendor/effect-codex-app-server, copied unmodified from agent-host) runs inside one
 * Effect scope per connection, and `close()` releases that scope, then the process. Nothing else in Enso imports
 * Effect or the vendored code, and the CLI loads this module only when it serves the Codex provider.
 */
import { spawn as spawnChild } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as CodexClient from "../vendor/effect-codex-app-server/src/client.js";
import * as CodexError from "../vendor/effect-codex-app-server/src/errors.js";
import { appendStderrTail, stderrExcerpt } from "../vendor/effect-codex-app-server/src/_internal/stdio.js";
import { CodexRequestError, type CodexConnect, type CodexConnection, type CodexDiagnostic, type CodexSpawn, type CodexTermination } from "./codex-connection.js";
import { ProviderCleanupError } from "./provider.js";

/**
 * Starts the app-server in its own process group, so a terminal's Ctrl-C reaches the runner (which stops the turn)
 * rather than Codex, and so cleanup can signal the shells Codex started along with it.
 */
export const spawnCodex: CodexSpawn = (command, args, { cwd, env }) => {
  const child = spawnChild(command, [...args], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  return {
    get pid() { return child.pid; },
    stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
    isAlive: () => {
      if (child.pid === undefined) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    },
    kill: signal => {
      try { if (child.pid !== undefined) return void process.kill(-child.pid, signal); }
      catch { /* the group is gone, or was never formed: signal the process itself */ }
      child.kill(signal);
    },
    on: (event: string, listener: (...args: any[]) => void) => child.on(event, listener)
  };
};

const defaultExitGraceMs = 2000;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref());

/** Spawns the app-server and connects the vendored client to its stdio. Rejects, with nothing left running, if the spawn fails. */
export const connectCodex: CodexConnect = async options => {
  const child = (options.spawn ?? spawnCodex)(options.command, options.args, { cwd: options.cwd, env: options.env });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exited = new Promise<void>(resolve => child.on("exit", (code, signal) => { exit = { code, signal }; resolve(); }));
  // Errors after the spawn (a kill that fails, a broken pipe) surface through the streams and the exit instead.
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError ??= error; });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => { /* reported by the protocol as a transport failure */ });
  await new Promise<void>((resolve, reject) => {
    child.on("spawn", resolve);
    child.on("error", reject);
  });
  if (spawnError) throw spawnError;

  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { tail = appendStderrTail(tail, chunk); });

  const diagnose = (diagnostic: CodexDiagnostic) => { try { options.onDiagnostic?.(diagnostic); } catch { /* a diagnostic sink cannot fail the transport */ } };
  const logger = Logger.make(({ message, logLevel, fiber }) => diagnose({
    level: String(logLevel),
    message: (Array.isArray(message) ? message : [message]).map(part => typeof part === "string" ? part : String(part)).join(" "),
    annotations: { ...fiber.getRef(References.CurrentLogAnnotations) }
  }));
  // Every fiber the client forks inherits this, so its warnings reach the provider instead of the runner's stdout.
  const logged = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));

  // Writes in flight, and writes done: close() lets the writer finish what the protocol already queued.
  let writing = 0, writes = 0;
  const failure = (method: string) => (error: unknown) => PlatformError.systemError({ _tag: "Unknown", module: "CodexAppServer", method, cause: error });
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromAsyncIterable(child.stdout as AsyncIterable<Uint8Array>, failure("readStdout")),
    stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.callback<void, PlatformError.PlatformError>(resume => {
      writing++;
      child.stdin.write(chunk, error => {
        writing--; writes++;
        resume(error ? Effect.fail(failure("writeStdin")(error)) : Effect.void);
      });
    })),
    stderr: () => Sink.drain
  });
  // Asked for once stdout ends: the exit, if it follows promptly (the protocol waits 250 ms for it).
  const terminationError = Effect.promise(() => exited).pipe(Effect.map(() => {
    const stderr = stderrExcerpt(tail);
    return new CodexError.CodexAppServerProcessExitedError({
      ...(exit?.code === null || exit?.code === undefined ? {} : { code: exit.code }),
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      ...(stderr ? { stderr } : {})
    });
  }));

  const scope = Effect.runSync(Scope.make("sequential"));
  const stop = new AbortController();
  let client: CodexClient.CodexAppServerClient["Service"];
  try {
    client = await Effect.runPromise(logged(Scope.provide(scope)(CodexClient.make(stdio, {}, terminationError))));
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    child.kill("SIGKILL");
    throw error;
  }

  const describe = (error: unknown): CodexTermination => {
    const stderr = stderrExcerpt(tail);
    const process = { ...(exit ? { exitCode: exit.code, signal: exit.signal } : {}), ...(stderr ? { stderr } : {}) };
    if (error instanceof CodexError.CodexAppServerProcessExitedError || error instanceof CodexError.CodexAppServerInputStreamEndedError) {
      return { code: "codex_exited", message: error.message, ...process };
    }
    if (error instanceof CodexError.CodexAppServerProtocolParseError) return { code: "codex_malformed_message", message: error.message, ...process };
    return { code: "codex_transport_error", message: error instanceof Error ? error.message : String(error), ...process };
  };
  const terminated = Effect.runPromiseExit(client.awaitTermination, { signal: stop.signal }).then(exit => {
    if (Exit.isSuccess(exit) || Cause.hasInterrupts(exit.cause)) return { code: "closed", message: "The runner closed the connection" } satisfies CodexTermination;
    return describe(Cause.squash(exit.cause));
  });

  const run = async <A>(method: string, effect: Effect.Effect<A, CodexError.CodexAppServerError>): Promise<A> => {
    if (stop.signal.aborted) throw new CodexRequestError("transport", method, "The connection is closed");
    const exit = await Effect.runPromiseExit(logged(effect), { signal: stop.signal });
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.hasInterrupts(exit.cause)) throw new CodexRequestError("transport", method, "The connection closed before Codex answered");
    throw classify(method, Cause.squash(exit.cause));
  };

  let closing: Promise<void> | undefined;
  return {
    pid: child.pid,
    request: (method, params) => run(method, client.request(method, params)),
    notify: method => run(method, client.notify(method, undefined)),
    onNotification: (method, handler) => Effect.runSync(client.handleServerNotification(method, params => Effect.sync(() => {
      try { handler(params); }
      catch (error) { diagnose({ level: "Error", message: `The ${method} handler failed: ${error instanceof Error ? error.message : String(error)}`, annotations: { method } }); }
    }))),
    onRequest: (method, handler) => Effect.runSync(client.handleServerRequest(method, params => Effect.tryPromise({
      try: withdrawn => handler(params, withdrawn),
      catch: error => CodexError.CodexAppServerRequestError.internalError(error instanceof Error ? error.message : "The runner could not answer this request")
    }))),
    terminated,
    stderr: () => tail,
    close: () => closing ??= (async () => {
      const grace = options.exitGraceMs ?? defaultExitGraceMs;
      // A last response or notification may still be queued: Effect resumes the writer on setImmediate, so wait until
      // it has been idle for a few turns (bounded) before ending the scope that owns it.
      const deadline = Date.now() + grace;
      for (let idle = 0, seen = writes; idle < 3 && Date.now() < deadline;) {
        await new Promise(resolve => setImmediate(resolve));
        if (writing === 0 && writes === seen) idle++;
        else { idle = 0; seen = writes; }
      }
      stop.abort();
      // Interrupts the reader, the writer and any request handler still waiting on the runner.
      await Effect.runPromise(Scope.close(scope, Exit.void));
      child.stdin.end();
      const gone = () => exit !== undefined && !child.isAlive();
      const closeStreams = () => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const awaitGroupExit = async () => {
        const deadline = Date.now() + grace;
        if (!exit) await Promise.race([exited, wait(grace)]);
        // A leader's exit says nothing about its children. Keep checking the group for the rest of this grace period.
        while (!gone() && Date.now() < deadline) await wait(Math.min(25, deadline - Date.now()));
        return gone();
      };
      for (const signal of [undefined, "SIGTERM", "SIGKILL"] as const) {
        if (gone()) break;
        if (signal) {
          try { child.kill(signal); } catch { /* checked below, never mistaken for an exit */ }
        }
        if (await awaitGroupExit()) break;
      }
      if (!gone()) {
        // A timeout is not proof of exit. Fail the engine closed and retain service ownership until the whole group
        // is gone, rather than releasing this session for another prompt while its execution may still be alive.
        const untilGone = async () => {
          while (!gone()) await delay(100);
          closeStreams();
        };
        throw new ProviderCleanupError("Codex's process group did not exit after SIGKILL; runner stopped accepting work", untilGone(), { pid: child.pid ?? null });
      }
      closeStreams();
    })()
  };
};

function classify(method: string, error: unknown): CodexRequestError {
  if (error instanceof CodexError.CodexAppServerRequestError) {
    if (error.operation === "encode-payload") return new CodexRequestError("not_sent", method, error.message, error.code);
    if (error.operation === "decode-payload") return new CodexRequestError("malformed", method, error.message, error.code);
    return new CodexRequestError("rejected", method, error.message, error.code);
  }
  return new CodexRequestError("transport", method, error instanceof Error ? error.message : String(error));
}
