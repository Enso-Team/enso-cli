import { describe, expect, it, vi } from "vitest";
import { markWorldBox } from "../../src/mark-model.js";
import { bindCreatedMarks, compileCanvasApply, parseCanvasIntent, verifyCanvasIntent } from "../../src/canvas-intent.js";
import { calls, run, setupCliTest } from "../support/cli-harness.js";

setupCliTest();

const MARK = "11111111-1111-4111-8111-111111111111";
const INK = "22222222-2222-4222-8222-222222222222";

function body(index: number): unknown {
  return JSON.parse(String(calls[index].init.body));
}

describe("mark commands", () => {
  it.each([
    [["mark", "list"], "/v1/marks", "GET"],
    [["mark", "get", MARK], `/v1/marks/${MARK}`, "GET"],
    [["mark", "delete", MARK], `/v1/marks/${MARK}?dryRun=false`, "DELETE"],
    [["mark", "connect", MARK, "Auth"], `/v1/marks/${MARK}/connect?dryRun=false`, "POST"],
    [["mark", "add-to-note", MARK, "Auth"], `/v1/marks/${MARK}/add-to-note?dryRun=false`, "POST"],
    [["mark", "drop-to-note", MARK, "Auth", "--dry-run"], `/v1/marks/${MARK}/drop-to-note?dryRun=true`, "POST"]
  ])("routes %j", async (args, path, method) => {
    const result = await run(args);
    expect(result.code).toBe(0);
    expect(calls[0].url).toBe("http://127.0.0.1:17650" + path);
    expect(calls[0].init.method).toBe(method);
  });

  it("creates typed text at a top-left point with width and formatting", async () => {
    const result = await run(["mark", "create", "Open question: retry?", "--at", "120,-40", "--width", "240",
      "--runs", JSON.stringify([{ location: 0, length: 13, styles: ["bold"] }])]);
    expect(result.code).toBe(0);
    expect(calls[0].url).toBe("http://127.0.0.1:17650/v1/marks?dryRun=false");
    expect(body(0)).toEqual({
      text: "Open question: retry?", x: 120, y: -40, width: 240,
      textRuns: [{ location: 0, length: 13, styles: ["bold"] }], dryRun: false
    });
  });

  it("sends only the fields an update names", async () => {
    await run(["mark", "update", MARK, "--at", "0,10"]);
    expect(calls[0].init.method).toBe("PUT");
    expect(body(0)).toEqual({ x: 0, y: 10, dryRun: false });
  });

  it("rejects empty updates, blank text, and out-of-range formatting before contacting the app", async () => {
    for (const args of [
      ["mark", "update", MARK],
      ["mark", "create", "  ", "--at", "0,0"],
      ["mark", "create", "Hi", "--at", "0,0", "--runs", JSON.stringify([{ location: 1, length: 5, styles: ["bold"] }])]
    ]) {
      expect((await run(args)).code).toBe(1);
    }
    await expect(run(["mark", "create", "Hi", "--at", "0,0", "--runs", JSON.stringify([{ location: 0, length: 1, styles: ["underline"] }])]))
      .rejects.toThrow("styles from bold");
    expect(calls).toHaveLength(0);
  });

  it("passes a missing Node through instead of calling the app outdated", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: false, error: { code: "not_found", message: "Node selector did not match any node" } });
    });
    const result = await run(["mark", "connect", MARK, "Missing"]);
    expect(JSON.parse(result.stderr).error.code).toBe("not_found");
  });

  it("names an app that predates Marks as outdated", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: false, error: { code: "not_found", message: "Bridge route not found", details: { path: "/v1/marks" } } });
    });
    const result = await run(["mark", "list"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "app_outdated", details: { hint: "Update the Enso app" } });
  });
});

describe("canvas apply marks", () => {
  const context = {
    nodes: [{ id: "auth", title: "Auth", kind: "note" }],
    marks: [
      { id: MARK, kind: "text", text: "Old", position: { x: 0, y: 0 }, connectedNodeIDs: ["auth"] },
      { id: INK, kind: "strokes", text: "scribble", connectedNodeIDs: [] }
    ]
  };

  it("writes Marks after the Nodes they connect to and connects created Marks by placeholder", () => {
    const intent = parseCanvasIntent({ canvas: "current",
      nodes: [{ kind: "note", mode: "place", note: "Token", x: 0, y: 200 }],
      marks: [
        { mode: "create", text: "Flow", x: -200, y: -100, connect: ["Token"] },
        { mode: "update", id: MARK, connect: ["Auth", "Token"] }
      ]
    });
    const phases = compileCanvasApply(intent, context).phases;
    expect(phases.map((phase) => phase.name)).toEqual(["nodePortalWrites", "marks", "markConnections"]);
    expect(phases[1].operations).toEqual([{ type: "mark.create", text: "Flow", x: -200, y: -100 }]);
    expect(phases[2].operations).toEqual([
      { type: "mark.connect", id: "created:0", node: "Token" },
      { type: "mark.connect", id: MARK, node: "Token" }
    ]);
    expect(bindCreatedMarks(phases[2].operations, ["new-mark"])[0]).toEqual({ type: "mark.connect", id: "new-mark", node: "Token" });
  });

  it("refuses handwriting updates, unknown ids, and unknown connections", () => {
    for (const marks of [
      [{ mode: "update", id: INK, text: "Clean" }],
      [{ mode: "remove", id: "33333333-3333-4333-8333-333333333333" }],
      [{ mode: "create", text: "Note", x: 0, y: 0, connect: ["Missing"] }]
    ]) {
      expect(() => compileCanvasApply(parseCanvasIntent({ canvas: "current", marks }), context)).toThrow();
    }
  });

  it("checks formatting-only updates against the Mark's current text", () => {
    const intent = parseCanvasIntent({ canvas: "current", marks: [
      { mode: "update", id: MARK, textRuns: [{ location: 10, length: 1, styles: ["bold"] }] }
    ] });
    expect(() => compileCanvasApply(intent, context)).toThrow("lies outside its text");
  });

  it("refuses a connection to a Node the same intent removes", () => {
    const intent = parseCanvasIntent({ canvas: "current",
      nodes: [{ kind: "note", mode: "remove", selector: "Auth" }],
      marks: [{ mode: "create", text: "Why?", x: 0, y: 0, connect: ["Auth"] }] });
    expect(() => compileCanvasApply(intent, context)).toThrow("targets a Node this intent removes");
  });

  it("verifies requested formatting regardless of style order", () => {
    const intent = parseCanvasIntent({ canvas: "current", marks: [
      { mode: "update", id: MARK, textRuns: [{ location: 0, length: 3, styles: ["bold", "italic"] }] }
    ] });
    const stored = (textRuns: unknown[]) => ({ nodes: context.nodes, marks: [{ ...context.marks[0], textRuns }] });
    expect(verifyCanvasIntent(intent, stored([{ location: 0, length: 3, styles: ["italic", "bold"] }])).ok).toBe(true);
    expect(verifyCanvasIntent(intent, stored([])).mismatches).toEqual([`marks:${MARK}:textRuns`]);
  });

  it("estimates wrapped lines inside a narrow Mark", () => {
    const narrow = markWorldBox({ x: 0, y: 0, width: 100, text: "a".repeat(100) });
    const wide = markWorldBox({ x: 0, y: 0, width: 1000, text: "a".repeat(100) });
    expect(narrow.maxY).toBeGreaterThan(wide.maxY * 5);
  });

  it("refuses to connect a later Mark when an earlier creation returned no id", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/apply") return Response.json({ ok: true, data: { results: [{}, { mark: { id: "second" } }] } });
      return Response.json({ ok: true, data: { nodes: [{ ...context.nodes[0], position: { x: 0, y: 0 } }], marks: [] } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({ canvas: "current", marks: [
      { mode: "create", text: "First", x: 0, y: 0, connect: ["Auth"] },
      { mode: "create", text: "Second", x: 0, y: 100 }
    ] })]);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "operation_failed", details: { failedBatch: "markConnections" } });
    expect(calls.filter((call) => new URL(call.url).pathname === "/v1/apply")).toHaveLength(1);
  });

  it("reports landed batches when the app returns no id for a created Mark", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/apply") return Response.json({ ok: true, data: { results: [{}] } });
      return Response.json({ ok: true, data: { nodes: [{ ...context.nodes[0], position: { x: 0, y: 0 } }], marks: [] } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({ canvas: "current",
      marks: [{ mode: "create", text: "Why?", x: 5, y: 5, connect: ["Auth"] }] })]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "operation_failed", details: {
      appliedBatches: [{ name: "marks", count: 1 }], failedBatch: "markConnections", retrySections: ["marks.connect"]
    } });
  });

  it("verifies text, position, and connections of created and updated Marks", () => {
    const intent = parseCanvasIntent({ canvas: "current", marks: [
      { mode: "create", text: "Flow", x: 10, y: 20, connect: ["Auth"] },
      { mode: "update", id: MARK, text: "New" },
      { mode: "remove", id: INK }
    ] });
    const after = { nodes: context.nodes, marks: [
      { id: "new-mark", kind: "text", text: "Flow", position: { x: 10, y: 20 }, connectedNodeIDs: [] },
      { id: MARK, kind: "text", text: "Old", position: { x: 0, y: 0 }, connectedNodeIDs: [] },
      context.marks[1]
    ] };
    const results = [{ type: "mark.create", id: "new-mark" }];
    expect(verifyCanvasIntent(intent, after, results).mismatches).toEqual([
      "marks:create:0:connect:Auth", `marks:${MARK}:text`, `marks:${INK}`
    ]);
  });

  it("applies a created Mark and its connection with the returned id", async () => {
    let verified = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = new URL(String(url)).pathname;
      if (path === "/v1/apply") {
        const operations = JSON.parse(String(init?.body)).operations as Array<{ type: string }>;
        if (operations[0].type === "mark.create") return Response.json({ ok: true, data: { results: [{ mark: { id: "new-mark" } }] } });
        verified = true;
        return Response.json({ ok: true, data: { results: [{ mark: { id: "new-mark" } }] } });
      }
      const marks = verified ? [{ id: "new-mark", kind: "text", text: "Why?", position: { x: 5, y: 5 }, connectedNodeIDs: ["auth"] }] : [];
      return Response.json({ ok: true, data: { nodes: [{ ...context.nodes[0], position: { x: 0, y: 0 } }], marks } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({ canvas: "current",
      marks: [{ mode: "create", text: "Why?", x: 5, y: 5, connect: ["Auth"] }] })]);
    expect(result.stderr).toBe("");
    const applies = calls.filter((call) => new URL(call.url).pathname === "/v1/apply").map((call) => JSON.parse(String(call.init.body)).operations);
    expect(applies[1]).toEqual([{ type: "mark.connect", id: "new-mark", node: "Auth" }]);
    expect(JSON.parse(result.stdout).data.verification.status).toBe("verified");
  });

  it("names an app without Marks as outdated before writing", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: { nodes: [] } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({ canvas: "current",
      marks: [{ mode: "create", text: "Title", x: 0, y: 0 }] })]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("app_outdated");
    expect(calls.some((call) => new URL(call.url).pathname === "/v1/apply")).toBe(false);
  });

  it("moves created Marks with the rest of a creation recentered on an empty Canvas", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: { nodes: [], marks: [] } });
    });
    const result = await run(["canvas", "apply", "--dry-run", "--json", JSON.stringify({ canvas: "current",
      marks: [{ mode: "create", text: "Title", x: 0, y: 0, width: 200 }] })]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.placement.recentered).toBe(true);
    const created = data.phases[0].operations[0];
    expect(created.x + 100).toBeCloseTo(25_000);
    expect(created.x).toBe(data.placement.dx);
  });
});
