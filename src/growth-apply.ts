// Fills in the positions an intent leaves out, so an agent adds one Node at a time and the
// Canvas grows. The CLI keeps the growth on disk: the Nodes this agent placed on this Canvas,
// each with its spot in the growth layout, and the Regions it drew or grew. Nodes from before
// the growth never move.

import { canvasSpecFromObject } from "./canvas-spec.js";
import type { CanvasIntent } from "./canvas-intent.js";
import { EnsoCliError } from "./errors.js";
import { GrowthBlocked, growLayout, type GrowthEdge, type GrowthNode, type GrowthSpot } from "./growth-layout.js";
import { CANVAS_WORLD_HOME, centeringOffset, contextNodeBox, contextObject, existingContent, readArray } from "./layout-centering.js";
import { ANNOTATION_GEOMETRY, CARD_GEOMETRY, SYMBOL_GEOMETRY, computeCanvasLayout, isSymbolAppearance, linkCrossings } from "./layout.js";
import { markWorldBox } from "./mark-model.js";
import { noteMatches } from "./note-identity.js";
import { boundsBox, centeredBox as centered, inflate, overlaps, sameBox, unionBoxes as union, type WorldBox } from "./world-box.js";

/** A growth ends after this long without a write. */
export const GROWTH_QUIET_MS = 120_000;
const MOVE_TOLERANCE = 0.5;

export type Direction = "TB" | "LR";
export type GrowthMember = GrowthSpot & { note: string; fixed: boolean; x: number; y: number; region?: string };
/** A Region the growth wrote, with the box it last wrote. `drawn` Regions began in this growth and may shrink. */
export type GrowthRegion = { title: string; drawn: boolean; box: WorldBox };
export type Growth = {
  canvasID: string;
  startedAt: number;
  lastWriteAt: number;
  direction: Direction;
  symbols: boolean;
  anchor: Point;
  nodes: GrowthMember[];
  regions: GrowthRegion[];
};
export type GrowthEnd = "quiet" | "moved" | "canvas" | "tidy";
export type GrowthReport = {
  status: "started" | "continued" | "ended";
  endedBecause?: GrowthEnd;
  placed: string[];
  moved: string[];
  regions: { drawn: string[]; resized: string[]; removed: string[] };
  tidy?: { applied: boolean; crossingsBefore: number; crossingsAfter: number };
};
export type GrowthPlan = { intent: CanvasIntent; growth: Growth | undefined; report?: GrowthReport };

type Point = { x: number; y: number };
type Item = Record<string, unknown>;
type Geometry = typeof CARD_GEOMETRY | typeof SYMBOL_GEOMETRY;
/** `touched` Regions are the ones this write declares, adds members to, removes members from, or moves members of. Only they are written. */
type Region = { title: string; id?: string; color?: string | null; base?: WorldBox; drawn: boolean; declared: boolean; touched: boolean; members: Set<string> };

/**
 * The room a Link label of about five words takes at the app's 14pt label size: one line of
 * text, with a margin that keeps it off the Nodes at both ends.
 */
export const LINK_LABEL_ROOM = { width: 200, height: 22, margin: 24 } as const;

/**
 * World distance between neighboring ranks and slots. A rank step holds a Node plus the room
 * a Link label needs along the flow, and never less than two Region paddings plus a margin,
 * so members of neighboring Regions stay in their rank. Slots keep the density's step, and the
 * half-step search opens the same Region clearance across ranks.
 */
export function growthSteps(geometry: Geometry, direction: Direction): { rank: number; slot: number } {
  const label = (direction === "TB" ? LINK_LABEL_ROOM.height : LINK_LABEL_ROOM.width) + 2 * LINK_LABEL_ROOM.margin;
  const region = 2.5 * geometry.clusterPadding;
  const size = direction === "TB" ? geometry.nodeHeight : geometry.nodeWidth;
  return { rank: size + Math.max(label, region), slot: direction === "TB" ? geometry.colStep : geometry.rowStep };
}

const OLDER = "older:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether this intent changes the graph, which is when a running growth continues. */
export function changesGraph(intent: CanvasIntent): boolean {
  return Boolean(intent.tidy)
    || intent.regions.length > 0
    || intent.nodes.some((node) => node.mode === "place" || node.mode === "remove")
    || intent.links.some((link) => link.mode === "create" || link.mode === "remove");
}

export function planGrowth(intent: CanvasIntent, context: unknown, previous: Growth | undefined, canvasID: string, now: number): GrowthPlan {
  const canvas = readCanvas(context);
  const { growth: continued, ended } = continueGrowth(previous, canvas, canvasID, now);
  const grows = Boolean(intent.tidy)
    || intent.regions.length > 0
    || intent.nodes.some((node) => node.kind === "note" && node.mode === "place" && ((node.x === undefined && canvas.find(node.note) === undefined) || node.in !== undefined))
    || (continued !== undefined && changesGraph(intent));
  if (!grows) {
    const filled = placeAnnotations(intent, canvas, continued?.direction ?? intent.direction ?? "TB", continued);
    return { intent: filled, growth: continued && { ...continued, lastWriteAt: now } };
  }

  const direction = continued?.direction ?? intent.direction ?? "TB";
  const placing = intent.nodes.flatMap((node) => node.kind === "note" && node.mode === "place" ? [node] : []);
  const symbols = continued?.symbols ?? (placing.length > 0 && placing.every((node) => isSymbolAppearance(node.appearance)));
  const geometry = symbols ? SYMBOL_GEOMETRY : CARD_GEOMETRY;
  const padding = geometry.clusterPadding;
  const members = (continued?.nodes ?? []).filter((node) => !removes(intent, node.note, canvas));
  const inGrowth = (selector: string): GrowthMember | undefined => members.find((node) => sameNote(node.note, selector, canvas));
  const fresh = placing.filter((node) => !inGrowth(node.note) && canvas.find(node.note) === undefined);
  const tracked = (selector: string): string | undefined => inGrowth(selector)?.note ?? fresh.find((node) => sameNote(node.note, selector, canvas))?.note;
  const edges = graphEdges(intent, canvas, tracked);
  const older = (key: string): Item | undefined => key.startsWith(OLDER) ? canvas.nodes.find((node) => node.id === key.slice(OLDER.length)) : undefined;
  const regions = collectRegions(intent, canvas, continued, members, fresh);
  const regionOf = (key: string): Region | undefined => [...regions.values()].find((region) => region.members.has(key));

  const anchor = continued?.anchor ?? startingAnchor(fresh, edges, older, regions, context, geometry);
  const steps = growthSteps(geometry, direction);
  const toWorld = (spot: GrowthSpot): Point => direction === "TB"
    ? { x: anchor.x + spot.slot * steps.slot, y: anchor.y + spot.rank * steps.rank }
    : { x: anchor.x + spot.rank * steps.rank, y: anchor.y + spot.slot * steps.slot };
  const toSpot = (point: Point): GrowthSpot => direction === "TB"
    ? { rank: (point.y - anchor.y) / steps.rank, slot: (point.x - anchor.x) / steps.slot }
    : { rank: (point.x - anchor.x) / steps.rank, slot: (point.y - anchor.y) / steps.slot };

  const previousSpots = new Map<string, GrowthNode>(members.map((node) => [node.note, { rank: node.rank, slot: node.slot, fixed: node.fixed }]));
  const olderKeys = [
    ...edges.flatMap(({ from, to }) => [from, to]),
    ...[...regions.values()].flatMap((region) => [...region.members])
  ];
  for (const key of olderKeys) {
    const node = older(key);
    const point = node && position(node);
    if (point && !previousSpots.has(key)) previousSpots.set(key, { ...toSpot(point), fixed: true });
  }
  const added = fresh.map((node, index) => {
    if (node.x !== undefined && node.y !== undefined) return { key: node.note, fixed: toSpot({ x: node.x, y: node.y }) };
    const peers = [...(regionOf(node.note)?.members ?? [])].filter((key) => key !== node.note);
    const linked = edges.some((edge) => (edge.from === node.note || edge.to === node.note) && previousSpots.has(edge.from === node.note ? edge.to : edge.from));
    const first = members.length === 0 && index === 0 && !linked && !peers.some((key) => previousSpots.has(key));
    return first ? { key: node.note, fixed: { rank: 0, slot: 0 } } : { key: node.note, peers };
  });

  const statics = staticNodes(canvas, (node) => members.some((own) => noteMatches(identity(node), own.note)) || removes(intent, String(node.id ?? ""), canvas));
  const annotations = [...canvas.excerpts.flatMap(textBox), ...canvas.marks.filter((mark) => mark.kind !== "strokes").flatMap(textBox)];
  const nodeBox = (point: Point): WorldBox => centered(point, geometry.nodeWidth, geometry.nodeHeight);
  const lanes = annotationLanes(intent, canvas, tracked, direction, geometry);
  const regionBox = (region: Region, placed: ReadonlyMap<string, GrowthNode>, candidate?: { key: string; spot: GrowthSpot }): WorldBox | undefined => {
    const boxes = [...region.members].flatMap((key) => {
      const spot = candidate?.key === key ? candidate.spot : placed.get(key);
      const node = older(key);
      const point = spot ? toWorld(spot) : node && position(node);
      const box = spot ? nodeBox(toWorld(spot)) : node && contextNodeBox(node);
      if (!box || !point) return [];
      return [box, ...lanes.planned(key, point), ...lanes.shown(key)].map((item) => inflate(item, padding));
    });
    return union([...(region.drawn || !region.base ? [] : [region.base]), ...boxes]);
  };
  const staticLanes = statics.flatMap((item) => lanes.planned(item.key, { x: (item.box.minX + item.box.maxX) / 2, y: (item.box.minY + item.box.maxY) / 2 }));
  const taken = (spot: GrowthSpot, key: string, placed: ReadonlyMap<string, GrowthNode>): boolean => {
    const point = toWorld(spot);
    const box = nodeBox(point);
    const lane = lanes.planned(key, point);
    const placedOthers = [...placed].filter(([other]) => other !== key);
    const occupied = [
      ...statics.filter((item) => item.key !== key).map((item) => item.box),
      ...placedOthers.map(([, other]) => nodeBox(toWorld(other)))
    ];
    if (statics.some((item) => item.key !== key && overlaps(box, item.box)) || annotations.some((other) => overlaps(box, other))) return true;
    if (lane.some((item) => occupied.some((other) => overlaps(item, other)))) return true;
    const otherLanes = [...staticLanes, ...placedOthers.flatMap(([other, at]) => lanes.planned(other, toWorld(at)))];
    if (otherLanes.some((other) => overlaps(box, other))) return true;
    const own = regionOf(key);
    const others = [...regions.values()].filter((region) => region !== own).flatMap((region) => regionBox(region, placed) ?? []);
    if (!own) return others.some((other) => overlaps(inflate(box, 2 * padding), other) || lane.some((item) => overlaps(item, other)));
    const grownBox = regionBox(own, placed, { key, spot })!;
    if (others.some((other) => overlaps(inflate(grownBox, padding / 2), other))) return true;
    const outsiders = [
      ...statics.filter((item) => !own.members.has(item.key)).map((item) => item.box),
      ...placedOthers.filter(([other]) => !own.members.has(other)).map(([, other]) => nodeBox(toWorld(other)))
    ];
    return outsiders.some((other) => overlaps(grownBox, other));
  };
  const intentEdges = graphEdges(intent, canvas, tracked, true);
  let grown: Map<string, GrowthNode>;
  try {
    grown = growLayout(previousSpots, added, edges, intentEdges, taken);
  } catch (error) {
    if (!(error instanceof GrowthBlocked)) throw error;
    const region = regionOf(error.key);
    throw new EnsoCliError("region_blocked", region ? `Region '${region.title}' has no room for '${error.key}'` : `No free spot for '${error.key}'`, {
      path: "nodes", expected: "a spot that covers no Node outside the Region",
      hint: region ? "Make the Region bigger, move what blocks it, or place the Node in another Region" : "Give the Node x and y"
    });
  }

  const placed: string[] = [];
  const moved: string[] = [];
  const nextMembers: GrowthMember[] = [];
  const nodes: CanvasIntent["nodes"] = intent.nodes.map((node) => {
    if (node.kind !== "note" || node.mode !== "place") return node;
    const { in: _in, ...plain } = node;
    if (!fresh.includes(node)) return plain;
    const spot = grown.get(node.note)!;
    const point = node.x !== undefined && node.y !== undefined ? { x: node.x, y: node.y } : toWorld(spot);
    placed.push(node.note);
    const region = regionOf(node.note)?.title;
    nextMembers.push({ note: node.note, ...spot, fixed: node.x !== undefined || spot.fixed, ...point, ...(region ? { region } : {}) });
    return { ...plain, ...point };
  });
  for (const node of members) {
    const spot = grown.get(node.note)!;
    const point = toWorld(spot);
    if (Math.abs(point.x - node.x) > MOVE_TOLERANCE || Math.abs(point.y - node.y) > MOVE_TOLERANCE) {
      if (!intent.nodes.some((item) => "selector" in item && sameNote(node.note, item.selector, canvas))) {
        nodes.push({ kind: "note", mode: "update", selector: node.note, x: point.x, y: point.y });
        moved.push(node.note);
      }
      nextMembers.push({ ...node, ...spot, ...point });
    } else {
      nextMembers.push({ ...node, ...spot });
    }
  }

  const growth: Growth = {
    canvasID, startedAt: continued?.startedAt ?? now, lastWriteAt: now, direction, symbols, anchor, nodes: nextMembers, regions: []
  };
  let tidy: GrowthReport["tidy"];
  if (intent.tidy) {
    const result = tidyGrowth(growth, edges, canvas, regions);
    tidy = result.report;
    for (const [note, point] of result.moves) {
      const existing = nodes.findIndex((node) => (node.mode === "place" && node.note === note) || ("selector" in node && node.selector === note));
      if (existing >= 0) nodes[existing] = { ...nodes[existing], ...point } as CanvasIntent["nodes"][number];
      else nodes.push({ kind: "note", mode: "update", selector: note, ...point });
      if (!moved.includes(note) && !placed.includes(note)) moved.push(note);
      growth.nodes = growth.nodes.map((node) => node.note === note ? { ...node, ...point } : node);
    }
  }

  for (const region of regions.values()) if (moved.some((note) => region.members.has(note))) region.touched = true;
  const finalSpots = new Map(growth.nodes.map((node) => [node.note, { ...toSpot(node), fixed: node.fixed }]));
  const { primitives, written, report: regionReport } = regionWrites(intent, regions, (region) => regionBox(region, finalSpots), geometry.clusterFillOpacity, continued?.regions ?? []);
  growth.regions = written;
  const filled = placeAnnotations({ ...intent, nodes, primitives: [...intent.primitives, ...primitives], regions: [] }, canvas, direction, growth);
  const report: GrowthReport = {
    status: intent.tidy ? "ended" : continued ? "continued" : "started",
    ...(intent.tidy ? { endedBecause: "tidy" as const } : ended && !continued ? { endedBecause: ended } : {}),
    placed,
    moved,
    regions: regionReport,
    ...(tidy ? { tidy } : {})
  };
  return { intent: filled, growth: intent.tidy ? undefined : growth, report };
}

type Canvas = {
  nodes: Item[];
  links: Item[];
  excerpts: Item[];
  marks: Item[];
  groups: Item[];
  find: (selector: string) => Item | undefined;
};

function readCanvas(context: unknown): Canvas {
  const data = contextObject(context) ?? {};
  const nodes = readArray(data, "nodes");
  return {
    nodes,
    links: readArray(data, "links"),
    excerpts: readArray(data, "excerpts"),
    marks: readArray(data, "marks"),
    groups: readArray(data, "diagramPrimitives").filter((primitive) => primitive.kind === "group"),
    find: (selector) => {
      const found = nodes.filter((node) => noteMatches(identity(node), selector));
      return found.length === 1 ? found[0] : undefined;
    }
  };
}

function identity(node: Item): { id?: string; title?: string; displayTitle?: string; ref?: string } {
  const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
  return { id: text(node.id), title: text(node.title), displayTitle: text(node.displayTitle), ref: text(node.ref) };
}

/** Two selectors name the same Note when they match the same Node on the Canvas, or each other's file. */
function sameNote(a: string, b: string, canvas: Canvas): boolean {
  if (noteMatches({ ref: a }, b) || noteMatches({ ref: b }, a)) return true;
  const node = canvas.find(a);
  return node !== undefined && noteMatches(identity(node), b);
}

function removes(intent: CanvasIntent, note: string, canvas: Canvas): boolean {
  return intent.nodes.some((node) => node.mode === "remove" && sameNote(note, node.selector, canvas));
}

/**
 * The growth continues on the same Canvas while writes keep coming and nobody moves its Nodes
 * or reshapes its Regions. A Node or Region the Canvas no longer holds leaves the growth.
 */
function continueGrowth(previous: Growth | undefined, canvas: Canvas, canvasID: string, now: number): { growth?: Growth; ended?: GrowthEnd } {
  if (!previous) return {};
  if (previous.canvasID !== canvasID) return { ended: "canvas" };
  if (now - previous.lastWriteAt > GROWTH_QUIET_MS) return { ended: "quiet" };
  const nodes: GrowthMember[] = [];
  for (const node of previous.nodes) {
    const found = canvas.find(node.note);
    if (!found) continue;
    const point = position(found);
    if (point && (Math.abs(point.x - node.x) > MOVE_TOLERANCE || Math.abs(point.y - node.y) > MOVE_TOLERANCE)) return { ended: "moved" };
    nodes.push(node);
  }
  const regions: GrowthRegion[] = [];
  for (const region of previous.regions ?? []) {
    const found = canvas.groups.filter((group) => group.title === region.title);
    if (found.length !== 1) continue;
    const box = boundsBox(found[0].bounds);
    if (box && !sameBox(box, region.box)) return { ended: "moved" };
    regions.push(region);
  }
  return { growth: { ...previous, nodes, regions } };
}

/**
 * Every Region this write touches: those the intent declares or places a Node in, those the
 * growth drew, and every other Region on the Canvas so new Nodes stay clear of it. A Region's
 * members are the growth Nodes placed in it plus every Node whose box overlaps its box, since
 * membership is spatial.
 */
function collectRegions(intent: CanvasIntent, canvas: Canvas, growth: Growth | undefined, members: GrowthMember[], fresh: Array<{ note: string; in?: string }>): Map<string, Region> {
  const regions = new Map<string, Region>();
  const fromGroup = (group: Item): Region => {
    const title = typeof group.title === "string" ? group.title : "";
    const key = typeof group.id === "string" ? group.id : title;
    const existing = regions.get(key);
    if (existing) return existing;
    const drawn = growth?.regions.some((region) => region.drawn && region.title === title) ?? false;
    const region: Region = { title, id: typeof group.id === "string" ? group.id : undefined, base: boundsBox(group.bounds), drawn, declared: false, touched: false, members: new Set() };
    regions.set(key, region);
    return region;
  };
  for (const group of canvas.groups) fromGroup(group);
  const resolve = (selector: string): Region => {
    const byId = canvas.groups.filter((group) => typeof group.id === "string" && group.id.toLowerCase() === selector.toLowerCase());
    const found = byId.length > 0 ? byId : canvas.groups.filter((group) => group.title === selector);
    if (found.length > 1) {
      throw new EnsoCliError("ambiguous_selector", `${found.length} Regions are titled '${selector}'`, {
        path: "regions", regions: found.map((group) => group.id), expected: "one Region", hint: "Name the Region by its id"
      });
    }
    if (found.length === 1) return fromGroup(found[0]);
    const pending = regions.get(selector);
    if (pending) return pending;
    if (UUID.test(selector)) {
      throw new EnsoCliError("missing_selector", `No Region has the id '${selector}'`, { path: "regions", expected: "a Region title or id", hint: "Inspect the Canvas and use a Region's id, or name a new Region by title" });
    }
    const region: Region = { title: selector, drawn: true, declared: false, touched: false, members: new Set() };
    regions.set(selector, region);
    return region;
  };
  for (const declared of intent.regions) {
    const region = resolve(declared.title);
    region.declared = true;
    region.touched = true;
    if (declared.color !== undefined) region.color = declared.color;
  }
  for (const node of fresh) {
    if (node.in === undefined) continue;
    const region = resolve(node.in);
    region.members.add(node.note);
    region.touched = true;
  }
  for (const node of growth?.nodes ?? []) {
    if (node.region === undefined || !removes(intent, node.note, canvas)) continue;
    const region = [...regions.values()].find((candidate) => candidate.title === node.region);
    if (region) region.touched = true;
  }
  for (const member of members) {
    if (member.region === undefined) continue;
    [...regions.values()].find((candidate) => candidate.title === member.region)?.members.add(member.note);
  }
  for (const region of regions.values()) {
    if (!region.base || region.drawn) continue;
    for (const node of canvas.nodes) {
      const box = contextNodeBox(node);
      if (!box || !overlaps(box, region.base) || typeof node.id !== "string") continue;
      if (removes(intent, node.id, canvas)) {
        region.touched = true;
        continue;
      }
      const own = members.find((member) => noteMatches(identity(node), member.note));
      region.members.add(own ? own.note : OLDER + node.id);
    }
  }
  return regions;
}

/**
 * The Region writes that follow the Nodes, for the Regions this write touches. A Region it
 * leaves alone keeps its box and its record. A new Region is created around its members, a
 * Region whose box changed is updated in place, and a Region this growth drew with no members
 * left is removed. A Region that began before the growth only ever grows.
 */
function regionWrites(intent: CanvasIntent, regions: Map<string, Region>, boxOf: (region: Region) => WorldBox | undefined, fillOpacity: number, recorded: GrowthRegion[]): {
  primitives: CanvasIntent["primitives"]; written: GrowthRegion[]; report: GrowthReport["regions"];
} {
  const primitives: CanvasIntent["primitives"] = [];
  const written: GrowthRegion[] = [];
  const report: GrowthReport["regions"] = { drawn: [], resized: [], removed: [] };
  const claimed = new Set(intent.primitives.flatMap((primitive) => primitive.mode === "create" ? [] : [primitive.id.toLowerCase()]));
  for (const region of regions.values()) {
    if (region.id !== undefined && claimed.has(region.id.toLowerCase())) continue;
    if (!region.touched) {
      written.push(...recorded.filter((record) => record.title === region.title));
      continue;
    }
    const box = region.members.size > 0 ? boxOf(region) : undefined;
    const color = region.color === undefined ? {} : { color: region.color };
    if (!box) {
      if (region.drawn && region.id !== undefined) {
        primitives.push({ kind: "region", mode: "remove", id: region.id });
        report.removed.push(region.title);
      } else if (region.declared && region.id !== undefined && region.color !== undefined) {
        primitives.push({ kind: "region", mode: "update", id: region.id, ...color });
      }
      continue;
    }
    const geometry = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, width: box.maxX - box.minX, height: box.maxY - box.minY };
    if (region.id === undefined) {
      primitives.push({ kind: "region", mode: "create", ...geometry, title: region.title, fillOpacity, ...color });
      report.drawn.push(region.title);
    } else if (!region.base || !sameBox(box, region.base)) {
      primitives.push({ kind: "region", mode: "update", id: region.id, ...geometry, ...color });
      report.resized.push(region.title);
    } else if (region.declared && region.color !== undefined) {
      primitives.push({ kind: "region", mode: "update", id: region.id, ...color });
    }
    written.push({ title: region.title, drawn: region.drawn, box });
  }
  return { primitives, written, report };
}

/**
 * Every Link the growth layout sees: Links on the Canvas between Nodes it tracks, and the
 * Links this intent creates. A Node from before the growth appears as an older key.
 */
function graphEdges(intent: CanvasIntent, canvas: Canvas, tracked: (selector: string) => string | undefined, createdOnly = false): GrowthEdge[] {
  const key = (selector: string): string | undefined => {
    const own = tracked(selector);
    if (own !== undefined) return own;
    const node = canvas.find(selector);
    return typeof node?.id === "string" ? OLDER + node.id : undefined;
  };
  const byId = (id: unknown): string | undefined => {
    const node = canvas.nodes.find((item) => typeof id === "string" && typeof item.id === "string" && item.id.toLowerCase() === id.toLowerCase());
    return node && typeof node.id === "string" ? key(node.id) : undefined;
  };
  const removed = new Set(intent.links.flatMap((link) => link.mode === "remove" ? [link.id.toLowerCase()] : []));
  const existing = createdOnly ? [] : canvas.links.flatMap((link) => {
    if (typeof link.id === "string" && removed.has(link.id.toLowerCase())) return [];
    const from = byId(link.sourceNodeID);
    const to = byId(link.targetNodeID);
    return from && to ? [{ from, to }] : [];
  });
  const created = intent.links.flatMap((link) => {
    if (link.mode !== "create") return [];
    const from = key(link.source);
    const to = key(link.target);
    return from && to ? [{ from, to }] : [];
  });
  return [...existing, ...created].filter((edge) => !(edge.from.startsWith(OLDER) && edge.to.startsWith(OLDER)));
}

/**
 * Where a new growth's first Node goes: on the older Node it links to, else beside the older
 * members of its Region, else the empty-Canvas home, else beside what the Canvas holds.
 */
function startingAnchor(fresh: Array<{ note: string; x?: number; y?: number }>, edges: GrowthEdge[], older: (key: string) => Item | undefined, regions: Map<string, Region>, context: unknown, geometry: Geometry): Point {
  const first = fresh[0];
  if (first?.x !== undefined && first.y !== undefined) return { x: first.x, y: first.y };
  if (first) {
    const neighbour = edges.flatMap((edge) => edge.from === first.note ? [edge.to] : edge.to === first.note ? [edge.from] : []).map(older).find((node) => node && position(node));
    if (neighbour) return position(neighbour)!;
    const region = [...regions.values()].find((candidate) => candidate.members.has(first.note));
    const peer = [...(region?.members ?? [])].map(older).find((node) => node && position(node));
    if (peer) return position(peer)!;
    if (region?.base) return { x: (region.base.minX + region.base.maxX) / 2, y: (region.base.minY + region.base.maxY) / 2 };
  }
  const offset = centeringOffset(centered({ x: 0, y: 0 }, geometry.nodeWidth, geometry.nodeHeight), existingContent(context));
  return existingContent(context) === undefined ? { ...CANVAS_WORLD_HOME } : { x: offset.dx, y: offset.dy };
}

/** Nodes outside the growth, keyed the way Region members are, each with its box. */
function staticNodes(canvas: Canvas, skip: (node: Item) => boolean): Array<{ key: string; box: WorldBox }> {
  return canvas.nodes.filter((node) => !skip(node)).flatMap((node) => {
    const box = contextNodeBox(node);
    return box ? [{ key: OLDER + String(node.id ?? ""), box }] : [];
  });
}

/**
 * The full layout over the growth's own Nodes, with its drawn Regions as clusters, kept only
 * when it removes crossings. The first Node holds still and Nodes the agent pinned stay out.
 */
function tidyGrowth(growth: Growth, edges: GrowthEdge[], canvas: Canvas, regions: Map<string, Region>): { moves: Array<[string, Point]>; report: NonNullable<GrowthReport["tidy"]> } {
  const members = growth.nodes.filter((node) => !node.fixed || (node.rank === 0 && node.slot === 0));
  const titles = new Set(members.map((node) => node.note));
  const inner = edges.filter((edge) => titles.has(edge.from) && titles.has(edge.to) && edge.from !== edge.to);
  const unique = inner.filter((edge, index) => inner.findIndex((other) => [other.from, other.to].sort().join("\u0000") === [edge.from, edge.to].sort().join("\u0000")) === index);
  if (members.length < 2) return { moves: [], report: { applied: false, crossingsBefore: 0, crossingsAfter: 0 } };
  const clusters = [...regions.values()]
    .filter((region) => region.drawn && region.members.size > 0 && [...region.members].every((key) => titles.has(key)))
    .map((region) => ({ name: region.title, members: [...region.members] }));
  const spec = canvasSpecFromObject({
    canvas: "growth",
    direction: growth.direction,
    members: members.map((node) => {
      const appearance = canvas.find(node.note)?.appearance;
      return typeof appearance === "string" ? { title: node.note, appearance } : node.note;
    }),
    edges: unique,
    clusters
  });
  const layout = computeCanvasLayout(spec);
  const anchor = layout.nodes.find((node) => node.title === members[0].note)!;
  const dx = members[0].x - anchor.x;
  const dy = members[0].y - anchor.y;
  const tidied = layout.nodes.map((node) => ({ title: node.title, x: node.x + dx, y: node.y + dy }));
  const before = linkCrossings(spec, { nodes: members.map((node) => ({ title: node.note, x: node.x, y: node.y })) }).length;
  const after = linkCrossings(spec, { nodes: tidied }).length;
  if (after >= before) return { moves: [], report: { applied: false, crossingsBefore: before, crossingsAfter: before } };
  const moves = tidied.flatMap((node): Array<[string, Point]> => {
    const current = members.find((member) => member.note === node.title)!;
    return Math.abs(current.x - node.x) > MOVE_TOLERANCE || Math.abs(current.y - node.y) > MOVE_TOLERANCE ? [[node.title, { x: node.x, y: node.y }]] : [];
  });
  return { moves, report: { applied: true, crossingsBefore: before, crossingsAfter: after } };
}

/**
 * Excerpts and connected Marks without a position stack in the lane beside their Node, to the
 * right for TB and below for LR. A TB lane switches to the left when a Node sits on its right.
 * Marks that connect to nothing stack above the drawing.
 */
function placeAnnotations(intent: CanvasIntent, canvas: Canvas, direction: Direction, growth: Growth | undefined): CanvasIntent {
  const needs = intent.excerpts.some((excerpt) => excerpt.mode === "create" && excerpt.x === undefined)
    || intent.marks.some((mark) => mark.mode === "create" && mark.x === undefined);
  if (!needs) return intent;
  const geometryOf = (appearance: unknown): Geometry => growth?.symbols || isSymbolAppearance(typeof appearance === "string" ? appearance : undefined) ? SYMBOL_GEOMETRY : CARD_GEOMETRY;
  const nodeAt = (selector: string): { point: Point; geometry: Geometry } | undefined => {
    const placed = intent.nodes.find((node) => (node.mode === "place" && sameNote(node.note, selector, canvas)) || ("selector" in node && sameNote(node.selector, selector, canvas)));
    if (placed && "x" in placed && placed.x !== undefined && placed.y !== undefined) return { point: { x: placed.x, y: placed.y }, geometry: geometryOf("appearance" in placed ? placed.appearance : undefined) };
    const own = growth?.nodes.find((node) => sameNote(node.note, selector, canvas));
    if (own) return { point: { x: own.x, y: own.y }, geometry: geometryOf(undefined) };
    const found = canvas.find(selector);
    const point = found && position(found);
    return point ? { point, geometry: geometryOf(found?.appearance) } : undefined;
  };
  const occupiedRight = (point: Point, geometry: Geometry): boolean => {
    const others = [
      ...intent.nodes.flatMap((node) => "x" in node && node.x !== undefined && node.y !== undefined ? [{ x: node.x, y: node.y }] : []),
      ...canvas.nodes.flatMap((node) => position(node) ?? [])
    ];
    return others.some((other) => Math.abs(other.y - point.y) < geometry.nodeHeight && other.x > point.x + 1 && other.x - point.x < geometry.nodeWidth + ANNOTATION_GEOMETRY.gap + ANNOTATION_GEOMETRY.width);
  };
  const cursors = new Map<string, Point>();
  const lane = (selector: string, text: string, width?: number): { x: number; y: number; width: number } => {
    const node = nodeAt(selector);
    if (!node) throw laneError(selector);
    const laneWidth = width ?? defaultLaneWidth(direction, node.geometry);
    const key = `${node.point.x},${node.point.y}`;
    const left = direction === "TB" && occupiedRight(node.point, node.geometry);
    const start = cursors.get(key) ?? laneOrigin(node.point, node.geometry, direction, laneWidth, left);
    const placed = { x: start.x, y: start.y, width: laneWidth };
    cursors.set(key, { x: start.x, y: markWorldBox({ ...placed, text }).maxY + ANNOTATION_GEOMETRY.stackGap });
    return placed;
  };
  const excerpts = intent.excerpts.map((excerpt) => excerpt.mode === "create" && excerpt.x === undefined ? { ...excerpt, ...lane(excerpt.note, excerpt.text, excerpt.width) } : excerpt);
  const free = intent.marks.filter((mark) => mark.mode === "create" && mark.x === undefined && !mark.connect?.length);
  const above = stackAbove(free.map((mark) => mark.mode === "create" ? { text: mark.text, width: mark.width } : { text: "" }), intent, canvas);
  let freeIndex = 0;
  const marks = intent.marks.map((mark) => {
    if (mark.mode !== "create" || mark.x !== undefined) return mark;
    if (mark.connect?.length) return { ...mark, ...lane(mark.connect[0], mark.text, mark.width) };
    return { ...mark, ...above[freeIndex++] };
  });
  return { ...intent, excerpts, marks };
}

function defaultLaneWidth(direction: Direction, geometry: Geometry): number {
  return direction === "TB" ? ANNOTATION_GEOMETRY.width : geometry.colStep - 2 * ANNOTATION_GEOMETRY.gap;
}

/** Top-left of a Node's annotation lane: beside it for TB, on the left when `left`, and below it for LR. */
function laneOrigin(point: Point, geometry: Geometry, direction: Direction, laneWidth: number, left: boolean): Point {
  if (direction === "LR") return { x: point.x - geometry.nodeWidth / 2, y: point.y + geometry.nodeHeight / 2 + ANNOTATION_GEOMETRY.gap };
  const x = left ? point.x - geometry.nodeWidth / 2 - ANNOTATION_GEOMETRY.gap - laneWidth : point.x + geometry.nodeWidth / 2 + ANNOTATION_GEOMETRY.gap;
  return { x, y: point.y - geometry.nodeHeight / 2 };
}

/** The boxes a lane's items stack into, in the order placeAnnotations places them. */
function stackLane(point: Point, geometry: Geometry, direction: Direction, items: Array<{ text: string; width?: number }>): WorldBox[] {
  let cursor: Point | undefined;
  return items.map(({ text, width }) => {
    const laneWidth = width ?? defaultLaneWidth(direction, geometry);
    const start = cursor ?? laneOrigin(point, geometry, direction, laneWidth, false);
    const box = markWorldBox({ x: start.x, y: start.y, width: laneWidth, text });
    cursor = { x: start.x, y: box.maxY + ANNOTATION_GEOMETRY.stackGap };
    return box;
  });
}

/**
 * The annotation lanes beside growth Nodes: `planned` stacks the Excerpts and connected Marks
 * this intent places without x and y beside a Node at a point, and `shown` is what the Canvas
 * already shows for that Node.
 */
function annotationLanes(intent: CanvasIntent, canvas: Canvas, tracked: (selector: string) => string | undefined, direction: Direction, geometry: Geometry): {
  planned: (key: string, point: Point) => WorldBox[]; shown: (key: string) => WorldBox[];
} {
  const keyOf = (selector: string): string | undefined => {
    const own = tracked(selector);
    if (own !== undefined) return own;
    const node = canvas.find(selector);
    return typeof node?.id === "string" ? OLDER + node.id : undefined;
  };
  const items = new Map<string, Array<{ text: string; width?: number }>>();
  const add = (selector: string, item: { text: string; width?: number }): void => {
    const key = keyOf(selector);
    if (key !== undefined) items.set(key, [...(items.get(key) ?? []), item]);
  };
  for (const excerpt of intent.excerpts) if (excerpt.mode === "create" && excerpt.x === undefined) add(excerpt.note, { text: excerpt.text, width: excerpt.width });
  for (const mark of intent.marks) if (mark.mode === "create" && mark.x === undefined && mark.connect?.length) add(mark.connect[0], { text: mark.text, width: mark.width });
  const nodeId = (key: string): string | undefined => {
    if (key.startsWith(OLDER)) return key.slice(OLDER.length);
    const id = canvas.find(key)?.id;
    return typeof id === "string" ? id : undefined;
  };
  const annotates = (item: Item, id: string): boolean => {
    const same = (value: unknown): boolean => typeof value === "string" && value.toLowerCase() === id.toLowerCase();
    return same(item.linkedNodeID) || (Array.isArray(item.connectedNodeIDs) && item.connectedNodeIDs.some(same));
  };
  const texts = [...canvas.excerpts, ...canvas.marks.filter((mark) => mark.kind !== "strokes")];
  return {
    planned: (key, point) => stackLane(point, geometry, direction, items.get(key) ?? []),
    shown: (key) => {
      const id = nodeId(key);
      return id === undefined ? [] : texts.filter((item) => annotates(item, id)).flatMap(textBox);
    }
  };
}

function stackAbove(items: Array<{ text: string; width?: number }>, intent: CanvasIntent, canvas: Canvas): Array<{ x: number; y: number; width: number }> {
  if (items.length === 0) return [];
  const points = [
    ...intent.nodes.flatMap((node) => "x" in node && node.x !== undefined && node.y !== undefined ? [{ x: node.x, y: node.y }] : []),
    ...canvas.nodes.flatMap((node) => position(node) ?? [])
  ];
  const boxes = points.map((point) => centered(point, CARD_GEOMETRY.nodeWidth, CARD_GEOMETRY.nodeHeight));
  const left = boxes.length === 0 ? CANVAS_WORLD_HOME.x : Math.min(...boxes.map((box) => box.minX));
  const top = boxes.length === 0 ? CANVAS_WORLD_HOME.y : Math.min(...boxes.map((box) => box.minY));
  const sized = items.map(({ text, width }) => {
    const wrap = width ?? ANNOTATION_GEOMETRY.canvasWidth;
    const box = markWorldBox({ x: 0, y: 0, width: wrap, text });
    return { width: wrap, height: box.maxY - box.minY };
  });
  let y = top - ANNOTATION_GEOMETRY.canvasGap - sized.reduce((total, item) => total + item.height, ANNOTATION_GEOMETRY.stackGap * (sized.length - 1));
  return sized.map(({ width, height }) => {
    const placed = { x: left, y, width };
    y += height + ANNOTATION_GEOMETRY.stackGap;
    return placed;
  });
}

function laneError(selector: string): EnsoCliError {
  return new EnsoCliError("missing_selector", `No Node on the Canvas or in this intent matches '${selector}'`, {
    path: "annotations", expected: "a Node the Canvas holds or this intent places", hint: "Place the Node first, or give the Excerpt or Mark x and y"
  });
}

function position(node: Item): Point | undefined {
  const value = node.position;
  if (value && typeof value === "object") {
    const { x, y } = value as { x?: unknown; y?: unknown };
    if (typeof x === "number" && typeof y === "number") return { x, y };
  }
  const bounds = boundsBox(node.bounds);
  return bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : undefined;
}

function textBox(item: Item): WorldBox[] {
  const bounds = boundsBox(item.bounds);
  if (bounds) return [bounds];
  const value = item.position;
  if (!value || typeof value !== "object") return [];
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return [];
  return [markWorldBox({ x, y, width: typeof item.width === "number" ? item.width : undefined, text: typeof item.text === "string" ? item.text : undefined })];
}
