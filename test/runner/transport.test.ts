import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runnerCall, shutdownRunner } from "../../src/runner/client.js";
import { runnerVersion, runnerVersionHeader } from "../../src/runner/protocol.js";
import { startRunner, type RunnerService } from "../../src/runner/service.js";
import { RunnerStorage } from "../../src/runner/storage.js";

let directory: string;
let service: RunnerService | undefined;
let server: Server | undefined;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "enso-runner-")); });
afterEach(async () => {
  await service?.stop(); service = undefined;
  if (server) await new Promise(resolve => { server!.close(resolve); server!.closeAllConnections(); });
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});
const oversized = { requestID: "big", text: "x".repeat(2 * 1024 * 1024) };

it("rejects oversized bodies with a delivered payload_too_large reply", async () => {
  service = await startRunner({ directory, autoDispatch: false });
  for (let n = 0; n < 5; n++) {
    expect(await runnerCall("POST", "/v1/prompts", oversized, directory)).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
  }
  const { socketPath, token } = JSON.parse(readFileSync(join(directory, "connection.json"), "utf8"));
  // Chunked transfer has no Content-Length, so the limit is detected while draining.
  const chunked = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path: "/v1/prompts", method: "POST", agent: false, headers: {
      Authorization: `Bearer ${token}`, [runnerVersionHeader]: String(runnerVersion), "Content-Type": "application/json"
    } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    req.on("error", reject);
    for (let n = 0; n < 32; n++) req.write("x".repeat(64 * 1024));
    req.end();
  });
  expect(chunked.status).toBe(413);
  expect(JSON.parse(chunked.body)).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
  expect(await runnerCall("GET", "/v1/snapshot", undefined, directory)).toMatchObject({ ok: true });
});

it("times out a stalled runner without reporting a disconnect", async () => {
  const storage = new RunnerStorage(directory);
  storage.acquire();
  const socketPath = join(directory, "control.sock");
  server = createServer(() => { /* never replies */ });
  await new Promise<void>(resolve => server!.listen(socketPath, resolve));
  storage.write("connection.json", { protocolVersion: runnerVersion, socketPath, token: "t", pid: process.pid });
  const started = Date.now();
  const error = await runnerCall("GET", "/v1/snapshot", undefined, directory, { timeoutMs: 100 }).catch(error => error);
  expect(error.body).toMatchObject({ code: "runner_timeout" });
  expect(error.message).toContain("same requestID");
  expect(Date.now() - started).toBeLessThan(2000);
  storage.release();
});

it("waits for an in-process runner to release discovery and ownership on shutdown", async () => {
  service = await startRunner({ directory });
  expect(await shutdownRunner(directory)).toEqual({ ok: true, data: { stopped: true } });
  expect(existsSync(join(directory, "connection.json"))).toBe(false);
  expect(() => lstatSync(join(directory, "owner"))).toThrow();
  await service.closed;
  service = await startRunner({ directory });
});

it("returns from shutdown only after a separate runner process has exited", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "test/runner/crash-child.ts", directory, "none"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("exit", () => reject(new Error("runner exited"))); });
    const exited = once(child, "exit");
    expect(await shutdownRunner(directory)).toEqual({ ok: true, data: { stopped: true } });
    expect(child.exitCode ?? child.signalCode).not.toBeNull();
    expect((await exited)[0]).toBe(0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}, 15_000);
