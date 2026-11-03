import { readFileSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";
import { runnerVersion, runnerVersionHeader } from "./protocol.js";
import { runnerDirectory } from "./storage.js";

export async function runnerCall(method: string, path: string, body?: unknown, directory = runnerDirectory()): Promise<EnsoEnvelope> {
  let connection: { socketPath: string; token: string; protocolVersion: number };
  try {
    connection = z.object({ socketPath: z.string(), token: z.string().min(1), protocolVersion: z.number() }).parse(
      JSON.parse(readFileSync(join(directory, "connection.json"), "utf8"))
    );
  } catch { throw new EnsoCliError("runner_unavailable", "No runner connection found; start `enso runner serve --provider fake`"); }
  if (connection.protocolVersion !== runnerVersion) throw new EnsoCliError("incompatible_runner_version", "Runner discovery uses an incompatible protocol version");
  // Compare canonical directories so equivalent spellings (symlinks, relative paths) of the store agree.
  let expectedSocket = false;
  try { expectedSocket = basename(connection.socketPath) === "control.sock" && realpathSync(dirname(connection.socketPath)) === realpathSync(directory); }
  catch { /* unresolvable path is unexpected */ }
  if (!expectedSocket) throw new EnsoCliError("invalid_runner_connection", "Discovery names an unexpected socket path");
  if (!path.startsWith("/v1/") || /[\r\n]/.test(path)) throw new EnsoCliError("invalid_input", "Expected a /v1/ runner path");
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath: connection.socketPath, path, method, agent: false, headers: {
      Authorization: `Bearer ${connection.token}`, [runnerVersionHeader]: String(runnerVersion),
      ...(data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) })
    } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", () => reject(new EnsoCliError("runner_unavailable", "Runner response disconnected; inspect the run after reconnecting")));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as EnsoEnvelope); }
        catch { reject(new EnsoCliError("invalid_response", "Runner returned invalid JSON")); }
      });
    });
    req.on("error", () => reject(new EnsoCliError("runner_unavailable", "Runner disconnected; reconnect and inspect state before retrying with the same requestID")));
    req.end(data);
  });
}
