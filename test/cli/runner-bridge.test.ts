// The `enso` CLI as a runner session's agent runs it: with the environment the Claude provider builds for a session
// (bridgeEnvironment), against a stand-in bridge. No Enso app takes part, so this proves the CLI's side of the binding,
// not compatibility with a live app.
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configPath, writeConfig } from "../../src/config.js";
import { run as executeCli } from "../../src/index.js";
import { bridgeEnvironment, cliDirectory } from "../../src/runner/bridge.js";
import type { Binding } from "../../src/runner/protocol.js";

const A = { vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222" };
const B = { ...A, canvasID: "33333333-3333-4333-8333-333333333333" };
const token = "session-pairing-token";
type Call = { path: string; method: string; headers: Record<string, string | string[] | undefined>; body: Record<string, any>; target: unknown };
let server: Server;
let directory: string;
let bridgeUrl: string;
let calls: Call[];
let fetches: string[];
/** What the bridge's health route advertises, and the instance the app enforces on other requests (the header check). */
let advertised: string | undefined;
let serving: string;
let active: typeof A;
let saved: NodeJS.ProcessEnv;

beforeEach(async () => {
  saved = { ...process.env };
  directory = mkdtempSync(join(tmpdir(), "enso-runner-bridge-"));
  process.env.ENSO_CLI_CONFIG_DIR = directory;
  calls = []; fetches = []; advertised = serving = "instance-1"; active = A;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = new URL(req.url!, "http://bridge");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const target = body.canvasTarget ?? JSON.parse(url.searchParams.get("canvasTarget") ?? "null");
    calls.push({ path: url.pathname, method: req.method!, headers: req.headers, body, target });
    const fail = (code: string, message: string, details = {}) => ({ ok: false, error: { code, message, details } });
    const canvas = (t: typeof A, name: string) => ({ id: name, name, canvasID: t.canvasID, canvasTarget: t });
    let result: unknown;
    if (url.pathname === "/v1/health") result = { ok: true, data: { contractVersion: 3, ...(advertised ? { bridgeInstanceID: advertised } : {}) } };
    else if (req.headers.authorization !== `Bearer ${token}`) result = fail("invalid_token", "Bridge: invalid token");
    else if (req.headers["enso-bridge-instance"] !== undefined && req.headers["enso-bridge-instance"] !== serving) {
      result = fail("bridge_instance_mismatch", "Bridge: another instance", { instanceID: serving });
    }
    else if (url.pathname === "/v1/canvases" && req.method === "GET") result = { ok: true, data: { canvases: [canvas(A, "A"), canvas(B, "B")] } };
    else if (url.pathname === "/v1/vault/current") result = { ok: true, data: { vaultID: active.vaultID } };
    else if (url.pathname === "/v1/status") result = { ok: true, data: { currentCanvas: canvas(active, "A") } };
    else if (target && (target as typeof A).canvasID !== active.canvasID) {
      result = fail("target_not_active", "Open the target canvas explicitly, then retry; targeted requests never navigate", { target });
    }
    else if (url.pathname === "/v1/apply") result = { ok: true, data: { results: body.operations.map((op: { type: string }) => ({ type: op.type, id: "mark-1" })) } };
    else result = { ok: true, data: { nodes: [{ id: "node-a", title: "Auth", kind: "note" }], links: [], marks: [], excerpts: [], diagramPrimitives: [] } };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  bridgeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The user's own pairing, for another bridge: a runner session never falls back to it, and never changes it.
  writeConfig({ bridgeUrl: "http://127.0.0.1:17651", token: "the-users-own-token" });
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => { fetches.push(new URL(String(input)).origin); return fetch(input, init); });
  bind();
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
  process.env = saved;
});

/** The environment the provider gives a session's agent. */
function bind(binding: Partial<Binding> = {}, pairing: string | null = token): void {
  const env = bridgeEnvironment({ bridgeUrl, canvasTarget: A, workingDirectory: directory, bridgeInstanceID: "instance-1", ...binding }, pairing ?? undefined);
  for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);
}

async function cli(...args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const out = process.stdout.write, err = process.stderr.write, code = process.exitCode;
  process.stdout.write = ((text: unknown) => { stdout.push(String(text)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((text: unknown) => { stderr.push(String(text)); return true; }) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    await executeCli(["node", "enso", ...args]);
    return { code: process.exitCode, data: stdout.length ? JSON.parse(stdout.join("")) : undefined, error: stderr.length ? JSON.parse(stderr.join("")).error : undefined };
  } finally { process.stdout.write = out; process.stderr.write = err; process.exitCode = code; }
}
const routes = () => calls.filter(call => call.path !== "/v1/health").map(call => `${call.method} ${call.path}`);

it("puts the runner's own CLI first on the agent's PATH, ahead of any other installed enso", () => {
  const decoy = mkdtempSync(join(tmpdir(), "enso-decoy-"));
  writeFileSync(join(decoy, "enso"), "#!/bin/sh\necho decoy\n", { mode: 0o700 });
  process.env.PATH = `${decoy}:${process.env.PATH}`;
  const runner = { node: "/bin/echo", args: ["runner cli's", "entry"] };
  for (const binding of [{}, { bridgeInstanceID: undefined }]) {
    const env = bridgeEnvironment({ bridgeUrl, canvasTarget: A, workingDirectory: directory, bridgeInstanceID: "instance-1", ...binding }, token, runner);
    expect(env.PATH!.split(":")[0]).toBe(cliDirectory(runner));
    expect(execFileSync("/bin/sh", ["-c", "enso node list"], { env, encoding: "utf8" })).toBe("runner cli's entry node list\n");
  }
  rmSync(decoy, { recursive: true, force: true });
});

it("reads and writes the session's canvas with its pairing, its instance on every request, and its target", async () => {
  const read = await cli("node", "list");
  expect(read.code).toBe(0);
  expect(read.data.data.nodes).toEqual([{ id: "node-a", title: "Auth", kind: "note" }]);
  const write = await cli("mark", "create", "Reviewed", "--at", "40,40");
  expect(write.code).toBe(0);
  expect(calls.some(call => call.method === "POST" && call.target)).toBe(true);
  for (const call of calls) {
    expect(call.headers["enso-bridge-instance"]).toBe("instance-1");
    if (call.path !== "/v1/health") expect(call.headers.authorization).toBe(`Bearer ${token}`);
    if (call.target) expect(call.target).toEqual(A);
  }
  expect(calls.filter(call => call.target).length).toBeGreaterThanOrEqual(2);
  // Discovery reads stay available: they cannot retarget a bound invocation.
  expect((await cli("canvas", "list")).code).toBe(0);
  expect(new Set(fetches)).toEqual(new Set([bridgeUrl]));
  expect(JSON.parse(readFileSync(configPath(), "utf8"))).toMatchObject({ token: "the-users-own-token" });
});

it("refuses a read and a write after the user switches canvases, without navigating, retargeting or retrying", async () => {
  active = B;
  for (const args of [["node", "list"], ["mark", "create", "Reviewed", "--at", "40,40"]]) {
    calls = [];
    const result = await cli(...args);
    expect(result.code).toBe(1);
    expect(result.error).toMatchObject({
      code: "target_not_active", message: "Open the target canvas explicitly, then retry; targeted requests never navigate",
      details: { target: A, hint: expect.stringContaining("Stop and tell the user") }
    });
    const targeted = calls.filter(call => call.target);
    expect(targeted).toHaveLength(1);
    expect(targeted[0].target).toEqual(A);
    expect(routes().some(route => /open|canvases\/current/.test(route))).toBe(false);
  }
});

it("refuses every request once another app instance answers at the session's bridge address", async () => {
  // The app restarted: health advertises its new instance, and nothing past health is sent.
  advertised = serving = "instance-2";
  const restarted = await cli("node", "list");
  expect(restarted.error).toMatchObject({
    code: "bridge_instance_mismatch", details: { bridgeUrl, expectedInstanceID: "instance-1", instanceID: "instance-2", hint: expect.stringContaining("Stop and tell the user") }
  });
  expect(routes()).toEqual([]);
  // Another process took over between the health check and the request: the app's refusal is surfaced unchanged, once.
  advertised = "instance-1"; calls = [];
  const takenOver = await cli("mark", "create", "Reviewed", "--at", "40,40");
  expect(takenOver.error).toMatchObject({ code: "bridge_instance_mismatch", message: "Bridge: another instance", details: { instanceID: "instance-2" } });
  expect(routes()).toHaveLength(1);
  // An app that advertises no instance would not enforce the header either.
  advertised = undefined; calls = [];
  expect((await cli("node", "list")).error).toMatchObject({ code: "bridge_instance_unavailable" });
  expect(routes()).toEqual([]);
});

it("refuses navigation, vault changes, linking, other canvases and unbound requests before contacting the bridge", async () => {
  const refused = [
    [["canvas", "open", "B"], "explicit_navigation_required"], [["canvas", "create", "New"], "explicit_navigation_required"],
    [["canvas", "delete", "A"], "explicit_navigation_required"], [["vault", "open", directory], "explicit_navigation_required"],
    [["vault", "create", "Another"], "explicit_navigation_required"], [["portal", "open", "Auth"], "explicit_navigation_required"],
    [["auth", "link"], "explicit_navigation_required"], [["auth", "unlink"], "explicit_navigation_required"],
    [["--canvas", "B", "node", "list"], "target_conflict"], [["--vault-id", B.vaultID, "--canvas-id", B.canvasID, "node", "list"], "target_conflict"]
  ] as const;
  for (const [args, code] of refused) expect((await cli(...args)).error, args.join(" ")).toMatchObject({ code });
  // Half a binding is no binding (PR 2's rule); none at all is an unbound request, which a runner session refuses.
  delete process.env.ENSO_CANVAS_ID;
  expect((await cli("node", "list")).error).toMatchObject({ code: "invalid_target" });
  delete process.env.ENSO_VAULT_ID;
  for (const args of [["node", "list"], ["canvas", "list"], ["status"]]) expect((await cli(...args)).error, args.join(" ")).toMatchObject({ code: "runner_binding_required" });
  expect(fetches).toEqual([]);
  expect(JSON.parse(readFileSync(configPath(), "utf8"))).toMatchObject({ token: "the-users-own-token" });
});

it("reports a missing pairing without discovering or linking another bridge", async () => {
  bind({}, null);
  const result = await cli("node", "list");
  expect(result.error).toMatchObject({ code: "auth_required", message: "The runner found no Enso pairing for this session's bridge" });
  expect(new Set(fetches)).toEqual(new Set([bridgeUrl]));
  expect(routes()).toEqual([]);
});

it("refuses every bridge request, linking included, for a session that pinned no instance", async () => {
  bind({ bridgeInstanceID: undefined });
  expect(process.env.ENSO_RUNNER_BRIDGE).toBe("disabled");
  for (const args of [["node", "list"], ["status"], ["canvas", "list"], ["auth", "link"]]) {
    expect((await cli(...args)).error, args.join(" ")).toMatchObject({ code: "bridge_unavailable" });
  }
  expect(fetches).toEqual([]);
});

it("checks an expected instance outside the runner too, when ENSO_BRIDGE_INSTANCE_ID is set", async () => {
  for (const name of ["ENSO_RUNNER_BRIDGE", "ENSO_BRIDGE_TOKEN", "ENSO_VAULT_ID", "ENSO_CANVAS_ID"]) delete process.env[name];
  writeConfig({ bridgeUrl, token });
  expect((await cli("status")).code).toBe(0);
  expect(calls.every(call => call.headers["enso-bridge-instance"] === "instance-1")).toBe(true);
  process.env.ENSO_BRIDGE_INSTANCE_ID = "instance-9";
  expect((await cli("status")).error).toMatchObject({ code: "bridge_instance_mismatch", details: { hint: expect.stringContaining("ENSO_BRIDGE_INSTANCE_ID") } });
});

it("checks the expected instance before resolving the active canvas for an unbound invocation", async () => {
  for (const name of ["ENSO_RUNNER_BRIDGE", "ENSO_BRIDGE_TOKEN", "ENSO_VAULT_ID", "ENSO_CANVAS_ID"]) delete process.env[name];
  writeConfig({ bridgeUrl, token });
  advertised = "instance-2";
  expect((await cli("node", "list")).error).toMatchObject({ code: "bridge_instance_mismatch" });
  expect(routes()).toEqual([]);
});
