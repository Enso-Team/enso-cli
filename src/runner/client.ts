import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { basename, dirname, join } from "node:path";
import { z } from "zod/v3";
import { envelopeSchema } from "../client.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";
import { runnerVersion, runnerVersionHeader } from "./protocol.js";
import { runnerDirectory } from "./storage.js";

type Connection = { socketPath: string; token: string; protocolVersion: number; pid: number };
const timeout = (message: string) => new EnsoCliError("runner_timeout", message);

export async function runnerCall(method: string, path: string, body?: unknown, directory = runnerDirectory(), options: { timeoutMs?: number } = {}): Promise<EnsoEnvelope> {
  return send(discover(directory), method, path, body, options.timeoutMs ?? 30_000);
}

/** Requests shutdown, then waits until the service has exited and released its owner record. */
export async function shutdownRunner(directory = runnerDirectory(), options: { timeoutMs?: number } = {}): Promise<EnsoEnvelope> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const connection = discover(directory);
  const envelope = await send(connection, "POST", "/v1/shutdown", undefined, Math.max(1, deadline - Date.now()));
  if (!envelope.ok) return envelope;
  // Discovery and the owner record are removed before the process exits. An in-process
  // runner (library use, tests) never exits, so for it that cleanup is the completion signal.
  const gone = (name: string) => { try { lstatSync(join(directory, name)); return false; } catch { return true; } };
  const exited = () => {
    if (connection.pid === process.pid) return gone("connection.json") && gone("owner");
    try { process.kill(connection.pid, 0); return false; }
    // EPERM: the PID now belongs to another user's process, so the runner (same user) is gone.
    catch (error) { return ["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""); }
  };
  while (!exited()) {
    if (Date.now() >= deadline) throw timeout("Runner accepted shutdown but has not exited; check the process before starting another runner");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return envelope;
}

function discover(directory: string): Connection {
  let connection: Connection;
  try {
    connection = z.object({ socketPath: z.string(), token: z.string().min(1), protocolVersion: z.number(), pid: z.number().int().positive() }).parse(
      JSON.parse(readFileSync(join(directory, "connection.json"), "utf8"))
    );
  } catch { throw new EnsoCliError("runner_unavailable", "No runner connection found; start `enso runner serve --provider fake`"); }
  if (connection.protocolVersion !== runnerVersion) throw new EnsoCliError("incompatible_runner_version", "Runner discovery uses an incompatible protocol version");
  // Compare canonical directories so equivalent spellings (symlinks, relative paths) of the store agree.
  let expectedSocket = false;
  try { expectedSocket = basename(connection.socketPath) === "control.sock" && realpathSync(dirname(connection.socketPath)) === realpathSync(directory); }
  catch { /* unresolvable path is unexpected */ }
  if (!expectedSocket) throw new EnsoCliError("invalid_runner_connection", "Discovery names an unexpected socket path");
  return connection;
}

function send(connection: Connection, method: string, path: string, body: unknown, timeoutMs: number): Promise<EnsoEnvelope> {
  if (!path.startsWith("/v1/") || /[\r\n]/.test(path)) throw new EnsoCliError("invalid_input", "Expected a /v1/ runner path");
  let timer: NodeJS.Timeout | undefined;
  return new Promise<EnsoEnvelope>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath: connection.socketPath, path, method, agent: false, headers: {
      Authorization: `Bearer ${connection.token}`, [runnerVersionHeader]: String(runnerVersion),
      ...(data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) })
    } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", () => reject(new EnsoCliError("runner_unavailable", "Runner response disconnected; inspect the run after reconnecting")));
      response.on("end", () => {
        const details = { status: response.statusCode, ...(method === "GET" ? {} : { outcome: "unknown" }) };
        let json: unknown;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(new EnsoCliError("invalid_response", "Runner returned invalid JSON", details)); }
        const parsed = envelopeSchema.safeParse(json);
        if (parsed.success) resolve(parsed.data as EnsoEnvelope);
        else reject(new EnsoCliError("invalid_response", "Runner returned an invalid envelope", details));
      });
    });
    // Rejecting before destroy() means the resulting socket error cannot replace the timeout.
    timer = setTimeout(() => {
      reject(timeout(`Runner did not reply within ${timeoutMs} ms; inspect run state before retrying with the same requestID`));
      req.destroy();
    }, timeoutMs);
    req.on("error", () => reject(new EnsoCliError("runner_unavailable", "Runner disconnected; reconnect and inspect state before retrying with the same requestID")));
    req.end(data);
  }).finally(() => clearTimeout(timer));
}
