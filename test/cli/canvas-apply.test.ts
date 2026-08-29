import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

describe("canvas apply", () => {
  it("prints the machine-readable canvas apply contract without contacting the bridge", async () => {
    const result = await run(["canvas", "apply", "--schema"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        transports: ["file", "--json <literal>", "--json -"],
        input: { required: ["canvas"] },
        validation: { local: "complete" },
        partialApplication: { atomicity: "per-phase" }
      }
    });
    const contract = JSON.parse(result.stdout).data;
    expect(contract.input.links.direction).toEqual(["directed", "undirected", "bidirectional"]);
    expect(contract.input.primitives.create.geometry).toEqual({
      region: { required: ["x", "y", "width", "height"], optional: ["fillOpacity"] },
      line: { required: ["x1", "y1", "x2", "y2"] }
    });
  });

  it("rejects divider intents before contacting the bridge", async () => {
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      primitives: [{ kind: "divider", mode: "create", orientation: "horizontal", x: 10, y: 20, length: 400 }]
    })]);
    expect(result.code).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
  });

  it("rejects a color the app would refuse before contacting the bridge", async () => {
    const region = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      primitives: [{ kind: "region", mode: "create", title: "Identity", x: 0, y: 0, width: 400, height: 240, color: "slate-ish" }]
    }), "--dry-run"]);
    expect(region.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(region.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("#RRGGBB"), details: { path: "primitives.0.color" } }
    });

    const link = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      links: [{ mode: "create", source: "A", target: "B", color: "#12" }]
    }), "--dry-run"]);
    expect(link.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(link.stderr).error.details.path).toBe("links.0.color");
  });

  it("omits compact result entries with no auditable fields", async () => {
    let inspections = 0;
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        inspections += 1;
        return Response.json({ ok: true, data: { nodes: inspections === 1 ? [] : [{ id: "node-1", title: "A" }], links: [], diagramPrimitives: [] } });
      }
      return Response.json({ ok: true, data: { results: [{ operation: "created", value: "node-1" }] } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "create", title: "A", x: 1, y: 2 }]
    })]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.results).toEqual([]);
  });

  it("rejects conflicting file and --json transports before contacting the bridge", async () => {
    const intent = join(tempDir, "intent.json");
    writeFileSync(intent, JSON.stringify({ canvas: "current" }));
    const result = await run(["canvas", "apply", intent, "--json", JSON.stringify({ canvas: "current" })]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { path: "transport", expected: expect.any(String) } }
    });
  });

  it("requires an explicit canvas target", async () => {
    const result = await run(["canvas", "apply", "--json", JSON.stringify({ nodes: [] }), "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { path: "canvas" } }
    });
  });

  it("inspects and verifies the exact named canvas for an explicit create", async () => {
    let inspections = 0;
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/canvases/Roadmap/inspect") {
        inspections += 1;
        return Response.json({ ok: true, data: { nodes: inspections === 1 ? [] : [{ id: "node-1", title: "API" }], links: [], diagramPrimitives: [] } });
      }
      if (pathname === "/v1/apply") {
        return Response.json({ ok: true, data: { results: [{ type: "node.create", id: "node-1", status: "created" }] } });
      }
      return Response.json({ ok: true, data: {} });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "Roadmap",
      nodes: [{ kind: "note", mode: "create", title: "API", content: "# API", x: 10, y: 20 }]
    })]);
    expect(result.code).toBe(0);
    expect(calls.filter((call) => new URL(call.url).pathname === "/v1/canvases/Roadmap/inspect")).toHaveLength(2);
    expect(calls.some((call) => new URL(call.url).pathname === "/v1/context")).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        appliedBatches: [{ name: "nodePortalWrites", count: 1 }],
        results: [{ type: "node.create", id: "node-1", status: "created" }],
        verification: { status: "verified" }
      }
    });
  });

  it("returns verification_failed without reapplying when a created element is absent", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      if (pathname === "/v1/apply") return Response.json({ ok: true, data: { results: [{ type: "node.create", id: "node-1", status: "created" }] } });
      return Response.json({ ok: true, data: {} });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "create", title: "Missing", x: 1, y: 2 }]
    })]);
    expect(result.code).toBe(1);
    expect(calls.filter((call) => new URL(call.url).pathname === "/v1/apply")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "verification_failed", details: { appliedBatches: [{ name: "nodePortalWrites", count: 1 }] } }
    });
  });

  it("rejects reversed duplicate Link pairs before contacting the bridge", async () => {
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      links: [
        { mode: "create", source: "A", target: "B" },
        { mode: "create", source: "B", target: "A" }
      ]
    }), "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { path: "links" } }
    });
  });

  it("compiles a link endpoint move into the link phase after resolving the new endpoint", async () => {
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    const link = "00000000-0000-4000-8000-000000000003";
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") return Response.json({ ok: true, data: {
        nodes: [{ id: a, title: "A" }, { id: b, title: "B" }],
        links: [{ id: link, sourceNodeID: a, targetNodeID: b }],
        diagramPrimitives: []
      } });
      return Response.json({ ok: true, data: { results: [] } });
    });
    const intent = (links: unknown[]) => JSON.stringify({ canvas: "current", nodes: [], links, primitives: [] });

    const missing = await run(["canvas", "apply", "--json", intent([{ mode: "update", id: link, target: "Nowhere" }]), "--dry-run"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr).error.code).toBe("missing_selector");

    const refused = await run(["canvas", "apply", "--json", intent([{ mode: "update", id: link, source: "B", syncProse: true }]), "--dry-run"]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr).error.code).toBe("invalid_input");

    calls.length = 0;
    const applied = await run(["canvas", "apply", "--json", intent([{ mode: "update", id: link, target: null, targetPosition: { x: 320, y: -180 } }])]);
    expect(applied.code).toBe(0);
    const applies = calls.filter((call) => new URL(call.url).pathname === "/v1/apply").map((call) => JSON.parse(String(call.init.body)));
    expect(applies.flatMap((body) => body.operations)).toContainEqual({ type: "link.update", id: link, target: null, targetPosition: { x: 320, y: -180 } });
  });

  it("reports truthful staged partial application when a later phase fails", async () => {
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    const link = "00000000-0000-4000-8000-000000000003";
    const primitive = "00000000-0000-4000-8000-000000000004";
    let applies = 0;
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/context") return Response.json({ ok: true, data: {
        nodes: [{ id: a, title: "A" }, { id: b, title: "B" }],
        links: [{ id: link, sourceNodeID: a, targetNodeID: b }],
        diagramPrimitives: [{ id: primitive, kind: "group" }]
      } });
      if (pathname !== "/v1/apply") return Response.json({ ok: true, data: {} });
      applies += 1;
      if (applies === 4) return Response.json({ ok: false, error: { code: "link_conflict", message: "Link changed", details: {} } });
      return Response.json({ ok: true, data: { results: [{ type: "phase", id: `result-${applies}`, status: "applied" }] } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [
        { kind: "note", mode: "remove", selector: "A" },
        { kind: "note", mode: "create", title: "C", x: 1, y: 2 }
      ],
      links: [
        { mode: "remove", id: link },
        { mode: "create", source: "C", target: "B" }
      ],
      primitives: [{ kind: "region", mode: "remove", id: primitive }]
    })]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "link_conflict",
        details: {
          appliedBatches: [
            { name: "linkRemovals", count: 1 },
            { name: "nodePortalRemovals", count: 1 },
            { name: "nodePortalWrites", count: 1 }
          ],
          failedBatch: "linkWrites",
          returnedIds: ["result-1", "result-2", "result-3"],
          retrySections: ["links.create", "links.update"]
        }
      }
    });
  });

  it("describes dry-run bridge validation without a top-level valid claim", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      return Response.json({ ok: true, data: { valid: true } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "create", title: "A", x: 1, y: 2 }]
    }), "--dry-run"]);
    const data = JSON.parse(result.stdout).data;
    expect(data).not.toHaveProperty("valid");
    expect(data).toMatchObject({
      preflightPassed: true,
      validation: { local: "complete", bridgeValidated: ["nodePortalWrites"], deferredUntilApply: [] },
      planned: { nodePortalWrites: 1 }
    });
  });

  it("defers bridge validation for a named Canvas instead of validating the open Canvas", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "Roadmap",
      nodes: [{ kind: "note", mode: "create", title: "A", x: 1, y: 2 }]
    }), "--dry-run"]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/canvases/Roadmap/inspect", "/v1/search"]);
    expect(JSON.parse(result.stdout).data.validation).toEqual({
      local: "complete",
      bridgeValidated: [],
      deferredUntilApply: ["nodePortalWrites"]
    });
  });

  it("treats an identical existing Link create as a preflight no-op", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: {
        nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
        links: [{ id: "link", sourceNodeID: "a", targetNodeID: "b", label: "uses", direction: "directed" }],
        diagramPrimitives: []
      } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      links: [{ mode: "create", source: "A", target: "B", label: "uses", direction: "directed" }]
    }), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      preflightPassed: true,
      validation: { bridgeValidated: [], deferredUntilApply: [] },
      planned: {}
    });
  });

  it("flags shared Note writes in dry-run output", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: { nodes: [{ id: "a", title: "A" }], links: [], diagramPrimitives: [] } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "update", selector: "A", content: "changed" }]
    }), "--dry-run"]);
    expect(JSON.parse(result.stdout).data.sharedNoteWrites).toEqual(["A"]);
  });

  it("preflights an unplaced Note reuse by exact Note name", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      if (parsed.pathname === "/v1/search") return Response.json({ ok: true, data: { results: [{ type: "file", path: "Files/API Gateway.md" }] } });
      return Response.json({ ok: true, data: { valid: true } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "reuse", selector: "API Gateway", x: 1, y: 2 }]
    }), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/context", "/v1/search", "/v1/apply"]);
  });

  it("accepts a Link endpoint that a reuse node places in an earlier phase", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      if (parsed.pathname === "/v1/search") return Response.json({ ok: true, data: { results: [{ type: "file", path: "Files/API Gateway.md" }] } });
      return Response.json({ ok: true, data: { valid: true } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [
        { kind: "note", mode: "reuse", selector: "API Gateway", x: 1, y: 2 },
        { kind: "note", mode: "create", title: "Client", x: 3, y: 4 }
      ],
      links: [{ mode: "create", source: "Client", target: "API Gateway" }]
    }), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.planned).toMatchObject({ nodePortalWrites: 2, linkWrites: 1 });
  });

  it("rejects a create Note whose title already exists in the vault", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      if (parsed.pathname === "/v1/search") return Response.json({ ok: true, data: { results: [{ type: "file", path: "Files/Agent.md" }] } });
      return Response.json({ ok: true, data: { valid: true } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "create", title: "Agent", x: 0, y: 0 }]
    }), "--dry-run"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "note_exists", details: { hint: expect.stringContaining("reuse") } }
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/context", "/v1/search"]);
  });

  it("creates a Note whose title only fuzzy-matches vault search results", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      if (parsed.pathname === "/v1/search") return Response.json({ ok: true, data: { results: [{ type: "file", path: "Files/Agent Notes.md" }] } });
      return Response.json({ ok: true, data: { valid: true } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "create", title: "Agent", x: 0, y: 0 }]
    }), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.preflightPassed).toBe(true);
  });

  it("keeps an identical on-canvas Note create idempotent despite a vault title match", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/context") return Response.json({ ok: true, data: {
        nodes: [{ id: "n1", kind: "note", title: "Agent", content: "", position: { x: 0, y: 0 } }],
        links: [],
        diagramPrimitives: []
      } });
      if (parsed.pathname === "/v1/search") return Response.json({ ok: true, data: { results: [{ type: "file", path: "Files/Agent.md" }] } });
      return Response.json({ ok: true, data: { valid: true } });
    });
    const result = await run(["canvas", "apply", "--json", JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "create", title: "Agent", x: 0, y: 0 }]
    }), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.planned).not.toHaveProperty("nodePortalWrites");
  });

  it("builds notes, portals, links, regions, and lines from one JSON file", async () => {
    let inspections = 0;
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        inspections += 1;
        return Response.json({ ok: true, data: inspections === 1
          ? { nodes: [{ id: "vault", title: "Vault Manager" }], links: [], diagramPrimitives: [] }
          : {
              nodes: [{ id: "cli", title: "CLI" }, { id: "vault", title: "Vault Manager" }, { id: "portal", title: "Sync Detail", kind: "portal" }],
              links: [{ id: "l1", sourceNodeID: "cli", targetNodeID: "vault" }, { id: "l2", sourceNodeID: "vault", targetNodeID: "portal" }],
              diagramPrimitives: []
            } });
      }
      return Response.json({ ok: true, data: { results: [] } });
    });
    const intent = join(tempDir, "sync-server.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "current",
      nodes: [
        { kind: "note", mode: "create", title: "CLI", content: "Command surface", x: 550, y: 2000 },
        { kind: "note", mode: "reuse", selector: "Vault Manager", x: 1000, y: 2000 },
        { kind: "portal", mode: "create", title: "Sync Detail", subcanvasRef: "Canvases/Sync Detail.json", x: 1450, y: 2000 }
      ],
      links: [
        { mode: "create", source: "CLI", target: "Vault Manager", label: "writes through", direction: "directed" },
        { mode: "create", source: "Vault Manager", target: "Sync Detail", label: "syncs", direction: "directed" }
      ],
      primitives: [
        { kind: "region", mode: "create", title: "Persistence", x: 1225, y: 2000, width: 830, height: 300 },
        { kind: "line", mode: "create", title: "Control Plane", x1: 390, y1: 1820, x2: 1610, y2: 1820 },
        { kind: "line", mode: "create", title: "Section split", x1: 800, y1: 2300, x2: 1700, y2: 2300, color: "#6B7280" }
      ]
    }));

    const result = await run(["canvas", "apply", intent]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(new URL(calls[0].url).pathname).toBe("/v1/context");
    const applyCalls = calls.filter((call) => new URL(call.url).pathname === "/v1/apply");
    // Every batch — not just the first — must carry ?dryRun=false on a real apply.
    expect(applyCalls).toHaveLength(3);
    for (const call of applyCalls) {
      expect(new URL(call.url).searchParams.get("dryRun")).toBe("false");
    }
    const nodePatch = JSON.parse(String(applyCalls[0].init.body));
    expect(nodePatch.operations).toMatchObject([
      { type: "node.create", title: "CLI", content: "Command surface", x: 550, y: 2000 },
      { type: "node.create", title: "Vault Manager", placeExisting: true, x: 1000, y: 2000 },
      { type: "portal.create", title: "Sync Detail", subcanvasRef: "Canvases/Sync Detail.json", x: 1450, y: 2000 }
    ]);

    const linkPatch = JSON.parse(String(applyCalls[1].init.body));
    expect(linkPatch.operations).toMatchObject([
      { type: "link.create", source: "CLI", target: "Vault Manager", label: "writes through", direction: "directed" },
      { type: "link.create", source: "Vault Manager", target: "Sync Detail", label: "syncs", direction: "directed" }
    ]);

    const primitivePatch = JSON.parse(String(applyCalls[2].init.body));
    expect(primitivePatch.operations).toMatchObject([
      { type: "group.create", title: "Persistence", x: 1225, y: 2000, width: 830, height: 300 },
      { type: "line.create", title: "Control Plane", x1: 390, y1: 1820, x2: 1610, y2: 1820 },
      { type: "line.create", title: "Section split", x1: 800, y1: 2300, x2: 1700, y2: 2300, color: "#6B7280" }
    ]);
  });

  it("retargets an existing portal with explicit update mode", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/canvases/Sync%20Server/inspect") {
        return Response.json({ ok: true, data: {
          nodes: [{ id: "portal-1", title: "Sync Detail", position: { x: 1450, y: 2000 } }],
          links: [],
          diagramPrimitives: []
        } });
      }
      return Response.json({ ok: true, data: { results: [] } });
    });
    const intent = join(tempDir, "retarget.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "Sync Server",
      nodes: [{ kind: "portal", mode: "update", selector: "Sync Detail", subcanvasRef: "Canvases/New Detail.json" }]
    }));

    const result = await run(["canvas", "apply", intent]);
    expect(result.code).toBe(0);
    const applyCall = calls.find((call) => new URL(call.url).pathname === "/v1/apply");
    const nodePatch = JSON.parse(String(applyCall!.init.body));
    expect(nodePatch.operations).toMatchObject([
      { type: "portal.changeSubcanvas", selector: "Sync Detail", subcanvasRef: "Canvases/New Detail.json" }
    ]);
  });

  it("reports staged state when a later batch fails", async () => {
    let applyCalls = 0;
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/context") {
        return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      }
      if (pathname !== "/v1/apply") return Response.json({ ok: true, data: {} });
      applyCalls += 1;
      if (applyCalls === 1) return Response.json({ ok: true, data: {} });
      return Response.json({ ok: false, error: { code: "invalid_input", message: "link failed", details: {} } });
    });
    const intent = join(tempDir, "partial.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "create", title: "A", content: "a", x: 1, y: 1 }, { kind: "note", mode: "create", title: "B", content: "b", x: 2, y: 2 }],
      links: [{ mode: "create", source: "A", target: "B" }]
    }));

    const result = await run(["canvas", "apply", intent]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.details).toMatchObject({
      failedBatch: "linkWrites",
      appliedBatches: [{ name: "nodePortalWrites", count: 2 }]
    });
  });

  it("updates existing primitives by app UUID and sends dryRun=false", async () => {
    const group = "00000000-0000-4000-8000-000000000011";
    const line = "00000000-0000-4000-8000-000000000013";
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: {
          nodes: [],
          links: [],
          diagramPrimitives: [
            { id: group, kind: "group" },
            { id: line, kind: "line" }
          ]
        } });
      }
      return Response.json({ ok: true, data: {} });
    });
    const intent = join(tempDir, "dedupe.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "current",
      primitives: [
        { kind: "region", mode: "update", id: group, title: "Persistence", x: 1, y: 2, width: 100, height: 50 },
        { kind: "line", mode: "update", id: line, title: "Boundary", x1: 1, y1: 2, x2: 3, y2: 4 }
      ]
    }));

    const result = await run(["canvas", "apply", intent]);
    expect(result.code).toBe(0);
    const applyCall = calls.find((call) => new URL(call.url).pathname === "/v1/apply")!;
    expect(new URL(applyCall.url).searchParams.get("dryRun")).toBe("false");
    expect(JSON.parse(String(applyCall.init.body)).operations).toMatchObject([
      { type: "diagramPrimitive.update", id: group, title: "Persistence" },
      { type: "diagramPrimitive.update", id: line, title: "Boundary" }
    ]);
  });

  it("rejects duplicate declared node titles before any bridge call", async () => {
    const dupNodes = join(tempDir, "dup-nodes.json");
    writeFileSync(dupNodes, JSON.stringify({ canvas: "current", nodes: [
      { kind: "note", mode: "create", title: "A", x: 1, y: 1 },
      { kind: "note", mode: "create", title: "A", x: 2, y: 2 }
    ] }));
    const r1 = await run(["canvas", "apply", dupNodes, "--dry-run"]);
    expect(r1.code).toBe(1);
    expect(calls).toHaveLength(0);

  });

  it("skips node.move when an existing node's position is unchanged", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: {
          nodes: [{ id: "n1", title: "A", displayTitle: "A", position: { x: 5, y: 5 } }],
          links: [], diagramPrimitives: []
        } });
      }
      return Response.json({ ok: true, data: {} });
    });
    const intent = join(tempDir, "noop-move.json");
    writeFileSync(intent, JSON.stringify({ canvas: "current", nodes: [{ kind: "note", mode: "update", selector: "A", x: 5, y: 5 }] }));
    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(0);
    // No batches: the only node is unchanged, so no node.move op is emitted.
    expect(JSON.parse(result.stdout).data.planned).not.toHaveProperty("nodePortalWrites");
  });

  it("rejects content on an existing node", async () => {
    const intent = join(tempDir, "existing-content.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "note", mode: "reuse", selector: "API Gateway", content: "updated body", x: 1, y: 2 }]
    }));
    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("rejects a subcanvas shorthand containing path separators", async () => {
    const intent = join(tempDir, "bad-subcanvas.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "current",
      nodes: [{ kind: "portal", mode: "create", title: "Detail", subcanvas: "Canvases/Detail.json", x: 1, y: 2 }]
    }));
    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("dry-runs only the first bridge patch and returns the full compiled plan", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      }
      return Response.json({ ok: true, data: { dryRun: true, valid: true } });
    });
    const intent = join(tempDir, "auth-flow-dry-run.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "current",
      nodes: [
        { kind: "note", mode: "create", title: "A", x: 100, y: 200 },
        { kind: "note", mode: "create", title: "B", x: 550, y: 200 }
      ],
      links: [{ mode: "create", source: "A", target: "B" }]
    }));

    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/context", "/v1/search", "/v1/search", "/v1/apply"]);
    expect(new URL(calls[3].url).pathname + new URL(calls[3].url).search).toBe("/v1/apply?dryRun=true");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        dryRun: true,
        preflightPassed: true,
        validation: { bridgeValidated: ["nodePortalWrites"], deferredUntilApply: ["linkWrites"] },
        planned: { nodePortalWrites: 2, linkWrites: 1 }
      }
    });
  });

  it("does not turn the bridge dry-run payload into a misleading top-level valid claim", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      }
      return Response.json({ ok: true, data: { dryRun: true, valid: false } });
    });
    const intent = join(tempDir, "invalid-dry-run.json");
    writeFileSync(intent, JSON.stringify({ canvas: "current", nodes: [{ kind: "note", mode: "create", title: "A", x: 1, y: 2 }] }));

    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).not.toHaveProperty("valid");
  });
});
