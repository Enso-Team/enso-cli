import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { EnsoCliError, errorEnvelope } from "../errors.js";
import { RunnerEngine } from "./engine.js";
import { FakeProvider, type RunnerProvider } from "./provider.js";
import { runnerVersion, runnerVersionHeader } from "./protocol.js";
import { RunnerStorage } from "./storage.js";

export type RunnerService = {
  directory: string; socketPath: string; engine: RunnerEngine;
  closed: Promise<void>; stop: () => Promise<void>;
};

const errorStatus = new Map<string, number>([
  ["unauthorized", 401], ["payload_too_large", 413],
  ["incompatible_runner_version", 426],
  ["session_busy", 409], ["request_conflict", 409], ["pending_not_found", 409], ["runner_stopping", 409],
  ["run_not_found", 404], ["session_not_found", 404], ["route_not_found", 404], ["cursor_expired", 410],
  ["runner_storage_failure", 503]
]);

/** How often a runner with retention looks for finished runs to delete. */
const retentionIntervalMs = 60 * 60 * 1000;

/** The longest retention `--retain-days` accepts: a century. */
export const maxRetainDays = 36_500;
/**
 * `retainDays`: delete finished runs (and their events) this many days after their last update; unset keeps everything.
 * `signal`: aborted once the caller means to stop. Startup still completes, so the caller can stop the service it
 * returns, but runs accepted before startup are not dispatched: shutdown cancels them instead.
 */
export async function startRunner(options: { directory?: string; provider?: RunnerProvider; autoDispatch?: boolean; retainDays?: number; signal?: AbortSignal } = {}): Promise<RunnerService> {
  // Checked before ownership: 0 or a negative count would delete every finished run, and NaN would fail every pass.
  const retain = options.retainDays;
  if (retain !== undefined && !(Number.isFinite(retain) && retain > 0 && retain <= maxRetainDays)) {
    throw new EnsoCliError("invalid_input", `retainDays must be a number of days greater than 0 and at most ${maxRetainDays}`);
  }
  const storage = new RunnerStorage(options.directory);
  storage.acquire();
  const socketPath = join(storage.directory, "control.sock");
  if (Buffer.byteLength(socketPath) > 103) {
    try { storage.release(); } catch { /* report the path, not a failure to clean up after it */ }
    throw new EnsoCliError("runner_path_too_long", "Unix socket path exceeds macOS limits; choose a shorter --directory");
  }
  const token = randomBytes(32).toString("hex");
  let engine: RunnerEngine;
  let stopTask: Promise<void> | undefined;
  let initialized = false;
  let fatalError: Error | undefined;
  let retention: NodeJS.Timeout | undefined;
  let firstPass: NodeJS.Immediate | undefined;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // Library callers may only await stop(); retain the rejection for callers of closed.
  void closed.catch(() => {});
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
    void handle(request, response).catch(async error => {
      // Replying before the body is consumed closes the socket under a still-writing client,
      // which then sees EPIPE instead of the reply. Drain (bounded by requestTimeout), then reply.
      if (!request.complete) { request.resume(); await finished(request).catch(() => {}); }
      const envelope = errorEnvelope(error);
      const code = !envelope.ok ? envelope.error.code : "invalid_input";
      send(response, errorStatus.get(code) ?? 400, envelope);
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  const shutdownReplies = new Set<Promise<void>>();
  const cleanup = (): Error | undefined => {
    let first: Error | undefined;
    for (const step of [
      () => rmSync(join(storage.directory, "connection.json"), { force: true }),
      () => rmSync(socketPath, { force: true }),
      () => storage.release()
    ]) {
      try { step(); }
      catch (error) { first ??= error instanceof Error ? error : new Error("Runner cleanup failed"); }
    }
    return first;
  };

  const stop = (): Promise<void> => {
    if (stopTask) return stopTask;
    stopTask = (async () => {
      clearImmediate(firstPass);
      clearInterval(retention);
      try { await engine.shutdown(); }
      catch (error) { fatalError ??= error instanceof Error ? error : new Error("Runner shutdown failed"); }
      const closedServer = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      // Let in-flight shutdown replies flush before force-closing, bounded so a stuck client cannot hang stop.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(shutdownReplies), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
      server.closeAllConnections();
      await closedServer;
      const cleanupError = cleanup();
      fatalError ??= cleanupError;
      if (fatalError) fail(fatalError); else finish();
    })();
    return stopTask;
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // No browser-origin access, no CORS, no unauthenticated discovery endpoint.
    const supplied = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new EnsoCliError("unauthorized", "Runner authentication required");
    }
    if (request.headers[runnerVersionHeader.toLowerCase()] !== String(runnerVersion)) {
      throw new EnsoCliError("incompatible_runner_version", "This runner requires protocol version 1", { supportedVersions: [runnerVersion] });
    }
    const target = request.url ?? "/";
    // Route on the raw path: URL normalization would rewrite dot segments (even percent-encoded) into other routes.
    const path = target.split("?", 1)[0];
    const url = new URL(target, "http://runner.local");
    const method = request.method;
    if (method === "GET" && path === "/v1/snapshot") return send(response, 200, { ok: true, data: engine.snapshot() });
    if (method === "GET" && path === "/v1/events") {
      const after = url.searchParams.get("after");
      if (after === null || !/^\d+$/.test(after)) throw new EnsoCliError("invalid_cursor", "events requires an integer after cursor");
      return send(response, 200, { ok: true, data: engine.events(Number(after)) });
    }
    const session = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && session) return send(response, 200, { ok: true, data: engine.session(decodeURIComponent(session[1]).toLowerCase()) });
    const run = /^\/v1\/runs\/([^/]+)(?:\/(cancel|respond))?$/.exec(path);
    if (method === "GET" && run && !run[2]) return send(response, 200, { ok: true, data: engine.run(decodeURIComponent(run[1])) });
    if (method === "POST" && path === "/v1/sessions") return send(response, 201, { ok: true, data: engine.createSession(await body(request)) });
    if (method === "POST" && path === "/v1/prompts") return send(response, 200, { ok: true, data: engine.submit(await body(request)) });
    if (method === "POST" && run?.[2] === "cancel") return send(response, 200, { ok: true, data: engine.cancel(decodeURIComponent(run[1])) });
    if (method === "POST" && run?.[2] === "respond") return send(response, 200, { ok: true, data: engine.answer(decodeURIComponent(run[1]), await body(request)) });
    if (method === "POST" && path === "/v1/shutdown") {
      // "close" fires after the reply is flushed or if the client disconnects mid-shutdown.
      const replied = new Promise<void>(resolve => response.once("close", () => { shutdownReplies.delete(replied); resolve(); void stop(); }));
      shutdownReplies.add(replied);
      await engine.shutdown();
      if (fatalError) throw fatalError;
      return send(response, 200, { ok: true, data: { stopped: true } });
    }
    throw new EnsoCliError("route_not_found", "Runner route not found");
  }

  try {
    engine = new RunnerEngine(storage, options.provider ?? new FakeProvider(), {
      autoDispatch: options.autoDispatch,
      onFatal: () => {
        if (initialized) {
          fatalError = new EnsoCliError("runner_storage_failure", "Runner stopped after a durable write failed; restart and inspect state");
          setImmediate(() => { void stop(); });
        }
      }
    });
    // Ownership is established before removing stale runtime files.
    rmSync(socketPath, { force: true });
    rmSync(join(storage.directory, "connection.json"), { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    chmodSync(socketPath, 0o600);
    storage.write("connection.json", { protocolVersion: runnerVersion, socketPath, token, pid: process.pid });
    initialized = true;
    // Passes run once the service is up, so a backlog never holds back `ready` or dispatch, and stop() or a signal ends
    // a pass at its next step. The first starts on the next turn, after startRunner returns: none of its work, not even
    // its first batch, runs before `ready`. A failed deletion or reclaim fails the engine closed, which stops the
    // service as any failed write after `ready` does. A pass still working through a backlog an hour later is left to
    // finish rather than joined.
    if (retain !== undefined) {
      let expiring = false;
      const expire = () => {
        if (expiring) return;
        expiring = true;
        void engine.deleteFinishedBefore(new Date(Date.now() - retain * 24 * 60 * 60 * 1000))
          .catch(() => { /* see above */ }).finally(() => { expiring = false; });
      };
      firstPass = setImmediate(expire);
      (retention = setInterval(expire, retentionIntervalMs)).unref();
    }
    // A stop requested during startup (a signal handled at the listen above) arrives before the caller has a service
    // to stop: dispatching here would start work it already asked to stop.
    if (options.autoDispatch !== false && !options.signal?.aborted) engine.dispatchAccepted();
    return { directory: storage.directory, socketPath, engine, closed, stop };
  } catch (error) {
    server.close();
    cleanup();
    throw error;
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new EnsoCliError("invalid_input", "JSON requests require Content-Type: application/json");
  }
  // Oversized bodies are drained here rather than buffered; see the error handler.
  const limit = 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= limit) chunks.push(Buffer.from(chunk));
  }
  if (size > limit) throw new EnsoCliError("payload_too_large", "Request exceeds 1 MiB");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new EnsoCliError("invalid_input", "Request body must be valid JSON"); }
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", [runnerVersionHeader]: String(runnerVersion) });
  response.end(JSON.stringify(value) + "\n");
}
