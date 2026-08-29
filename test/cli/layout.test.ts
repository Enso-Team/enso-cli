import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCanvasSpec } from "../../src/canvas-spec.js";
import { LAYOUT_GEOMETRY, compileCanvasSpec } from "../../src/layout.js";
import { CANVAS_WORLD_HOME, centerPatchOnCanvas } from "../../src/layout-centering.js";
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
    const first = await run(["layout", spec]);
    const second = await run(["layout", spec]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(second.stdout).toBe(first.stdout);
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

  it("scales node-center distances by --spacing and leaves sizes fixed", async () => {
    const standard = patchOf((await run(["layout", writeSpec(FLOW_SPEC)])).stdout);
    const spaced = patchOf((await run(["layout", writeSpec(FLOW_SPEC), "--spacing", "2"])).stdout);
    const gateway = standard.nodes.find((node) => node.title === "Gateway")!;
    const router = standard.nodes.find((node) => node.title === "Router")!;
    const spacedGateway = spaced.nodes.find((node) => node.title === "Gateway")!;
    const spacedRouter = spaced.nodes.find((node) => node.title === "Router")!;
    expect(spacedRouter.x - spacedGateway.x).toBe((router.x - gateway.x) * 2);
    expect(spaced.primitives[0].width - standard.primitives[0].width).toBe((spacedRouter.x - spacedGateway.x) - (router.x - gateway.x));
  });

  it("rejects a spacing factor outside 1 to 10", async () => {
    const result = await run(["layout", writeSpec(FLOW_SPEC), "--spacing", "0.5"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "invalid_input", details: { path: "spacing" } });
  });

  it("emits a patch that canvas apply --dry-run accepts unmodified", async () => {
    const out = join(tempDir, "patch.json");
    const compiled = await run(["layout", writeSpec(FLOW_SPEC)]);
    expect(compiled.code).toBe(0);
    writeFileSync(out, JSON.stringify(JSON.parse(compiled.stdout).data.patch));
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

  it("moves the compiled cluster onto the app's empty-canvas home before applying", async () => {
    const result = await run(["layout", writeSpec(FLOW_SPEC.replace("canvas: Request Flow", "canvas: current")), "--apply", "--dry-run"]);
    expect(result.code).toBe(0);
    const phases = JSON.parse(result.stdout).data.applied.phases as Array<{ name: string; operations: Array<{ x: number; y: number; width?: number; height?: number }> }>;
    const boxes = phases.flatMap((phase) => phase.name === "nodePortalWrites" || phase.name === "primitives"
      ? phase.operations.map((operation) => ({
          x: operation.x,
          y: operation.y,
          width: operation.width ?? LAYOUT_GEOMETRY.nodeWidth,
          height: operation.height ?? LAYOUT_GEOMETRY.nodeHeight
        }))
      : []);
    const midpoint = (low: number[], high: number[]) => (Math.min(...low) + Math.max(...high)) / 2;
    expect(midpoint(boxes.map((box) => box.x - box.width / 2), boxes.map((box) => box.x + box.width / 2))).toBe(CANVAS_WORLD_HOME.x);
    expect(midpoint(boxes.map((box) => box.y - box.height / 2), boxes.map((box) => box.y + box.height / 2))).toBe(CANVAS_WORLD_HOME.y);
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

  it("rejects --dry-run without --apply before reading the spec", async () => {
    const result = await run(["layout", join(tempDir, "missing.canvas.md"), "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { path: "usage", expected: expect.stringContaining("--apply") } }
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
    ["an inline collection", "---\ncanvas: Flow\nmembers: []\n---\n", "frontmatter:3"],
    ["a key named after an Object prototype member", "---\ncanvas: Flow\nmembers:\n  - A\nconstructor: X\n---\n", "frontmatter"]
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

// What the Canvas holds after a first `layout --apply` of a spec, as /v1/context reports it.
type CanvasContext = {
  nodes: Array<{ id: string; title: string; position: { x: number; y: number } }>;
  links: Array<{ id: string; sourceNodeID: string; targetNodeID: string; label: string | null; direction: string }>;
  diagramPrimitives: Array<Record<string, unknown>>;
};

const CURRENT_SPEC = FLOW_SPEC.replace("canvas: Request Flow", "canvas: current");

function laidOut(spec = CURRENT_SPEC, shift = { dx: 0, dy: 0 }): CanvasContext {
  const centered = centerPatchOnCanvas(compileCanvasSpec(parseCanvasSpec(spec)), undefined);
  const nodes = centered.nodes.map((node, index) => {
    const placed = node as { title?: string; selector?: string; x: number; y: number };
    return { id: `node-${index}`, title: placed.title ?? placed.selector ?? "", position: { x: placed.x + shift.dx, y: placed.y + shift.dy } };
  });
  const idOf = (title: string) => nodes.find((node) => node.title === title)!.id;
  const links = centered.links.map((link, index) => {
    const edge = link as { source: string; target: string; label?: string; direction?: string };
    return { id: `link-${index}`, sourceNodeID: idOf(edge.source), targetNodeID: idOf(edge.target), label: edge.label ?? null, direction: edge.direction ?? "directed" };
  });
  const diagramPrimitives = centered.primitives.map((primitive, index) => {
    const region = primitive as { title?: string; color?: string; x: number; y: number; width: number; height: number };
    return { id: `region-${index}`, kind: "group", title: region.title, color: region.color ?? null, x: region.x + shift.dx, y: region.y + shift.dy, width: region.width, height: region.height };
  });
  return { nodes, links, diagramPrimitives };
}

function canvasHolding(context: CanvasContext): void {
  vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/context") return Response.json({ ok: true, data: context });
    if (pathname === "/v1/search") return Response.json({ ok: true, data: { results: [] } });
    return Response.json({ ok: true, data: { results: [] } });
  });
}

type Operation = Record<string, unknown> & { type: string };

function operationsOf(stdout: string): Operation[] {
  const phases = JSON.parse(stdout).data.applied.phases as Array<{ operations: Operation[] }>;
  return phases.flatMap((phase) => phase.operations);
}

function applyCalls(): number {
  return calls.filter((call) => new URL(call.url).pathname === "/v1/apply").length;
}

describe("layout re-run", () => {
  it("sends nothing when the Canvas already matches the spec", async () => {
    canvasHolding(laidOut());
    const result = await run(["layout", writeSpec(CURRENT_SPEC), "--apply"]);
    expect(result.code).toBe(0);
    expect(applyCalls()).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      reconciled: {
        anchor: "existing-members",
        nodes: { created: 0, placed: 0, moved: 0, unchanged: 5, removed: 0 },
        links: { created: 0, updated: 0, unchanged: 4, removed: 0 },
        regions: { created: 0, updated: 0, unchanged: 2, removed: 0 }
      },
      applied: { appliedBatches: [], verification: { status: "verified" } }
    });
  });

  it("leaves a diagram where it was dragged as a whole", async () => {
    canvasHolding(laidOut(CURRENT_SPEC, { dx: 1200, dy: -400 }));
    const result = await run(["layout", writeSpec(CURRENT_SPEC), "--apply"]);
    expect(result.code).toBe(0);
    expect(applyCalls()).toBe(0);
    expect(JSON.parse(result.stdout).data.reconciled.nodes).toMatchObject({ moved: 0, unchanged: 5 });
  });

  it("creates a new member and moves the rest into the new arrangement", async () => {
    canvasHolding(laidOut());
    const grown = CURRENT_SPEC
      .replace("  - Metrics\n", "  - Metrics\n  - Cache\n")
      .replace("clusters:", "  - from: Router\n    to: Cache\nclusters:");
    const result = await run(["layout", writeSpec(grown, "grown.canvas.md"), "--apply", "--dry-run"]);
    expect(result.code).toBe(0);
    const operations = operationsOf(result.stdout);
    expect(operations.filter((operation) => operation.type === "node.create").map((operation) => operation.title)).toEqual(["Cache"]);
    expect(operations.filter((operation) => operation.type === "link.create")).toEqual([{ type: "link.create", source: "Router", target: "Cache" }]);
    const moves = operations.filter((operation) => operation.type === "node.move");
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) expect(String(move.selector)).toMatch(/^node-\d$/);
    expect(operations.every((operation) => operation.type !== "group.create")).toBe(true);
    expect(JSON.parse(result.stdout).data.reconciled).toMatchObject({ anchor: "existing-members", nodes: { created: 1, placed: 0 }, links: { created: 1, unchanged: 4 } });
  });

  it("keeps the diagram's centroid when members move", async () => {
    const before = laidOut(CURRENT_SPEC, { dx: 900, dy: 300 });
    canvasHolding(before);
    const result = await run(["layout", writeSpec(CURRENT_SPEC), "--apply", "--dry-run", "--spacing", "1.5"]);
    expect(result.code).toBe(0);
    const operations = operationsOf(result.stdout);
    expect([...new Set(operations.map((operation) => operation.type))].sort()).toEqual(["diagramPrimitive.update", "node.move"]);
    const after = new Map(before.nodes.map((node) => [node.id, { ...node.position }]));
    for (const move of operations.filter((operation) => operation.type === "node.move")) after.set(String(move.selector), { x: Number(move.x), y: Number(move.y) });
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    expect(mean([...after.values()].map((point) => point.x))).toBeCloseTo(mean(before.nodes.map((node) => node.position.x)), 6);
    expect(mean([...after.values()].map((point) => point.y))).toBeCloseTo(mean(before.nodes.map((node) => node.position.y)), 6);
  });

  it("updates an existing Link in place when its label changes", async () => {
    canvasHolding(laidOut());
    const relabelled = CURRENT_SPEC.replace("label: routes", "label: forwards");
    const result = await run(["layout", writeSpec(relabelled, "relabel.canvas.md"), "--apply", "--dry-run"]);
    expect(result.code).toBe(0);
    const operations = operationsOf(result.stdout);
    expect(operations).toEqual([{ type: "link.update", id: "link-0", label: "forwards" }]);
    expect(JSON.parse(result.stdout).data.reconciled.links).toMatchObject({ created: 0, updated: 1, unchanged: 3 });
  });

  it("moves a reuse member that is already on the Canvas instead of placing it again", async () => {
    const context = laidOut();
    context.nodes.push({ id: "node-existing", title: "Existing Note", position: { x: 0, y: 0 } });
    canvasHolding(context);
    const spec = writeSpec(["---", "canvas: current", "members:", "  - title: Existing Note", "    mode: reuse", "---", ""].join("\n"), "reuse-again.canvas.md");
    const result = await run(["layout", spec, "--apply", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(operationsOf(result.stdout).every((operation) => !("placeExisting" in operation))).toBe(true);
    expect(JSON.parse(result.stdout).data.reconciled.nodes).toMatchObject({ placed: 0, moved: 0, unchanged: 1 });
  });

  it("removes only what the spec no longer names with --prune", async () => {
    const context = laidOut();
    const router = context.nodes.find((node) => node.title === "Router")!;
    context.nodes.push({ id: "node-legacy", title: "Legacy", position: { x: 100, y: 100 } });
    context.links.push({ id: "link-legacy", sourceNodeID: "node-legacy", targetNodeID: router.id, label: null, direction: "directed" });
    context.links.push({ id: "link-stray", sourceNodeID: context.nodes[0].id, targetNodeID: context.nodes[4].id, label: null, direction: "directed" });
    context.diagramPrimitives.push({ id: "region-old", kind: "group", title: "Old", x: 0, y: 0, width: 10, height: 10 });
    context.diagramPrimitives.push({ id: "line-1", kind: "line", x1: 0, y1: 0, x2: 10, y2: 10 });
    canvasHolding(context);

    const kept = await run(["layout", writeSpec(CURRENT_SPEC), "--apply", "--dry-run"]);
    expect(kept.code).toBe(0);
    expect(operationsOf(kept.stdout)).toEqual([]);

    const pruned = await run(["layout", writeSpec(CURRENT_SPEC), "--apply", "--dry-run", "--prune"]);
    expect(pruned.code).toBe(0);
    expect(operationsOf(pruned.stdout)).toEqual([
      { type: "link.delete", id: "link-stray", fromNote: false },
      { type: "node.delete", selector: "node-legacy" },
      { type: "diagramPrimitive.delete", id: "region-old" }
    ]);
    expect(JSON.parse(pruned.stdout).data.reconciled).toMatchObject({ nodes: { removed: 1 }, links: { removed: 1 }, regions: { removed: 1 } });
  });

  it("refuses a Canvas that holds two Nodes for one member", async () => {
    const context = laidOut();
    context.nodes.push({ id: "node-dup", title: "Router", position: { x: 5, y: 5 } });
    canvasHolding(context);
    const result = await run(["layout", writeSpec(CURRENT_SPEC), "--apply"]);
    expect(result.code).toBe(1);
    expect(applyCalls()).toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "ambiguous_selector", details: { path: "members.Router" } } });
  });

  it("emits identical operations for identical spec and Canvas", async () => {
    canvasHolding(laidOut(CURRENT_SPEC, { dx: 300, dy: 0 }));
    const spec = writeSpec(CURRENT_SPEC);
    const first = await run(["layout", spec, "--apply", "--dry-run", "--spacing", "2"]);
    const second = await run(["layout", spec, "--apply", "--dry-run", "--spacing", "2"]);
    expect(first.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it("takes --prune only with --apply", async () => {
    const result = await run(["layout", writeSpec(CURRENT_SPEC), "--prune"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr).error.message).toContain("--prune");
  });
});
