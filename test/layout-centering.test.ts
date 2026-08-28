import { describe, expect, it } from "vitest";
import { parseCanvasIntent, type CanvasIntent } from "../src/canvas-intent.js";
import {
  ADJACENT_GAP,
  CANVAS_WORLD_HOME,
  centerPatchOnCanvas,
  centeringOffset,
  existingContent,
  isPureCreation,
  patchBounds,
  translatePatch
} from "../src/layout-centering.js";
import { LAYOUT_GEOMETRY } from "../src/layout.js";

function patch(overrides: Partial<{ nodes: unknown[]; primitives: unknown[] }> = {}): CanvasIntent {
  return parseCanvasIntent({
    canvas: "current",
    nodes: overrides.nodes ?? [
      { kind: "note", mode: "create", title: "A", x: -225, y: 0 },
      { kind: "note", mode: "create", title: "B", x: 225, y: 0 }
    ],
    links: [],
    primitives: overrides.primitives ?? [
      { kind: "region", mode: "create", title: "Core", x: 0, y: 0, width: 900, height: 260 }
    ]
  });
}

function center(value: CanvasIntent): { x: number; y: number } {
  const bounds = patchBounds(value)!;
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function contextWith(nodes: Array<{ x: number; y: number }>): Record<string, unknown> {
  return {
    nodes: nodes.map((position, index) => ({ id: `node-${index}`, title: `Existing ${index}`, position })),
    links: [],
    diagramPrimitives: []
  };
}

describe("layout centering", () => {
  it("centers on the app's empty-canvas home when the canvas holds nothing", () => {
    const placed = centerPatchOnCanvas(patch(), { nodes: [], links: [], diagramPrimitives: [] });
    expect(center(placed)).toEqual({ x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y });
  });

  it("falls back to the empty-canvas home when the bridge returned no context at all", () => {
    expect(center(centerPatchOnCanvas(patch(), undefined))).toEqual({ x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y });
  });

  it("falls back to the empty-canvas home when existing content carries no positions", () => {
    const context = { nodes: [{ id: "node-0", title: "Untethered" }], links: [], diagramPrimitives: [] };
    expect(existingContent(context)).toBeUndefined();
    expect(center(centerPatchOnCanvas(patch(), context))).toEqual({ x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y });
  });

  it("centers on the existing centroid when the cluster clears existing content", () => {
    // Two distant nodes: the centroid between them is open space wider than the cluster.
    const context = contextWith([{ x: 10_000, y: 8_000 }, { x: 30_000, y: 8_000 }]);
    const placed = centerPatchOnCanvas(patch(), context);
    expect(center(placed)).toEqual({ x: 20_000, y: 8_000 });
  });

  it("places the cluster to the right of existing content when centering would overlap", () => {
    const context = contextWith([{ x: 25_000, y: 25_000 }]);
    const existing = existingContent(context)!.bounds;
    const placed = centerPatchOnCanvas(patch(), context);
    const bounds = patchBounds(placed)!;
    expect(bounds.minX).toBe(existing.maxX + ADJACENT_GAP);
    expect(ADJACENT_GAP).toBe(LAYOUT_GEOMETRY.nodeWidth);
    expect((bounds.minY + bounds.maxY) / 2).toBe(25_000);
    expect(bounds.minX).toBeGreaterThan(existing.maxX);
  });

  it("preserves every relative distance and size under translation", () => {
    const compiled = patch();
    const placed = centerPatchOnCanvas(compiled, contextWith([{ x: 25_000, y: 25_000 }]));
    const at = (value: CanvasIntent["nodes"][number]) => value as { x: number; y: number };
    const offset = { dx: at(placed.nodes[0]).x - at(compiled.nodes[0]).x, dy: at(placed.nodes[0]).y - at(compiled.nodes[0]).y };
    expect(placed.nodes).toEqual(compiled.nodes.map((node) => ({ ...node, x: at(node).x + offset.dx, y: at(node).y + offset.dy })));
    expect(placed.primitives).toEqual(compiled.primitives.map((primitive) => ({
      ...primitive,
      x: (primitive as { x: number }).x + offset.dx,
      y: (primitive as { y: number }).y + offset.dy
    })));
    const compiledSize = patchBounds(compiled)!;
    const placedSize = patchBounds(placed)!;
    expect(placedSize.maxX - placedSize.minX).toBe(compiledSize.maxX - compiledSize.minX);
    expect(placedSize.maxY - placedSize.minY).toBe(compiledSize.maxY - compiledSize.minY);
  });

  it("leaves a patch untouched when it is already where it belongs", () => {
    const placed = centerPatchOnCanvas(patch(), undefined);
    expect(centeringOffset(patchBounds(placed), undefined)).toEqual({ dx: 0, dy: 0 });
    expect(translatePatch(placed, { dx: 0, dy: 0 })).toBe(placed);
    expect(centerPatchOnCanvas(placed, undefined)).toBe(placed);
  });

  it("reads existing bounds from node bounds and diagram primitives alike", () => {
    const context = {
      nodes: [{ id: "node-0", bounds: { x: 0, y: 0, width: 200, height: 100 } }],
      diagramPrimitives: [{ id: "prim-0", kind: "region", x: 500, y: 500, width: 100, height: 100 }]
    };
    expect(existingContent(context)!.bounds).toEqual({ minX: 0, minY: 0, maxX: 550, maxY: 550 });
  });

  it("translates line primitives on both endpoints", () => {
    const compiled = patch({
      primitives: [{ kind: "line", mode: "create", x1: 0, y1: 0, x2: 100, y2: 50 }]
    });
    const placed = translatePatch(compiled, { dx: 10, dy: -5 });
    expect(placed.primitives[0]).toMatchObject({ x1: 10, y1: -5, x2: 110, y2: 45 });
  });

  it("calls an all-create intent pure creation", () => {
    expect(isPureCreation(patch())).toBe(true);
    const withPortal = patch({
      nodes: [{ kind: "portal", mode: "create", title: "Detail", subcanvasRef: "Canvases/Detail.json", x: 0, y: 0 }]
    });
    expect(isPureCreation(withPortal)).toBe(true);
  });

  it("keeps hands off an intent that updates or reuses", () => {
    const withUpdate = patch({
      nodes: [
        { kind: "note", mode: "create", title: "A", x: 0, y: 0 },
        { kind: "note", mode: "update", selector: "B", x: 100, y: 100 }
      ]
    });
    expect(isPureCreation(withUpdate)).toBe(false);
    const withPrimitiveUpdate = patch({
      primitives: [{ kind: "region", mode: "update", id: "6EF21B6B-1F4E-4E4F-AA90-55766D230420", x: 0, y: 0, width: 10, height: 10 }]
    });
    expect(isPureCreation(withPrimitiveUpdate)).toBe(false);
  });

  it("centers a pure-create cluster on the empty-Canvas home point", () => {
    const placed = centerPatchOnCanvas(patch(), undefined);
    const bounds = patchBounds(placed)!;
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(CANVAS_WORLD_HOME.x);
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(CANVAS_WORLD_HOME.y);
  });
});
