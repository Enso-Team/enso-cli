import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LAYOUT_GEOMETRY } from "../../src/layout.js";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

const FLOW_SPEC = [
  "---",
  "canvas: Request Flow",
  "direction: LR",
  "members:",
  "  - Gateway",
  "  - Router",
  "  - Store",
  "  - Audit Log",
  "  - Metrics",
  "edges:",
  "  - from: Gateway",
  "    to: Router",
  "    label: routes",
  "  - from: Router",
  "    to: Store",
  "    direction: directed",
  "  - from: Router",
  "    to: Audit Log",
  "  - from: Audit Log",
  "    to: Metrics",
  "clusters:",
  "  - name: Edge",
  "    color: \"#6B7280\"",
  "    members:",
  "      - Gateway",
  "      - Router",
  "  - name: Observability",
  "    members:",
  "      - Audit Log",
  "      - Metrics",
  "---",
  "",
  "How a request reaches the store.",
  ""
].join("\n");

function writeSpec(contents: string, name = "flow.canvas.md"): string {
  const path = join(tempDir, name);
  writeFileSync(path, contents);
  return path;
}

type PatchNode = { title?: string; selector?: string; x: number; y: number };
type PatchRegion = { title: string; x: number; y: number; width: number; height: number };
type Patch = { canvas: string; nodes: PatchNode[]; links: Array<Record<string, unknown>>; primitives: PatchRegion[] };

function patchOf(stdout: string): Patch {
  return JSON.parse(stdout).data.patch as Patch;
}

describe("layout", () => {
  it("exposes spacing constants for agent layout recipes", () => {
    expect(LAYOUT_GEOMETRY).toMatchObject({ colStep: 450, rowStep: 280, nodeWidth: 220, nodeHeight: 140 });
  });

  it("prints the machine-readable canvas spec contract without contacting the bridge", async () => {
    const result = await run(["layout", "--schema"]);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { frontmatter: { direction: { values: ["TB", "LR"], default: "TB" } }, body: "descriptive prose, never compiled" }
    });
  });

  it("emits byte-identical geometry for identical spec input", async () => {
    const spec = writeSpec(FLOW_SPEC);
    const out = join(tempDir, "patch.json");
    const first = await run(["layout", spec, "--out", out]);
    const firstPatch = readFileSync(out, "utf8");
    const second = await run(["layout", spec, "--out", out]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(second.stdout).toBe(first.stdout);
    expect(readFileSync(out, "utf8")).toBe(firstPatch);
    expect(JSON.parse(first.stdout).data.compiled).toEqual({ nodes: 5, links: 4, regions: 2 });
  });

  it("ranks members along the direction hint and centers each rank", async () => {
    const horizontal = patchOf((await run(["layout", writeSpec(FLOW_SPEC)])).stdout);
    const vertical = patchOf((await run(["layout", writeSpec(FLOW_SPEC.replace("direction: LR", "direction: TB"), "tb.canvas.md")])).stdout);
    const gateway = horizontal.nodes.find((node) => node.title === "Gateway")!;
    const router = horizontal.nodes.find((node) => node.title === "Router")!;
    expect(router.x - gateway.x).toBe(LAYOUT_GEOMETRY.colStep);
    expect(gateway.y).toBe(0);
    const verticalGateway = vertical.nodes.find((node) => node.title === "Gateway")!;
    const verticalRouter = vertical.nodes.find((node) => node.title === "Router")!;
    expect(verticalRouter.y - verticalGateway.y).toBe(LAYOUT_GEOMETRY.rowStep);
    expect(verticalGateway.x).toBe(0);
  });

  it("keeps every member clear of every other member", async () => {
    const patch = patchOf((await run(["layout", writeSpec(FLOW_SPEC)])).stdout);
    for (const [index, node] of patch.nodes.entries()) {
      for (const other of patch.nodes.slice(index + 1)) {
        const overlaps = Math.abs(node.x - other.x) < LAYOUT_GEOMETRY.nodeWidth
          && Math.abs(node.y - other.y) < LAYOUT_GEOMETRY.nodeHeight;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("derives cluster region bounds from member bounds plus padding", async () => {
    const patch = patchOf((await run(["layout", writeSpec(FLOW_SPEC)])).stdout);
    const region = patch.primitives.find((primitive) => primitive.title === "Edge")!;
    const members = patch.nodes.filter((node) => ["Gateway", "Router"].includes(node.title ?? ""));
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member.x - LAYOUT_GEOMETRY.nodeWidth / 2).toBeGreaterThanOrEqual(region.x - region.width / 2);
      expect(member.x + LAYOUT_GEOMETRY.nodeWidth / 2).toBeLessThanOrEqual(region.x + region.width / 2);
      expect(member.y - LAYOUT_GEOMETRY.nodeHeight / 2).toBeGreaterThanOrEqual(region.y - region.height / 2);
      expect(member.y + LAYOUT_GEOMETRY.nodeHeight / 2).toBeLessThanOrEqual(region.y + region.height / 2);
    }
    const spread = Math.max(...members.map((member) => member.x)) - Math.min(...members.map((member) => member.x));
    expect(region.width).toBe(spread + LAYOUT_GEOMETRY.nodeWidth + 2 * LAYOUT_GEOMETRY.clusterPadding);
    expect(patch.primitives.every((primitive) => primitive.width > 0 && primitive.height > 0)).toBe(true);
  });

  it("compiles reuse members and edge visuals into the apply patch", async () => {
    const spec = writeSpec([
      "---",
      "canvas: current",
      "members:",
      "  - title: Existing Note",
      "    mode: reuse",
      "  - New Note",
      "edges:",
      "  - from: Existing Note",
      "    to: New Note",
      "    label: feeds",
      "    direction: bidirectional",
      "    color: \"#2563EB\"",
      "---",
      ""
    ].join("\n"), "reuse.canvas.md");
    const patch = patchOf((await run(["layout", spec])).stdout);
    expect(patch.nodes[0]).toMatchObject({ kind: "note", mode: "reuse", selector: "Existing Note" });
    expect(patch.nodes[1]).toMatchObject({ kind: "note", mode: "create", title: "New Note" });
    expect(patch.links[0]).toMatchObject({ mode: "create", source: "Existing Note", target: "New Note", label: "feeds", direction: "bidirectional", color: "#2563EB" });
  });

  it("emits a patch that canvas apply --dry-run accepts unmodified", async () => {
    const out = join(tempDir, "patch.json");
    const compiled = await run(["layout", writeSpec(FLOW_SPEC), "--out", out]);
    expect(compiled.code).toBe(0);
    const applied = await run(["canvas", "apply", out, "--dry-run"]);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      ok: true,
      data: { dryRun: true, preflightPassed: true, planned: { nodePortalWrites: 5, linkWrites: 4, primitives: 2 } }
    });
  });

  it("lands the compiled patch on a live canvas with --apply", async () => {
    let inspections = 0;
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/canvases/Request%20Flow/inspect") {
        inspections += 1;
        return Response.json({
          ok: true,
          data: {
            nodes: inspections === 1
              ? []
              : ["Gateway", "Router", "Store", "Audit Log", "Metrics"].map((title, index) => ({ id: `node-${index}`, title })),
            links: inspections === 1
              ? []
              : [["node-0", "node-1"], ["node-1", "node-2"], ["node-1", "node-3"], ["node-3", "node-4"]]
                .map(([sourceNodeID, targetNodeID], index) => ({ id: `link-${index}`, sourceNodeID, targetNodeID })),
            diagramPrimitives: []
          }
        });
      }
      if (pathname === "/v1/apply") {
        return Response.json({ ok: true, data: { results: [{ type: "node.create", id: "node-0", status: "created" }] } });
      }
      return Response.json({ ok: true, data: {} });
    });
    const result = await run(["layout", writeSpec(FLOW_SPEC), "--apply"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        canvas: "Request Flow",
        compiled: { nodes: 5, links: 4, regions: 2 },
        applied: {
          appliedBatches: [
            { name: "nodePortalWrites", count: 5 },
            { name: "linkWrites", count: 4 },
            { name: "primitives", count: 2 }
          ],
          verification: { status: "verified", target: "Request Flow" }
        }
      }
    });
  });

  it("validates through the pipeline without mutating for --apply --dry-run", async () => {
    const result = await run(["layout", writeSpec(FLOW_SPEC), "--apply", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(calls.some((call) => new URL(call.url).pathname === "/v1/apply")).toBe(false);
    expect(JSON.parse(result.stdout).data.applied).toMatchObject({ dryRun: true, preflightPassed: true });
  });

  it("names the phases the app validated and the phases validated locally alone", async () => {
    const result = await run(["layout", writeSpec(FLOW_SPEC.replace("canvas: Request Flow", "canvas: current")), "--apply", "--dry-run"]);
    expect(result.code).toBe(0);
    const validation = JSON.parse(result.stdout).data.validation;
    expect(validation).toEqual({ bridgeValidated: ["nodePortalWrites"], locallyValidatedOnly: ["linkWrites", "primitives"] });
  });

  it("rejects a color the app would refuse, before any bridge call", async () => {
    const result = await run(["layout", writeSpec(FLOW_SPEC.replace("\"#6B7280\"", "slate-ish"), "badcolor.canvas.md"), "--apply"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: expect.stringContaining("#RRGGBB"),
        details: { path: "clusters.0.color", expected: expect.stringContaining("teal") }
      }
    });
  });

  it("rejects a malformed hex color on an edge before any bridge call", async () => {
    const spec = writeSpec([
      "---",
      "canvas: current",
      "members:",
      "  - A",
      "  - B",
      "edges:",
      "  - from: A",
      "    to: B",
      "    color: \"#12\"",
      "---",
      ""
    ].join("\n"), "badedge.canvas.md");
    const result = await run(["layout", spec]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr).error.details.path).toBe("edges.0.color");
  });

  it.each([["#0AF"], ["#3B82F6"], ["#3B82F6CC"], ["green"], ["Teal"]])("accepts the app color %s", async (color) => {
    const spec = writeSpec([
      "---",
      "canvas: current",
      "members:",
      "  - A",
      "  - B",
      "clusters:",
      "  - name: Core",
      `    color: "${color}"`,
      "    members:",
      "      - A",
      "      - B",
      "---",
      ""
    ].join("\n"), "color.canvas.md");
    const result = await run(["layout", spec]);
    expect(result.code).toBe(0);
    expect(patchOf(result.stdout).primitives[0]).toMatchObject({ title: "Core", color });
  });

  it("reports a canvas that already holds the spec's members as one structured error", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: { nodes: [{ id: "node-0", title: "Gateway", position: { x: 0, y: 0 } }], links: [], diagramPrimitives: [] } });
      }
      return Response.json({ ok: true, data: {} });
    });
    const result = await run(["layout", writeSpec(FLOW_SPEC.replace("canvas: Request Flow", "canvas: current")), "--apply"]);
    expect(result.code).toBe(1);
    expect(calls.some((call) => new URL(call.url).pathname === "/v1/apply")).toBe(false);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "canvas_already_laid_out",
        message: expect.stringContaining("re-layout"),
        details: { hint: expect.stringContaining("#25"), cause: { code: "title_collision" } }
      }
    });
  });

  it("reports a reuse member the app rejects as already placed as the same structured error", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      if (pathname === "/v1/search") return Response.json({ ok: true, data: { results: [{ node: { title: "Existing Note" } }] } });
      if (pathname === "/v1/apply") {
        return Response.json({ ok: false, error: { code: "already_on_canvas", message: "Note is already on the current Canvas", details: {} } }, { status: 409 });
      }
      return Response.json({ ok: true, data: {} });
    });
    const spec = writeSpec([
      "---",
      "canvas: current",
      "members:",
      "  - title: Existing Note",
      "    mode: reuse",
      "---",
      ""
    ].join("\n"), "reuse-apply.canvas.md");
    const result = await run(["layout", spec, "--apply"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "canvas_already_laid_out",
        details: { hint: expect.stringContaining("#25"), failedBatch: "nodePortalWrites" }
      }
    });
  });

  it("rejects --dry-run without --apply before reading the spec", async () => {
    const result = await run(["layout", join(tempDir, "missing.canvas.md"), "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { path: "transport" } }
    });
  });

  it("reports an unreadable spec as a structured envelope", async () => {
    const result = await run(["layout", join(tempDir, "missing.canvas.md")]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "invalid_input", details: { path: "spec" } } });
  });

  it.each([
    ["a missing frontmatter fence", "canvas: Flow\nmembers:\n  - A\n", "frontmatter"],
    ["an unknown frontmatter key", "---\ncanvas: Flow\nmembers:\n  - A\nlayout: manual\n---\n", "frontmatter"],
    ["a missing canvas name", "---\nmembers:\n  - A\n---\n", "canvas"],
    ["an empty member list", "---\ncanvas: Flow\nmembers:\n  - A\n  - A\n---\n", "members"],
    ["an edge endpoint that is not a member", "---\ncanvas: Flow\nmembers:\n  - A\nedges:\n  - from: A\n    to: B\n---\n", "edges.to"],
    ["a cluster member that is not a canvas member", "---\ncanvas: Flow\nmembers:\n  - A\nclusters:\n  - name: Core\n    members:\n      - B\n---\n", "clusters.members"],
    ["an unknown direction hint", "---\ncanvas: Flow\ndirection: diagonal\nmembers:\n  - A\n---\n", "direction"],
    ["a malformed frontmatter line", "---\ncanvas: Flow\nmembers\n---\n", "frontmatter:3"],
    ["an inline collection", "---\ncanvas: Flow\nmembers: []\n---\n", "frontmatter:3"]
  ])("rejects %s as a structured envelope", async (_description, contents, path) => {
    const result = await run(["layout", writeSpec(contents, "broken.canvas.md")]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.any(String), details: { path, hint: expect.any(String) } }
    });
  });
});
