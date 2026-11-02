import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../../src/client.js";
import { writeConfig } from "../../src/config.js";
import { run as executeCli } from "../../src/index.js";
import { withRequestContext, type CanvasTarget } from "../../src/targeting.js";

const A = { vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222" };
const B = { ...A, canvasID: "33333333-3333-4333-8333-333333333333" };
const noteID = "44444444-4444-4444-8444-444444444444";
const elementID = "55555555-5555-4555-8555-555555555555";
type Call = { url: URL; method: string; headers: Record<string, unknown>; body: Record<string, any> };
let server: Server;
let directory: string;
let bridgeUrl: string;
let active: CanvasTarget;
let version: number;
let records: Call[];
let afterRequest: ((call: Call) => void) | undefined;
let failure: string | undefined;
let lostResponse: boolean;
let omitIdentity: boolean;
let failAfterCommit: boolean;
let nodes: Record<string, unknown>[];
let marks: Record<string, unknown>[];
const savedEnv = { vault: process.env.ENSO_VAULT_ID, canvas: process.env.ENSO_CANVAS_ID, config: process.env.ENSO_CLI_CONFIG_DIR };
const canvas = (target: CanvasTarget, name: string) => ({ id: name, name, ref: `Canvases/${name}.json`, ...target, canvasTarget: target });
const error = (code: string) => ({ ok: false, error: { code, message: `Bridge: ${code}`, details: { target: A, activeVaultID: active.vaultID } } });

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "enso-targeting-"));
  process.env.ENSO_CLI_CONFIG_DIR = directory;
  delete process.env.ENSO_VAULT_ID;
  delete process.env.ENSO_CANVAS_ID;
  active = A; version = 3; records = []; afterRequest = undefined; failure = undefined; lostResponse = false; omitIdentity = false;
  failAfterCommit = false;
  marks = [];
  nodes = [{ id: elementID, title: "Auth", kind: "note", ref: "Auth.md", noteID, appearance: "card" }];
  writeFileSync(join(directory, "Auth.md"), "Tokens expire.\n");
  mkdirSync(join(directory, "Canvases"));
  writeFileSync(join(directory, "Canvases/A.md"), "# A\n");
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, bridgeUrl);
    const call: Call = { url, method: req.method!, headers: req.headers, body };
    records.push(call);
    const path = url.pathname;
    let result: unknown;
    if (path === "/v1/health") result = { ok: true, data: { contractVersion: version } };
    else if (path === "/v1/status") result = { ok: true, data: { currentCanvas: canvas(active, active === A ? "A" : "B") } };
    else if (path === "/v1/canvases/current") result = { ok: true, data: omitIdentity ? { name: "A", canvasID: null } : canvas(active, active === A ? "A" : "B") };
    else if (path === "/v1/canvases" && req.method === "GET") result = { ok: true, data: { canvases: [canvas(A, "A"), canvas(B, "B")] } };
    else if (path === "/v1/vault/current") result = { ok: true, data: { path: directory, vaultID: active.vaultID } };
    else {
      const target = body.canvasTarget ?? JSON.parse(url.searchParams.get("canvasTarget") ?? "null");
      const code = failure ?? (path.endsWith("/subcanvas/open") ? "explicit_navigation_required" : undefined) ?? (target && target.vaultID !== active.vaultID ? "wrong_vault" : target && target.canvasID !== active.canvasID ? "target_not_active" : undefined);
      if (code) result = error(code);
      else if (path === "/v1/excerpts" && req.method === "POST") result = { ok: true, data: { excerpt: { id: elementID } } };
      else if (path === "/v1/apply") {
        if (!body.dryRun) for (const op of body.operations) {
          if (op.type === "mark.create") marks.push({ id: elementID, text: op.text, position: { x: op.x, y: op.y }, width: op.width });
          if (op.type === "node.create") nodes.push({ id: noteID, kind: "note", title: op.title.replace(/\.md$/, ""), appearance: "card", position: { x: op.x, y: op.y } });
        }
        result = { ok: true, data: { results: body.operations.map((op: any) => ({ type: op.type, id: elementID })) } };
        if (failAfterCommit && !body.dryRun) {
          active = B;
          result = error("target_changed");
        }
      } else result = { ok: true, data: { nodes, links: [], marks, excerpts: [], diagramPrimitives: [], vision: { diagnostics: { ok: true } } } };
      if (lostResponse) { req.socket.destroy(); return; }
    }
    afterRequest?.(call);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  bridgeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeConfig({ bridgeUrl, token: "target-test" });
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries({ ENSO_VAULT_ID: savedEnv.vault, ENSO_CANVAS_ID: savedEnv.canvas, ENSO_CLI_CONFIG_DIR: savedEnv.config })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function cli(args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const originalOut = process.stdout.write, originalErr = process.stderr.write, originalCode = process.exitCode;
  process.stdout.write = ((text: unknown) => { stdout.push(String(text)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((text: unknown) => { stderr.push(String(text)); return true; }) as typeof process.stderr.write;
  try {
    await executeCli(["node", "enso", ...args]);
    return { stdout: stdout.join(""), stderr: stderr.join(""), code: process.exitCode };
  } finally {
    process.stdout.write = originalOut; process.stderr.write = originalErr; process.exitCode = originalCode;
  }
}
function targetOf(call: Call) { return call.body.canvasTarget ?? JSON.parse(call.url.searchParams.get("canvasTarget") ?? "null"); }
function targeted() { return records.filter(call => targetOf(call)); }
const bound = ["--vault-id", A.vaultID, "--canvas-id", A.canvasID];

const commands = [
  ["node", "list"], ["node", "place", "Auth"], ["node", "update", "Auth", "--appearance", "card"],
  ["node", "move", "Auth", "--x", "1", "--y", "2"], ["node", "remove", "Auth"], ["node", "rename", "Auth", "Identity"], ["node", "neighbors", "Auth"],
  ["portal", "create", "--title", "Portal", "--subcanvas-ref", "B.json"], ["portal", "change-subcanvas", "Portal", "B.json"], ["portal", "remove", "Portal"],
  ["link", "list"], ["link", "create", "Auth", "Other"], ["link", "update", elementID, "--label", "uses"], ["link", "remove", elementID], ["link", "delete", elementID],
  ["mark", "list"], ["mark", "get", elementID], ["mark", "create", "Question", "--at", "1,2"], ["mark", "update", elementID, "--text", "Answer"], ["mark", "delete", elementID],
  ["mark", "connect", elementID, "Auth"], ["mark", "add-to-note", elementID, "Auth"], ["mark", "drop-to-note", elementID, "Auth"],
  ["excerpt", "list"], ["excerpt", "get", elementID], ["excerpt", "create", "--link", elementID, "--text", "New passage"],
  ["excerpt", "move", elementID, "--x", "1", "--y", "2"], ["excerpt", "update", elementID, "--width", "200"], ["excerpt", "connect", elementID, "Auth"],
  ["excerpt", "source", elementID], ["excerpt", "source", elementID, "--text", "Edited"], ["excerpt", "remove-from-note", elementID], ["excerpt", "delete", elementID],
  ["primitive", "list"], ["primitive", "line", "--x1", "0", "--y1", "0", "--x2", "10", "--y2", "10"],
  ["primitive", "region", "--x", "0", "--y", "0", "--width", "200", "--height", "100"], ["primitive", "update", elementID, "--title", "Region"], ["primitive", "delete", elementID],
  ["context"], ["context", "--spec"], ["context", "--full"], ["context", "--node", "Auth"], ["context", "--query", "Auth"], ["context", "--vision"], ["context", "--diagnostics"],
  ["search", "Auth"], ["canvas", "fit"], ["context", "--canvas", "A"], ["canvas", "fit", "A"], ["node", "list", "--canvas", "A"], ["link", "list", "--canvas", "A"]
];

describe("contract 3 outgoing HTTP requests", () => {
  it.each(commands)("targets %j", async (...args) => {
    const result = await cli(args);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(targeted()).toHaveLength(1);
    const call = targeted()[0];
    expect(targetOf(call)).toEqual(A);
    expect(call.headers["enso-contract-version"]).toBe("3");
    expect(call.headers.authorization).toBe("Bearer target-test");
    if (call.method === "GET") expect(call.body).toEqual({});
    else expect(call.url.searchParams.has("canvasTarget")).toBe(false);
    expect(records.filter(call => ["/v1/canvases/current", "/v1/canvases"].includes(call.url.pathname))).toHaveLength(1);
  });

  it.each([
    ["node", "place", "Auth"], ["mark", "create", "Q", "--at", "0,0"], ["link", "create", "Auth", "Other"],
    ["primitive", "line", "--x1", "0", "--y1", "0", "--x2", "10", "--y2", "10"],
    ["excerpt", "create", "--link", elementID, "--text", "Q"], ["canvas", "fit"]
  ])("uses the bound target for dry-run %j", async (...args) => {
    expect((await cli([...bound, ...args, "--dry-run"])).code).toBe(0);
    expect(targetOf(targeted()[0])).toEqual(A);
    expect(targeted()[0].body.dryRun).toBe(true);
    expect(records.filter(call => call.url.pathname === "/v1/canvases/current")).toHaveLength(0);
  });

  it("refuses a canvas whose indexed identity is unavailable", async () => {
    omitIdentity = true;
    const result = await cli(["node", "list"]);
    expect(JSON.parse(result.stderr).error.code).toBe("target_not_found");
    expect(targeted()).toHaveLength(0);
  });

  it("does not hide a target failure during post-apply verification", async () => {
    afterRequest = call => { if (call.url.pathname === "/v1/apply") active = B; };
    const result = await cli(["canvas", "apply", "--json", JSON.stringify({ canvas: "current", nodes: [{ kind: "note", mode: "update", selector: "Auth", appearance: "card" }] })]);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "target_not_active", details: { appliedBatches: [{ name: "nodePortalWrites", count: 1 }] } });
    expect(records.filter(call => call.url.pathname === "/v1/apply")).toHaveLength(1);
  });

  it("resolves an explicit current selector before comparing another selector", async () => {
    active = B;
    const result = await cli(["--canvas", "current", "canvas", "fit", "A"]);
    expect(JSON.parse(result.stderr).error.code).toBe("target_conflict");
    expect(targeted()).toHaveLength(0);
    expect(records.filter(call => call.url.pathname === "/v1/canvases/current")).toHaveLength(1);
  });

  it("supports the stable canvasID selector and a filename selector", async () => {
    for (const selector of [A.canvasID, "A.json", "Canvases/A.json"]) {
      expect((await cli(["--canvas", selector, "mark", "list"])).code).toBe(0);
      expect(targetOf(targeted().at(-1)!)).toEqual(A);
    }
  });

  it("reports an inactive selected canvas without opening it", async () => {
    const result = await cli(["--canvas", "B", "node", "list"]);
    expect(JSON.parse(result.stderr).error.code).toBe("target_not_active");
    expect(targetOf(targeted()[0])).toEqual(B);
    expect(records.some(call => call.url.pathname.endsWith("/open"))).toBe(false);
  });

  it("rejects repeated conflicting binding flags before transport", async () => {
    const result = await cli([...bound, "--canvas-id", B.canvasID, "node", "list"]);
    expect(JSON.parse(result.stderr).error.code).toBe("target_conflict");
    expect(records).toHaveLength(0);
  });

  it("preserves human auth status and structured pretty output", async () => {
    const human = await cli(["auth", "status"]);
    expect(human.stdout).toContain("Enso CLI is linked to the Enso app.");
    const machine = await cli(["--pretty", "auth", "status"]);
    expect(JSON.parse(machine.stdout)).toMatchObject({ ok: true, data: { status: "linked", linked: true, bridgeUrl } });
  });

  it("targets portal opening's source and preserves the separate-navigation error", async () => {
    const result = await cli(["portal", "open", "Portal", "--dry-run"]);
    expect(JSON.parse(result.stderr).error.code).toBe("explicit_navigation_required");
    expect(targetOf(targeted()[0])).toEqual(A);
    expect(records.some(call => call.url.pathname.startsWith("/v1/canvases/") && call.url.pathname.endsWith("/open"))).toBe(false);
  });

  it("reuses one target across excerpt lookup, note access, creation and formatting", async () => {
    const result = await cli(["excerpt", "create", "--note", "Auth", "--text", "Tokens expire.", "--x", "0", "--y", "0", "--width", "200"]);
    expect(result.code).toBe(0);
    expect(targeted().map(call => [call.method, call.url.pathname])).toEqual([["GET", "/v1/nodes"], ["POST", "/v1/excerpts"], ["PUT", `/v1/excerpts/${elementID}`]]);
    expect(targeted().every(call => JSON.stringify(targetOf(call)) === JSON.stringify(A))).toBe(true);
    expect(records.filter(call => call.url.pathname === "/v1/canvases/current")).toHaveLength(1);
  });

  it("keeps A after a switch to B and preserves the inactive error without another mutation", async () => {
    afterRequest = call => { if (call.url.pathname === "/v1/excerpts" && call.method === "POST") active = B; };
    const result = await cli(["excerpt", "create", "--note", "Auth", "--text", "Tokens expire.", "--x", "0", "--y", "0", "--width", "200"]);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "target_not_active", details: { target: A, excerptId: elementID } } });
    expect(targeted()).toHaveLength(3);
    expect(targeted().every(call => targetOf(call).canvasID === A.canvasID)).toBe(true);
    expect(records.filter(call => call.url.pathname === "/v1/canvases/current")).toHaveLength(1);
    expect(records.some(call => call.url.pathname.endsWith("/open"))).toBe(false);
  });

  it.each([false, true])("uses one target for multiple apply phases, dry run=%s", async dryRun => {
    const intent = { canvas: "A", nodes: [{ kind: "note", mode: "update", selector: "Auth", appearance: "card" }], marks: [{ mode: "create", text: "Question", x: 0, y: 0 }] };
    const result = await cli(["canvas", "apply", "--json", JSON.stringify(intent), ...(dryRun ? ["--dry-run"] : [])]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const applies = records.filter(call => call.url.pathname === "/v1/apply");
    expect(applies).toHaveLength(dryRun ? 1 : 2);
    expect(applies.every(call => targetOf(call).canvasID === A.canvasID && call.body.dryRun === dryRun)).toBe(true);
    expect(records.filter(call => call.url.pathname === "/v1/canvases")).toHaveLength(1);
    expect(records.some(call => call.url.pathname.endsWith("/open"))).toBe(false);
  });

  it("stops an apply at the failing batch when the person switches canvases", async () => {
    afterRequest = call => { if (call.url.pathname === "/v1/apply") active = B; };
    const result = await cli(["canvas", "apply", "--json", JSON.stringify({ canvas: "current", nodes: [{ kind: "note", mode: "update", selector: "Auth", appearance: "card" }], marks: [{ mode: "create", text: "Question", x: 0, y: 0 }] })]);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "target_not_active", details: { appliedBatches: [{ name: "nodePortalWrites", count: 1 }], failedBatch: "marks" } });
    expect(records.filter(call => call.url.pathname === "/v1/apply")).toHaveLength(2);
    expect(targeted().every(call => targetOf(call).canvasID === A.canvasID)).toBe(true);
  });

  it.each([false, true])("does not replay a committed batch reported as target_changed, bound=%s", async isBound => {
    failAfterCommit = true;
    const result = await cli([
      ...(isBound ? bound : []),
      "canvas", "apply", "--json", JSON.stringify({
        canvas: "current", marks: [{ mode: "create", text: "Committed before navigation", x: 0, y: 0 }]
      })
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "target_changed",
      details: { target: A, appliedBatches: [], failedBatch: "marks", hint: expect.stringContaining("partial effects") }
    });
    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe("Committed before navigation");
    expect(active).toEqual(B);
    expect(records.filter(call => call.url.pathname === "/v1/apply")).toHaveLength(1);
    expect(targeted().every(call => targetOf(call).canvasID === A.canvasID)).toBe(true);
    expect(records.filter(call => call.url.pathname === "/v1/canvases/current")).toHaveLength(isBound ? 0 : 1);
    expect(records.some(call => call.url.pathname.endsWith("/open"))).toBe(false);
  });

  it.each([false, true])("targets layout including preflight and batches, dry run=%s", async dryRun => {
    const file = join(directory, "layout.json");
    writeFileSync(file, JSON.stringify({ canvas: "A", members: ["New"] }));
    const result = await cli(["layout", file, "--apply", ...(dryRun ? ["--dry-run"] : [])]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(targeted().every(call => targetOf(call).canvasID === A.canvasID)).toBe(true);
    expect(records.some(call => call.url.pathname === "/v1/apply")).toBe(true);
    expect(records.filter(call => call.url.pathname === "/v1/canvases")).toHaveLength(1);
    expect(records.some(call => call.url.pathname.endsWith("/open"))).toBe(false);
  });

  it("checks the named target before reading its outline", async () => {
    const result = await cli(["canvas", "outline", "A"]);
    expect(JSON.parse(result.stdout).data.markdown).toBe("# A\n");
    expect(targeted().map(call => call.url.pathname)).toEqual([`/v1/canvases/${A.canvasID}/inspect`]);
  });

  it.each(["wrong_vault", "target_not_active", "target_not_found", "target_changed", "vault_changed", "app_outdated", "cli_outdated"])("preserves structured %s errors", async code => {
    failure = code;
    const result = await cli(["--pretty", ...bound, "node", "list"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject(error(code));
    expect(targeted()).toHaveLength(1);
  });

  it.each([1, 2, 4])("refuses targeting on contract %s without sending a canvas request", async appVersion => {
    version = appVersion;
    const result = await cli(["node", "list"]);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: appVersion > 3 ? "cli_outdated" : "app_outdated", details: { hint: expect.stringMatching(/Update/) } });
    expect(targeted()).toHaveLength(0);
    expect(records.map(call => call.url.pathname)).toEqual(["/v1/health"]);
    expect((await cli(["canvas", "list"])).code).toBe(0);
  });

  it("accepts immutable flags without discovering an active canvas", async () => {
    expect((await cli([...bound, "node", "list"])).code).toBe(0);
    expect(targetOf(targeted()[0])).toEqual(A);
    expect(records.map(call => call.url.pathname)).toEqual(["/v1/health", "/v1/nodes"]);
  });

  it("accepts immutable environment bindings and rejects flag overrides", async () => {
    process.env.ENSO_VAULT_ID = A.vaultID; process.env.ENSO_CANVAS_ID = A.canvasID;
    expect((await cli(["mark", "list"])).code).toBe(0);
    records.length = 0;
    const result = await cli(["--vault-id", B.vaultID, "--canvas-id", B.canvasID, "node", "list"]);
    expect(JSON.parse(result.stderr).error.code).toBe("target_conflict");
    expect(records).toHaveLength(0);
  });

  it.each([["--vault-id", A.vaultID], ["--canvas-id", A.canvasID], ["--vault-id", "bad", "--canvas-id", A.canvasID]])("rejects partial or invalid flags %j", async (...flags) => {
    const result = await cli([...flags, "node", "list"]);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_target");
    expect(records).toHaveLength(0);
  });

  it.each(["ENSO_VAULT_ID", "ENSO_CANVAS_ID"])("rejects partial environment binding %s", async key => {
    process.env[key] = A.vaultID;
    const result = await cli(["node", "list"]);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_target");
    expect(records).toHaveLength(0);
  });

  it.each([["node", "list", "--canvas", "B"], ["context", "--canvas", "current"]])("rejects bound selector overrides %j", async (...args) => {
    const result = await cli([...bound, ...args]);
    expect(JSON.parse(result.stderr).error.code).toBe("target_conflict");
    expect(records).toHaveLength(0);
  });

  it.each([["canvas", "open", "B"], ["canvas", "create", "B"], ["canvas", "delete", "B"], ["portal", "open", "Portal"], ["vault", "open", "."], ["vault", "create", "folder"], ["auth", "link"]])("rejects bound navigation %j before effects", async (...args) => {
    const result = await cli([...bound, ...args, ...(args[0] === "auth" ? [] : ["--dry-run"])]);
    expect(JSON.parse(result.stderr).error.code).toBe("explicit_navigation_required");
    expect(records).toHaveLength(0);
    expect(existsSync(join(directory, "folder"))).toBe(false);
  });

  it("rejects an apply selector conflicting with a binding before any batch", async () => {
    const result = await cli([...bound, "canvas", "apply", "--json", JSON.stringify({ canvas: "B", marks: [{ mode: "create", text: "Q", x: 0, y: 0 }] }), "--dry-run"]);
    expect(JSON.parse(result.stderr).error.code).toBe("target_conflict");
    expect(targeted()).toHaveLength(0);
  });

  it("pins the app bridge and token even if config changes between requests", async () => {
    afterRequest = call => { if (call.url.pathname === "/v1/nodes") writeConfig({ bridgeUrl: "http://127.0.0.1:1", token: "other" }); };
    const result = await cli(["excerpt", "create", "--note", "Auth", "--text", "Tokens expire.", "--x", "0", "--y", "0", "--width", "200"]);
    expect(result.code).toBe(0);
    expect(records.every(call => call.headers.authorization === "Bearer target-test" || call.url.pathname === "/v1/health")).toBe(true);
  });

  it("does not replay a mutation after an uncertain response", async () => {
    lostResponse = true;
    const result = await cli([...bound, "mark", "create", "Q", "--at", "0,0"]);
    expect(JSON.parse(result.stderr).error.code).toBe("app_unavailable");
    expect(targeted()).toHaveLength(1);
  });

  it("does not relink or replay a bound rejected token", async () => {
    failure = "invalid_token";
    const result = await cli([...bound, "node", "list"]);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_token");
    expect(records.map(call => call.url.pathname)).toEqual(["/v1/health", "/v1/nodes"]);
  });

  it("checks bound vault reads without attaching a forbidden canvas target", async () => {
    active = { ...A, vaultID: noteID };
    const result = await cli([...bound, "vault", "tree"]);
    expect(JSON.parse(result.stderr).error.code).toBe("wrong_vault");
    expect(records.map(call => call.url.pathname)).toEqual(["/v1/vault/current"]);
    expect(records.every(call => !targetOf(call))).toBe(true);
  });
});

describe("generic client targeting boundary", () => {
  it("keeps health unauthenticated even without pairing", async () => {
    rmSync(join(directory, "config.json"));
    const result = await new BridgeClient(bridgeUrl).request("/v1/health");
    expect(result.ok).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].headers.authorization).toBeUndefined();
  });

  it("never probes another bridge for an unpaired bound caller", async () => {
    rmSync(join(directory, "config.json"));
    await withRequestContext({ vaultId: A.vaultID, canvasId: A.canvasID }, async () => {
      await expect(new BridgeClient(bridgeUrl).request("/v1/nodes")).rejects.toMatchObject({ body: { code: "auth_required" } });
    });
    expect(records.map(call => call.url.pathname)).toEqual(["/v1/health", "/v1/health"]);
    expect(records.every(call => call.url.origin === bridgeUrl)).toBe(true);
  });

  it.each(["/v1/nodes", "/v1/smoke/state", "/v1/unknown"])("targets raw path %s", async path => {
    await new BridgeClient().request(path);
    expect(targetOf(targeted()[0])).toEqual(A);
  });

  it.each([false, true])("validates raw batch targets before submission, dry run=%s", async dryRun => {
    await withRequestContext({ vaultId: A.vaultID, canvasId: A.canvasID }, async () => {
      await expect(new BridgeClient().request("/v1/apply", { method: "POST", body: { operations: [{ type: "mark.create", canvasTarget: B }], dryRun } })).rejects.toMatchObject({ body: { code: "target_conflict" } });
      expect(targeted()).toHaveLength(0);
      await new BridgeClient().request("/v1/apply", { method: "POST", body: { operations: [{ type: "mark.create", canvasTarget: A }], dryRun } });
      expect(targetOf(targeted()[0])).toEqual(A);
      expect(targeted()[0].body.operations[0].canvasTarget).toEqual(A);
    });
  });

  it.each(["canvas.open", "canvas.create", "portal.open"])("rejects raw navigation in batch %s", async type => {
    await expect(new BridgeClient().request("/v1/apply", { method: "POST", body: { operations: [{ type }], dryRun: true } })).rejects.toMatchObject({ body: { code: "explicit_navigation_required" } });
    expect(targeted()).toHaveLength(0);
  });

  it("rejects conflicting query/body targets and malformed raw targets", async () => {
    const client = new BridgeClient();
    await expect(client.request(`/v1/nodes?canvasTarget=${encodeURIComponent(JSON.stringify(A))}`, { method: "POST", body: { canvasTarget: B } })).rejects.toMatchObject({ body: { code: "target_conflict" } });
    await expect(client.request("/v1/nodes", { query: { canvasTarget: "oops" } })).rejects.toMatchObject({ body: { code: "invalid_target" } });
    await expect(client.request("/v1/nodes", { body: { canvasTarget: { ...A, extra: true } } })).rejects.toMatchObject({ body: { code: "invalid_target" } });
    expect(records).toHaveLength(0);
  });

  it("cannot retarget a generic client or override its origin", async () => {
    const client = new BridgeClient();
    await client.request("/v1/nodes");
    await expect(client.request("/v1/nodes", { query: { canvasTarget: JSON.stringify(B) } })).rejects.toMatchObject({ body: { code: "target_conflict" } });
    await expect(client.request("http://localhost:1/v1/nodes")).rejects.toMatchObject({ body: { code: "target_conflict" } });
    expect(targeted()).toHaveLength(1);
  });

  it("rejects a second client that attempts to change a bound invocation's bridge", async () => {
    await withRequestContext({ vaultId: A.vaultID, canvasId: A.canvasID }, async () => {
      await new BridgeClient().request("/v1/nodes");
      await expect(new BridgeClient("http://127.0.0.1:1").request("/v1/nodes")).rejects.toMatchObject({ body: { code: "target_conflict" } });
    });
    expect(targeted()).toHaveLength(1);
  });

  it("normalizes a raw GET body target to the supported query transport", async () => {
    await new BridgeClient().request("/v1/nodes", { body: { canvasTarget: A } });
    expect(targetOf(targeted()[0])).toEqual(A);
    expect(targeted()[0].body).toEqual({});
  });

  it("rejects targets on discovery and navigation", async () => {
    await expect(new BridgeClient().request("/v1/canvases", { query: { canvasTarget: JSON.stringify(A) } })).rejects.toMatchObject({ body: { code: "target_not_allowed" } });
    await expect(new BridgeClient().request("/v1/canvases/B/open", { method: "POST", body: { canvasTarget: A } })).rejects.toMatchObject({ body: { code: "target_not_allowed" } });
    expect(records).toHaveLength(0);
  });

  it("rejects bound navigation even through the generic request path", async () => {
    await withRequestContext({ vaultId: A.vaultID, canvasId: A.canvasID }, async () => {
      await expect(new BridgeClient().request("/v1/canvases/B/open", { method: "POST" })).rejects.toMatchObject({ body: { code: "explicit_navigation_required" } });
      await expect(new BridgeClient().request("/v1/pair/request", { method: "POST" })).rejects.toMatchObject({ body: { code: "explicit_navigation_required" } });
    });
    expect(records).toHaveLength(0);
  });
});
