// Fills in the positions an intent leaves out, so an agent adds one Node at a time and the
// Canvas grows. The CLI keeps the Agent turn on disk: the Nodes this agent placed on this
// Canvas, each with its spot in the growth layout. Nodes from before the turn never move.

import { canvasSpecFromObject } from "./canvas-spec.js";
import { EnsoCliError } from "./errors.js";
import type { CanvasIntent } from "./canvas-intent.js";
import { growLayout, type GrowthEdge, type GrowthNode, type GrowthSpot } from "./growth-layout.js";
import { CANVAS_WORLD_HOME, centeringOffset, contextObject, existingContent, readArray, type WorldBox } from "./layout-centering.js";
import { ANNOTATION_GEOMETRY, CARD_GEOMETRY, SYMBOL_GEOMETRY, computeCanvasLayout, isSymbolAppearance, linkCrossings } from "./layout.js";
import { markWorldBox } from "./mark-model.js";
import { noteMatches } from "./note-identity.js";

/** An Agent turn ends after this long without a write. */
export const TURN_QUIET_MS = 120_000;
const MOVE_TOLERANCE = 0.5;

export type Direction = "TB" | "LR";
export type TurnNode = GrowthSpot & { note: string; fixed: boolean; x: number; y: number };
export type AgentTurn = { canvasID: string; startedAt: number; lastWriteAt: number; direction: Direction; symbols: boolean; anchor: Point; nodes: TurnNode[] };
export type TurnEnd = "quiet" | "moved" | "canvas" | "tidy";
export type GrowthReport = {
  turn: "started" | "continued" | "ended";
  endedBecause?: TurnEnd;
  placed: string[];
  moved: string[];
  tidy?: { applied: boolean; crossingsBefore: number; crossingsAfter: number };
};
export type GrowthPlan = { intent: CanvasIntent; turn: AgentTurn | undefined; report?: GrowthReport };

type Point = { x: number; y: number };
type Item = Record<string, unknown>;
type Geometry = typeof CARD_GEOMETRY | typeof SYMBOL_GEOMETRY;

/** Whether this intent changes the graph, which is when an active Agent turn grows. */
export function changesGraph(intent: CanvasIntent): boolean {
  return Boolean(intent.tidy)
    || intent.nodes.some((node) => node.mode === "place" || node.mode === "remove")
    || intent.links.some((link) => link.mode === "create" || link.mode === "remove");
}

export function planGrowth(intent: CanvasIntent, context: unknown, previous: AgentTurn | undefined, canvasID: string, now: number): GrowthPlan {
  const canvas = readCanvas(context);
  const { turn: continued, ended } = continueTurn(previous, canvas, canvasID, now);
  const grows = Boolean(intent.tidy)
    || intent.nodes.some((node) => node.kind === "note" && node.mode === "place" && node.x === undefined && canvas.find(node.note) === undefined)
    || (continued !== undefined && changesGraph(intent));
  if (!grows) {
    const filled = placeAnnotations(intent, canvas, continued?.direction ?? intent.direction ?? "TB", continued);
    return { intent: filled, turn: continued && { ...continued, lastWriteAt: now } };
  }

  const direction = continued?.direction ?? intent.direction ?? "TB";
  const placing = intent.nodes.flatMap((node) => node.kind === "note" && node.mode === "place" ? [node] : []);
  const symbols = continued?.symbols ?? (placing.length > 0 && placing.every((node) => isSymbolAppearance(node.appearance)));
  const geometry = symbols ? SYMBOL_GEOMETRY : CARD_GEOMETRY;
  const turnNodes = (continued?.nodes ?? []).filter((node) => !removes(intent, node.note, canvas));
  const inTurn = (selector: string): TurnNode | undefined => turnNodes.find((node) => sameNote(node.note, selector, canvas));

  const fresh = placing.filter((node) => !inTurn(node.note) && canvas.find(node.note) === undefined);
  const edges = graphEdges(intent, canvas, (selector) => inTurn(selector)?.note ?? fresh.find((node) => sameNote(node.note, selector, canvas))?.note);
  const older = (key: string): Item | undefined => key.startsWith(OLDER) ? canvas.nodes.find((node) => node.id === key.slice(OLDER.length)) : undefined;

  const anchor = continued?.anchor ?? startingAnchor(fresh, edges, older, context, geometry);
  const toWorld = (spot: GrowthSpot): Point => direction === "TB"
    ? { x: anchor.x + spot.slot * geometry.colStep, y: anchor.y + spot.rank * geometry.rowStep }
    : { x: anchor.x + spot.rank * geometry.colStep, y: anchor.y + spot.slot * geometry.rowStep };
  const toSpot = (point: Point): GrowthSpot => direction === "TB"
    ? { rank: (point.y - anchor.y) / geometry.rowStep, slot: (point.x - anchor.x) / geometry.colStep }
    : { rank: (point.x - anchor.x) / geometry.colStep, slot: (point.y - anchor.y) / geometry.rowStep };

  const previousSpots = new Map<string, GrowthNode>(turnNodes.map((node) => [node.note, { rank: node.rank, slot: node.slot, fixed: node.fixed }]));
  for (const { from, to } of edges) for (const key of [from, to]) {
    const node = older(key);
    const point = node && position(node);
    if (point && !previousSpots.has(key)) previousSpots.set(key, { ...toSpot(point), fixed: true });
  }
  const added = fresh.map((node, index) => {
    if (node.x !== undefined && node.y !== undefined) return { key: node.note, fixed: toSpot({ x: node.x, y: node.y }) };
    const first = turnNodes.length === 0 && index === 0 && !edges.some((edge) => (edge.from === node.note || edge.to === node.note) && previousSpots.has(edge.from === node.note ? edge.to : edge.from));
    return first ? { key: node.note, fixed: { rank: 0, slot: 0 } } : { key: node.note };
  });
  const occupied = occupiedBoxes(canvas, (node) => turnNodes.some((own) => noteMatches(identity(node), own.note)) || removes(intent, String(node.id ?? ""), canvas));
  const taken = (spot: GrowthSpot): boolean => {
    const point = toWorld(spot);
    const box = centered(point, geometry.nodeWidth, geometry.nodeHeight);
    return occupied.some((other) => overlaps(box, other));
  };
  const intentEdges = graphEdges(intent, canvas, (selector) => inTurn(selector)?.note ?? fresh.find((node) => sameNote(node.note, selector, canvas))?.note, true);
  const grown = growLayout(previousSpots, added, edges, intentEdges, taken);

  const placed: string[] = [];
  const moved: string[] = [];
  const nextNodes: TurnNode[] = [];
  const nodes: CanvasIntent["nodes"] = intent.nodes.map((node) => {
    if (node.kind !== "note" || node.mode !== "place" || !fresh.includes(node)) return node;
    const spot = grown.get(node.note)!;
    const point = node.x !== undefined && node.y !== undefined ? { x: node.x, y: node.y } : toWorld(spot);
    placed.push(node.note);
    nextNodes.push({ note: node.note, ...spot, fixed: node.x !== undefined || spot.fixed, ...point });
    return { ...node, ...point };
  });
  for (const node of turnNodes) {
    const spot = grown.get(node.note)!;
    const point = toWorld(spot);
    if (Math.abs(point.x - node.x) > MOVE_TOLERANCE || Math.abs(point.y - node.y) > MOVE_TOLERANCE) {
      if (!intent.nodes.some((item) => "selector" in item && sameNote(node.note, item.selector, canvas))) {
        nodes.push({ kind: "note", mode: "update", selector: node.note, x: point.x, y: point.y });
        moved.push(node.note);
      }
      nextNodes.push({ ...node, ...spot, ...point });
    } else {
      nextNodes.push({ ...node, ...spot });
    }
  }

  let turn: AgentTurn | undefined = {
    canvasID, startedAt: continued?.startedAt ?? now, lastWriteAt: now, direction, symbols, anchor, nodes: nextNodes
  };
  let tidy: GrowthReport["tidy"];
  if (intent.tidy) {
    const result = tidyTurn(turn, edges, canvas);
    tidy = result.report;
    for (const [note, point] of result.moves) {
      const existing = nodes.findIndex((node) => (node.mode === "place" && node.note === note) || ("selector" in node && node.selector === note));
      if (existing >= 0) nodes[existing] = { ...nodes[existing], ...point } as CanvasIntent["nodes"][number];
      else nodes.push({ kind: "note", mode: "update", selector: note, ...point });
      if (!moved.includes(note) && !placed.includes(note)) moved.push(note);
      turn.nodes = turn.nodes.map((node) => node.note === note ? { ...node, ...point } : node);
    }
  }
  const filled = placeAnnotations({ ...intent, nodes }, canvas, direction, turn);
  const report: GrowthReport = {
    turn: intent.tidy ? "ended" : continued ? "continued" : "started",
    ...(intent.tidy ? { endedBecause: "tidy" as const } : ended && !continued ? { endedBecause: ended } : {}),
    placed,
    moved,
    ...(tidy ? { tidy } : {})
  };
  if (intent.tidy) turn = undefined;
  return { intent: filled, turn, report };
}

const OLDER = "older:";

type Canvas = {
  nodes: Item[];
  links: Item[];
  excerpts: Item[];
  marks: Item[];
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
 * The turn continues on the same Canvas while writes keep coming and nobody moves its Nodes.
 * A Node the Canvas no longer holds leaves the turn.
 */
function continueTurn(previous: AgentTurn | undefined, canvas: Canvas, canvasID: string, now: number): { turn?: AgentTurn; ended?: TurnEnd } {
  if (!previous) return {};
  if (previous.canvasID !== canvasID) return { ended: "canvas" };
  if (now - previous.lastWriteAt > TURN_QUIET_MS) return { ended: "quiet" };
  const nodes: TurnNode[] = [];
  for (const node of previous.nodes) {
    const found = canvas.find(node.note);
    if (!found) continue;
    const point = position(found);
    if (point && (Math.abs(point.x - node.x) > MOVE_TOLERANCE || Math.abs(point.y - node.y) > MOVE_TOLERANCE)) return { ended: "moved" };
    nodes.push(node);
  }
  return { turn: { ...previous, nodes } };
}

/**
 * Every Link the growth layout sees: Links on the Canvas between Nodes it tracks, and the
 * Links this intent creates. A Node from before the turn appears as an older key.
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
 * Where a new turn's first Node goes: on the Node from before the turn it links to, else the
 * empty-Canvas home, else beside what the Canvas holds.
 */
function startingAnchor(fresh: Array<{ note: string; x?: number; y?: number }>, edges: GrowthEdge[], older: (key: string) => Item | undefined, context: unknown, geometry: Geometry): Point {
  const first = fresh[0];
  if (first?.x !== undefined && first.y !== undefined) return { x: first.x, y: first.y };
  if (first) {
    const neighbour = edges.flatMap((edge) => edge.from === first.note ? [edge.to] : edge.to === first.note ? [edge.from] : []).map(older).find((node) => node && position(node));
    if (neighbour) return position(neighbour)!;
  }
  const offset = centeringOffset(centered({ x: 0, y: 0 }, geometry.nodeWidth, geometry.nodeHeight), existingContent(context));
  return existingContent(context) === undefined ? { ...CANVAS_WORLD_HOME } : { x: offset.dx, y: offset.dy };
}

/** What a new Node must stay clear of: Nodes outside the turn, Excerpts, and typed Marks. */
function occupiedBoxes(canvas: Canvas, skip: (node: Item) => boolean): WorldBox[] {
  const nodes = canvas.nodes.filter((node) => !skip(node)).flatMap((node) => {
    const bounds = boundsBox(node.bounds);
    if (bounds) return [bounds];
    const point = position(node);
    const size = isSymbolAppearance(typeof node.appearance === "string" ? node.appearance : undefined) ? SYMBOL_GEOMETRY : CARD_GEOMETRY;
    return point ? [centered(point, size.nodeWidth, size.nodeHeight)] : [];
  });
  return [...nodes, ...canvas.excerpts.flatMap(textBox), ...canvas.marks.filter((mark) => mark.kind !== "strokes").flatMap(textBox)];
}

/**
 * The full layout over the turn's own Nodes, kept only when it removes crossings. The first
 * Node holds still and Nodes the agent pinned stay out of it.
 */
function tidyTurn(turn: AgentTurn, edges: GrowthEdge[], canvas: Canvas): { moves: Array<[string, Point]>; report: NonNullable<GrowthReport["tidy"]> } {
  const members = turn.nodes.filter((node) => !node.fixed || (node.rank === 0 && node.slot === 0));
  const titles = new Set(members.map((node) => node.note));
  const inner = edges.filter((edge) => titles.has(edge.from) && titles.has(edge.to) && edge.from !== edge.to);
  const unique = inner.filter((edge, index) => inner.findIndex((other) => [other.from, other.to].sort().join("\u0000") === [edge.from, edge.to].sort().join("\u0000")) === index);
  if (members.length < 2) return { moves: [], report: { applied: false, crossingsBefore: 0, crossingsAfter: 0 } };
  const spec = canvasSpecFromObject({
    canvas: "turn",
    direction: turn.direction,
    members: members.map((node) => {
      const appearance = canvas.find(node.note)?.appearance;
      return typeof appearance === "string" ? { title: node.note, appearance } : node.note;
    }),
    edges: unique
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
function placeAnnotations(intent: CanvasIntent, canvas: Canvas, direction: Direction, turn: AgentTurn | undefined): CanvasIntent {
  const needs = intent.excerpts.some((excerpt) => excerpt.mode === "create" && excerpt.x === undefined)
    || intent.marks.some((mark) => mark.mode === "create" && mark.x === undefined);
  if (!needs) return intent;
  const centers = new Map<string, { point: Point; geometry: Geometry }>();
  const geometryOf = (appearance: unknown): Geometry => turn?.symbols || isSymbolAppearance(typeof appearance === "string" ? appearance : undefined) ? SYMBOL_GEOMETRY : CARD_GEOMETRY;
  const nodeAt = (selector: string): { point: Point; geometry: Geometry } | undefined => {
    const placed = intent.nodes.find((node) => (node.mode === "place" && sameNote(node.note, selector, canvas)) || ("selector" in node && sameNote(node.selector, selector, canvas)));
    if (placed && "x" in placed && placed.x !== undefined && placed.y !== undefined) return { point: { x: placed.x, y: placed.y }, geometry: geometryOf("appearance" in placed ? placed.appearance : undefined) };
    const own = turn?.nodes.find((node) => sameNote(node.note, selector, canvas));
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
    const laneWidth = width ?? (direction === "TB" ? ANNOTATION_GEOMETRY.width : node.geometry.colStep - 2 * ANNOTATION_GEOMETRY.gap);
    const key = `${node.point.x},${node.point.y}`;
    const left = direction === "TB" && occupiedRight(node.point, node.geometry);
    const start = cursors.get(key) ?? (direction === "TB"
      ? { x: left ? node.point.x - node.geometry.nodeWidth / 2 - ANNOTATION_GEOMETRY.gap - laneWidth : node.point.x + node.geometry.nodeWidth / 2 + ANNOTATION_GEOMETRY.gap, y: node.point.y - node.geometry.nodeHeight / 2 }
      : { x: node.point.x - node.geometry.nodeWidth / 2, y: node.point.y + node.geometry.nodeHeight / 2 + ANNOTATION_GEOMETRY.gap });
    const placed = { x: start.x, y: start.y, width: laneWidth };
    cursors.set(key, { x: start.x, y: markWorldBox({ ...placed, text }).maxY + ANNOTATION_GEOMETRY.stackGap });
    centers.set(key, node);
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

function boundsBox(value: unknown): WorldBox | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
  return { minX: x as number, minY: y as number, maxX: (x as number) + (width as number), maxY: (y as number) + (height as number) };
}

function centered(point: Point, width: number, height: number): WorldBox {
  return { minX: point.x - width / 2, minY: point.y - height / 2, maxX: point.x + width / 2, maxY: point.y + height / 2 };
}

function overlaps(a: WorldBox, b: WorldBox): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}
