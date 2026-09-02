// Re-layout. `enso layout --apply` on a Canvas that already holds spec members converges
// the Canvas to the spec: matched members move, new ones are created, unchanged ones emit
// nothing, and regions and links update in place. The compiled geometry stays what it is;
// this pass only decides which operation carries each element there.

import type { CanvasIntent } from "./canvas-intent.js";
import { EnsoCliError } from "./errors.js";
import { centeringOffset, existingContent, patchBounds, translatePatch, type WorldOffset } from "./layout-centering.js";

export type ReconcileOptions = { prune: boolean };

export type ReconcileSummary = {
  anchor: "existing-members" | "empty-canvas" | "beside-content";
  nodes: { created: number; placed: number; moved: number; unchanged: number; removed: number };
  links: { created: number; updated: number; unchanged: number; removed: number };
  regions: { created: number; updated: number; unchanged: number; removed: number };
};

export type Reconciliation = { patch: CanvasIntent; summary: ReconcileSummary };

type ContextNode = { id?: string; kind?: string; title?: string; displayTitle?: string; ref?: string; position?: { x?: number; y?: number } };
type ContextLink = { id?: string; sourceNodeID?: string; targetNodeID?: string; label?: string | null; color?: string | null; direction?: string };
type ContextPrimitive = { id?: string; kind?: string; title?: string | null; color?: string | null; x?: number; y?: number; width?: number; height?: number };

type CompiledNode = CanvasIntent["nodes"][number];
type CompiledLink = CanvasIntent["links"][number];
type CompiledRegion = CanvasIntent["primitives"][number];

/** Coordinates closer than this are the same place. The app stores points, not pixels. */
const SAME_PLACE = 0.5;
const REGION_KINDS = new Set(["group", "region"]);

/**
 * Turn a compiled layout into the smallest patch that makes the target Canvas match it.
 *
 * Placement is anchored so a re-run never drags a diagram across the Canvas: when the
 * Canvas holds spec members, the compiled cluster's centroid over those members lands on
 * their current centroid. An empty Canvas, or one holding none of the members, places the
 * cluster the way a first layout does.
 */
export function reconcileLayout(compiled: CanvasIntent, context: unknown, options: ReconcileOptions): Reconciliation {
  const nodes = readArray<ContextNode>(context, "nodes").filter((node) => node.kind !== "portal");
  const links = readArray<ContextLink>(context, "links");
  const primitives = readArray<ContextPrimitive>(context, "diagramPrimitives");

  const matched = new Map<string, ContextNode>();
  for (const node of compiled.nodes) {
    const existing = matchNode(nodes, memberTitle(node));
    if (existing) matched.set(memberTitle(node), existing);
  }

  const { offset, anchor } = placement(compiled, matched, context);
  const placed = translatePatch(compiled, offset);
  const summary: ReconcileSummary = {
    anchor,
    nodes: { created: 0, placed: 0, moved: 0, unchanged: 0, removed: 0 },
    links: { created: 0, updated: 0, unchanged: 0, removed: 0 },
    regions: { created: 0, updated: 0, unchanged: 0, removed: 0 }
  };

  const outNodes: CanvasIntent["nodes"] = [];
  for (const node of placed.nodes) {
    const existing = matched.get(memberTitle(node));
    if (!existing) {
      outNodes.push(node);
      if (node.mode === "reuse") summary.nodes.placed += 1;
      else summary.nodes.created += 1;
      continue;
    }
    const target = coordinates(node);
    if (!target) continue;
    if (samePlace(existing.position, target)) {
      summary.nodes.unchanged += 1;
      continue;
    }
    outNodes.push({ kind: "note", mode: "update", selector: existing.id ?? memberTitle(node), x: target.x, y: target.y });
    summary.nodes.moved += 1;
  }

  const memberIds = new Map<string, string>();
  for (const [title, existing] of matched) if (existing.id) memberIds.set(title, existing.id);

  const outLinks: CanvasIntent["links"] = [];
  const keptLinkIds = new Set<string>();
  for (const link of placed.links) {
    if (link.mode !== "create") {
      outLinks.push(link);
      continue;
    }
    const source = memberIds.get(link.source);
    const target = memberIds.get(link.target);
    const existing = source && target
      ? links.find((candidate) => unorderedPair(candidate.sourceNodeID, candidate.targetNodeID) === unorderedPair(source, target))
      : undefined;
    if (!existing?.id) {
      outLinks.push(link);
      summary.links.created += 1;
      continue;
    }
    keptLinkIds.add(existing.id);
    const changes = linkChanges(link, existing);
    if (Object.keys(changes).length === 0) {
      summary.links.unchanged += 1;
      continue;
    }
    outLinks.push({ mode: "update", id: existing.id, ...changes });
    summary.links.updated += 1;
  }

  const regions = primitives.filter((primitive) => REGION_KINDS.has(primitive.kind ?? ""));
  const outPrimitives: CanvasIntent["primitives"] = [];
  const keptRegionIds = new Set<string>();
  for (const region of placed.primitives) {
    if (region.mode !== "create" || region.kind !== "region") {
      outPrimitives.push(region);
      continue;
    }
    const existing = matchRegion(regions, region.title ?? null);
    if (!existing?.id) {
      outPrimitives.push(region);
      summary.regions.created += 1;
      continue;
    }
    keptRegionIds.add(existing.id);
    const changes = regionChanges(region, existing);
    if (Object.keys(changes).length === 0) {
      summary.regions.unchanged += 1;
      continue;
    }
    outPrimitives.push({ kind: "region", mode: "update", id: existing.id, ...changes });
    summary.regions.updated += 1;
  }

  if (options.prune) {
    const memberNodeIds = new Set(memberIds.values());
    const canvasNodeIds = new Set(nodes.flatMap((node) => node.id ? [node.id] : []));
    for (const node of nodes) {
      if (!node.id || memberNodeIds.has(node.id)) continue;
      outNodes.push({ kind: "note", mode: "remove", selector: node.id });
      summary.nodes.removed += 1;
    }
    for (const link of links) {
      if (!link.id || keptLinkIds.has(link.id)) continue;
      // A Link whose end is being pruned leaves with its Node. Naming it twice would fail.
      const leavesWithNode = [link.sourceNodeID, link.targetNodeID].some((end) => end !== undefined && canvasNodeIds.has(end) && !memberNodeIds.has(end));
      if (leavesWithNode) continue;
      outLinks.push({ mode: "remove", id: link.id, fromNote: false });
      summary.links.removed += 1;
    }
    for (const region of regions) {
      if (!region.id || keptRegionIds.has(region.id)) continue;
      outPrimitives.push({ kind: "region", mode: "remove", id: region.id });
      summary.regions.removed += 1;
    }
  }

  return { patch: { ...placed, nodes: outNodes, links: outLinks, primitives: outPrimitives }, summary };
}

function placement(compiled: CanvasIntent, matched: Map<string, ContextNode>, context: unknown): { offset: WorldOffset; anchor: ReconcileSummary["anchor"] } {
  const pairs = compiled.nodes.flatMap((node) => {
    const existing = matched.get(memberTitle(node));
    const target = coordinates(node);
    const current = existing?.position;
    return existing && target && typeof current?.x === "number" && typeof current?.y === "number"
      ? [{ target, current: { x: current.x, y: current.y } }]
      : [];
  });
  if (pairs.length > 0) {
    const compiledCentroid = centroid(pairs.map((pair) => pair.target));
    const existingCentroid = centroid(pairs.map((pair) => pair.current));
    return { offset: { dx: existingCentroid.x - compiledCentroid.x, dy: existingCentroid.y - compiledCentroid.y }, anchor: "existing-members" };
  }
  const existing = existingContent(context);
  return { offset: centeringOffset(patchBounds(compiled), existing), anchor: existing ? "beside-content" : "empty-canvas" };
}

function memberTitle(node: CompiledNode): string {
  return node.mode === "create" ? node.title : node.selector;
}

function coordinates(node: CompiledNode): { x: number; y: number } | undefined {
  const record = node as { x?: unknown; y?: unknown };
  return typeof record.x === "number" && typeof record.y === "number" ? { x: record.x, y: record.y } : undefined;
}

function samePlace(position: ContextNode["position"], target: { x: number; y: number }): boolean {
  return typeof position?.x === "number" && typeof position?.y === "number"
    && Math.abs(position.x - target.x) < SAME_PLACE && Math.abs(position.y - target.y) < SAME_PLACE;
}

/** The Node this member already has on the Canvas, matched the way every selector matches. */
function matchNode(nodes: ContextNode[], title: string): ContextNode | undefined {
  const found = nodes.filter((node) => [node.title, node.displayTitle, node.ref, refStem(node.ref)].includes(title));
  if (found.length > 1) {
    throw new EnsoCliError("ambiguous_selector", `Multiple Nodes on the Canvas match '${title}'`, {
      path: `members.${title}`,
      expected: "one Node per member title",
      hint: "Rename or remove the duplicate Node before re-running layout"
    });
  }
  return found[0];
}

function matchRegion(regions: ContextPrimitive[], title: string | null): ContextPrimitive | undefined {
  if (title === null) return undefined;
  const found = regions.filter((region) => region.title === title);
  if (found.length > 1) {
    throw new EnsoCliError("ambiguous_selector", `Multiple regions on the Canvas are titled '${title}'`, {
      path: `clusters.${title}`,
      expected: "one region per cluster name",
      hint: "Rename or remove the duplicate region before re-running layout"
    });
  }
  return found[0];
}

function refStem(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.split("/").pop()?.replace(/\.md$/i, "");
}

/** Only fields the spec declares take part: an edge without a label leaves the label alone. */
function linkChanges(link: Extract<CompiledLink, { mode: "create" }>, existing: ContextLink): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (link.label !== undefined && (existing.label ?? undefined) !== link.label) changes.label = link.label;
  if (link.color !== undefined && (existing.color ?? undefined) !== link.color) changes.color = link.color;
  if (link.direction !== undefined && existing.direction !== link.direction) changes.direction = link.direction;
  return changes;
}

function regionChanges(region: Extract<CompiledRegion, { mode: "create" }>, existing: ContextPrimitive): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const wanted = region as { x?: number; y?: number; width?: number; height?: number; color?: string | null };
  for (const key of ["x", "y", "width", "height"] as const) {
    const value = wanted[key];
    if (typeof value !== "number") continue;
    const current = existing[key];
    if (typeof current !== "number" || Math.abs(current - value) >= SAME_PLACE) changes[key] = value;
  }
  if (typeof wanted.color === "string" && (existing.color ?? undefined) !== wanted.color) changes.color = wanted.color;
  return changes;
}

function centroid(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function unorderedPair(a?: string, b?: string): string {
  return [a ?? "", b ?? ""].sort().join(" ");
}

function readArray<T>(context: unknown, key: string): T[] {
  if (!context || typeof context !== "object") return [];
  const value = (context as Record<string, unknown>)[key];
  return Array.isArray(value) ? value as T[] : [];
}
