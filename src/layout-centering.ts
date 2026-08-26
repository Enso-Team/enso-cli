// Where a compiled canvas patch lands in world space.
// `enso layout` compiles relative geometry around the origin; this post-pass moves the whole
// cluster — nodes and primitives together — to a world position the app is looking at.

import type { CanvasIntent } from "./canvas-intent.js";
import { LAYOUT_GEOMETRY } from "./layout.js";

/**
 * World point the Mac app focuses when a Canvas holds nothing to focus on.
 * Source of truth: `CanvasWorldLayout.home` in Enso/Canvas/CanvasPlacement.swift, built from
 * `contentExtent = 25_000`, and matched by the `emptyFallback` of
 * `CanvasState.primaryContentFocusPoint` in Enso/Models/Data Models/CanvasState.swift.
 */
export const CANVAS_WORLD_HOME = { x: 25_000, y: 25_000 } as const;

/** Gap between existing content and an adjacent new cluster: one node width. */
export const ADJACENT_GAP = LAYOUT_GEOMETRY.nodeWidth;

export type WorldBox = { minX: number; minY: number; maxX: number; maxY: number };
export type WorldOffset = { dx: number; dy: number };

/** Every positioned element on the target Canvas, plus the box that covers them all. */
export type ExistingContent = { boxes: WorldBox[]; bounds: WorldBox };

/**
 * What the target Canvas already holds, read from a `/v1/context` or
 * `/v1/canvases/<selector>/inspect` payload. Undefined when the Canvas is empty or when
 * nothing in it carries a usable position.
 */
export function existingContent(context: unknown): ExistingContent | undefined {
  const data = contextObject(context);
  if (!data) return undefined;
  const boxes = [
    ...readArray(data, "nodes").flatMap(nodeBox),
    ...readArray(data, "diagramPrimitives").flatMap(primitiveBox)
  ];
  const bounds = unionBoxes(boxes);
  return bounds === undefined ? undefined : { boxes, bounds };
}

/**
 * Where the compiled cluster goes, as a deterministic rule:
 *
 * - No existing content: center the cluster on the app's empty-Canvas home point.
 * - Existing content the cluster can sit among: center the cluster on the centroid of the
 *   existing bounding box. "Can sit among" means the centered cluster keeps at least one
 *   node width of clearance from every existing element.
 * - Otherwise: place the cluster to the right of the existing bounding box with one node
 *   width of gap, vertically centered on that same centroid.
 */
export function centeringOffset(cluster: WorldBox | undefined, existing: ExistingContent | undefined): WorldOffset {
  if (!cluster) return { dx: 0, dy: 0 };
  const center = boxCenter(cluster);
  if (!existing) return { dx: CANVAS_WORLD_HOME.x - center.x, dy: CANVAS_WORLD_HOME.y - center.y };
  const centroid = boxCenter(existing.bounds);
  const onCentroid = { dx: centroid.x - center.x, dy: centroid.y - center.y };
  const centered = translateBox(cluster, onCentroid);
  if (existing.boxes.every((occupied) => !overlaps(centered, inflate(occupied, ADJACENT_GAP)))) return onCentroid;
  return { dx: existing.bounds.maxX + ADJACENT_GAP - cluster.minX, dy: onCentroid.dy };
}

/** Bounding box of a compiled patch, node boxes and primitive boxes together. */
export function patchBounds(patch: CanvasIntent): WorldBox | undefined {
  const nodes = patch.nodes.flatMap((node) => {
    const [x, y] = [coordinate(node, "x"), coordinate(node, "y")];
    return x === undefined || y === undefined ? [] : [box(x, y, LAYOUT_GEOMETRY.nodeWidth, LAYOUT_GEOMETRY.nodeHeight)];
  });
  const primitives = patch.primitives.flatMap((primitive) => primitiveBox(primitive as Record<string, unknown>));
  return unionBoxes([...nodes, ...primitives]);
}

/**
 * Move every world coordinate in a compiled patch by the same offset. Sizes, and so every
 * relative distance in the layout, are untouched.
 */
export function translatePatch(patch: CanvasIntent, offset: WorldOffset): CanvasIntent {
  if (offset.dx === 0 && offset.dy === 0) return patch;
  return {
    ...patch,
    nodes: patch.nodes.map((node) => shiftCoordinates(node, offset)),
    primitives: patch.primitives.map((primitive) => shiftCoordinates(primitive, offset))
  };
}

const COORDINATE_KEYS = { x: "dx", y: "dy", x1: "dx", y1: "dy", x2: "dx", y2: "dy" } as const;

function shiftCoordinates<T>(value: T, offset: WorldOffset): T {
  const record = value as Record<string, unknown>;
  const shifted: Record<string, unknown> = { ...record };
  for (const [key, axis] of Object.entries(COORDINATE_KEYS)) {
    const current = record[key];
    if (finiteNumber(current)) shifted[key] = current + offset[axis];
  }
  return shifted as T;
}

/** Compiled patch, moved to where the target Canvas wants it. */
export function centerPatchOnCanvas(patch: CanvasIntent, context: unknown): CanvasIntent {
  return translatePatch(patch, centeringOffset(patchBounds(patch), existingContent(context)));
}

function coordinate(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const current = (value as Record<string, unknown>)[key];
  return finiteNumber(current) ? current : undefined;
}

function contextObject(context: unknown): Record<string, unknown> | undefined {
  if (!context || typeof context !== "object") return undefined;
  const data = context as Record<string, unknown>;
  if (Array.isArray(data.nodes) || Array.isArray(data.diagramPrimitives)) return data;
  return data.context && typeof data.context === "object" ? contextObject(data.context) : data;
}

function readArray(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = data[key];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
}

function nodeBox(node: Record<string, unknown>): WorldBox[] {
  const bounds = boundsBox(node.bounds);
  if (bounds) return [bounds];
  const position = node.position;
  if (!position || typeof position !== "object") return [];
  const { x, y } = position as { x?: unknown; y?: unknown };
  if (!finiteNumber(x) || !finiteNumber(y)) return [];
  return [box(x, y, LAYOUT_GEOMETRY.nodeWidth, LAYOUT_GEOMETRY.nodeHeight)];
}

function primitiveBox(primitive: Record<string, unknown>): WorldBox[] {
  const bounds = boundsBox(primitive.bounds);
  if (bounds) return [bounds];
  const { x, y, width, height, x1, y1, x2, y2 } = primitive as Record<string, unknown>;
  if (finiteNumber(x1) && finiteNumber(y1) && finiteNumber(x2) && finiteNumber(y2)) return [pointsBox(x1, y1, x2, y2)];
  if (finiteNumber(x) && finiteNumber(y)) return [box(x, y, finiteNumber(width) ? width : 0, finiteNumber(height) ? height : 0)];
  return [];
}

function boundsBox(value: unknown): WorldBox | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(width) || !finiteNumber(height)) return undefined;
  // App bounds are an origin plus a size, not a center plus a size.
  return { minX: x, minY: y, maxX: x + width, maxY: y + height };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function box(centerX: number, centerY: number, width: number, height: number): WorldBox {
  return { minX: centerX - width / 2, minY: centerY - height / 2, maxX: centerX + width / 2, maxY: centerY + height / 2 };
}

function pointsBox(x1: number, y1: number, x2: number, y2: number): WorldBox {
  return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

function unionBoxes(boxes: WorldBox[]): WorldBox | undefined {
  if (boxes.length === 0) return undefined;
  return boxes.reduce((union, current) => ({
    minX: Math.min(union.minX, current.minX),
    minY: Math.min(union.minY, current.minY),
    maxX: Math.max(union.maxX, current.maxX),
    maxY: Math.max(union.maxY, current.maxY)
  }));
}

function boxCenter(value: WorldBox): { x: number; y: number } {
  return { x: (value.minX + value.maxX) / 2, y: (value.minY + value.maxY) / 2 };
}

function translateBox(value: WorldBox, offset: WorldOffset): WorldBox {
  return { minX: value.minX + offset.dx, minY: value.minY + offset.dy, maxX: value.maxX + offset.dx, maxY: value.maxY + offset.dy };
}

function inflate(value: WorldBox, margin: number): WorldBox {
  return { minX: value.minX - margin, minY: value.minY - margin, maxX: value.maxX + margin, maxY: value.maxY + margin };
}

function overlaps(a: WorldBox, b: WorldBox): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}
