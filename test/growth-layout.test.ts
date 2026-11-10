import { describe, expect, it } from "vitest";
import { parseCanvasIntent } from "../src/canvas-intent.js";
import { growLayout, type GrowthNode } from "../src/growth-layout.js";
import { TURN_QUIET_MS, planGrowth, type AgentTurn } from "../src/growth-apply.js";
import { CANVAS_WORLD_HOME } from "../src/layout-centering.js";
import { ANNOTATION_GEOMETRY, CARD_GEOMETRY } from "../src/layout.js";

const CANVAS = "22222222-2222-4222-8222-222222222222";

function grow(order: string[], edges: Array<{ from: string; to: string }>): Map<string, GrowthNode> {
  let spots = new Map<string, GrowthNode>();
  const present = new Set<string>();
  order.forEach((key, index) => {
    const before = edges.filter(({ from, to }) => present.has(from) && present.has(to));
    present.add(key);
    const now = edges.filter(({ from, to }) => present.has(from) && present.has(to));
    spots = growLayout(spots, [{ key, ...(index === 0 ? { fixed: { rank: 0, slot: 0 } } : {}) }], now, now.filter((edge) => !before.includes(edge)));
  });
  return spots;
}

describe("growth layout", () => {
  const edges = [
    { from: "A", to: "B" }, { from: "A", to: "C" }, { from: "B", to: "D" }, { from: "C", to: "D" }, { from: "D", to: "E" }, { from: "A", to: "F" }
  ];

  it("ranks a Node one past its sources and keeps every placed Node's rank and order", () => {
    let spots = new Map<string, GrowthNode>();
    const order = ["A", "B", "C", "D", "E", "F"];
    const present = new Set<string>();
    for (const [index, key] of order.entries()) {
      const before = new Map(spots);
      present.add(key);
      const now = edges.filter(({ from, to }) => present.has(from) && present.has(to));
      spots = growLayout(spots, [{ key, ...(index === 0 ? { fixed: { rank: 0, slot: 0 } } : {}) }], now, now.filter(({ to, from }) => to === key || from === key));
      for (const [other, spot] of before) {
        expect(spots.get(other)!.rank).toBe(spot.rank);
        expect(Math.abs(spots.get(other)!.slot - spot.slot)).toBeLessThanOrEqual(0.5);
      }
      const keys = [...before.keys()];
      for (const a of keys) for (const b of keys) {
        if (before.get(a)!.rank === before.get(b)!.rank && before.get(a)!.slot < before.get(b)!.slot) expect(spots.get(a)!.slot).toBeLessThan(spots.get(b)!.slot);
      }
    }
    expect(spots.get("D")!.rank).toBe(2);
    expect(spots.get("E")!.rank).toBe(3);
  });

  it("moves nothing on a rerun with no new Node or Link", () => {
    const spots = grow(["A", "B", "C", "D", "E", "F"], edges);
    expect(growLayout(spots, [], edges)).toEqual(spots);
  });

  it("keeps fixed Nodes still and every rank a full step apart", () => {
    const spots = grow(["A", "F", "C", "B", "D", "E"], edges);
    expect(spots.get("A")).toEqual({ rank: 0, slot: 0, fixed: true });
    const all = [...spots.values()];
    for (const a of all) for (const b of all) if (a !== b && a.rank === b.rank) expect(Math.abs(a.slot - b.slot)).toBeGreaterThanOrEqual(1);
  });

  it("keeps a placed Node's rank when a late Link would lift it, so the Link points back", () => {
    const spots = grow(["A", "B", "C"], [{ from: "A", to: "B" }, { from: "C", to: "A" }]);
    const lifted = growLayout(spots, [], [{ from: "A", to: "B" }, { from: "C", to: "A" }, { from: "B", to: "C" }], [{ from: "B", to: "C" }]);
    expect(lifted.get("C")!.rank).toBe(spots.get("C")!.rank);
  });
});

describe("growth on canvas apply", () => {
  const place = (note: string, extra: Record<string, unknown> = {}) => ({ kind: "note", mode: "place", note, ...extra });

  it("starts a turn on the empty-Canvas home and grows the next Node one rank down", () => {
    const first = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("Client")] }), { nodes: [], links: [] }, undefined, CANVAS, 1_000);
    expect(first.intent.nodes[0]).toMatchObject({ x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y });
    expect(first.report).toMatchObject({ turn: "started", placed: ["Client"], moved: [] });

    const canvas = { nodes: [{ id: "c1", title: "Client", position: { ...CANVAS_WORLD_HOME } }], links: [] };
    const second = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("Sync server")], links: [{ mode: "create", source: "Client", target: "Sync server" }] }), canvas, first.turn, CANVAS, 2_000);
    expect(second.intent.nodes[0]).toMatchObject({ x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y + CARD_GEOMETRY.rowStep });
    expect(second.report).toMatchObject({ turn: "continued", placed: ["Sync server"] });
    expect(second.turn!.nodes.map((node) => node.note)).toEqual(["Sync server", "Client"]);
  });

  it("grows left to right when the turn starts with that direction", () => {
    const first = planGrowth(parseCanvasIntent({ canvas: "current", direction: "LR", nodes: [place("A"), place("B")], links: [{ mode: "create", source: "A", target: "B" }] }), { nodes: [] }, undefined, CANVAS, 0);
    expect(first.intent.nodes[1]).toMatchObject({ x: CANVAS_WORLD_HOME.x + CARD_GEOMETRY.colStep, y: CANVAS_WORLD_HOME.y });
  });

  it("ends the turn when a person moves one of its Nodes, or after a quiet stretch", () => {
    const turn: AgentTurn = { canvasID: CANVAS, startedAt: 0, lastWriteAt: 0, direction: "TB", symbols: false, anchor: { x: 0, y: 0 }, nodes: [{ note: "A", rank: 0, slot: 0, fixed: true, x: 0, y: 0 }] };
    const intent = parseCanvasIntent({ canvas: "current", nodes: [place("B")], links: [{ mode: "create", source: "A", target: "B" }] });
    const dragged = planGrowth(intent, { nodes: [{ id: "a", title: "A", position: { x: 40, y: 0 } }] }, turn, CANVAS, 10);
    expect(dragged.report).toMatchObject({ turn: "started", endedBecause: "moved" });
    // The new turn anchors on the moved Node, which now belongs to the person, and grows below it.
    expect(dragged.intent.nodes[0]).toMatchObject({ x: 40, y: CARD_GEOMETRY.rowStep });

    const quiet = planGrowth(intent, { nodes: [{ id: "a", title: "A", position: { x: 0, y: 0 } }] }, turn, CANVAS, TURN_QUIET_MS + 1);
    expect(quiet.report).toMatchObject({ turn: "started", endedBecause: "quiet" });
  });

  it("leaves Nodes from before the turn in place and keeps new Nodes off them", () => {
    const canvas = { nodes: [
      { id: "old", title: "Old", position: { x: 0, y: 0 } },
      { id: "blocker", title: "Blocker", position: { x: 0, y: CARD_GEOMETRY.rowStep } }
    ] };
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("New")], links: [{ mode: "create", source: "Old", target: "New" }] }), canvas, undefined, CANVAS, 0);
    const placed = plan.intent.nodes.find((node) => node.mode === "place")!;
    expect(placed).toMatchObject({ y: CARD_GEOMETRY.rowStep });
    expect(Math.abs((placed as { x: number }).x)).toBeGreaterThanOrEqual(CARD_GEOMETRY.nodeWidth);
    expect(plan.intent.nodes.every((node) => node.mode === "place")).toBe(true);
  });

  it("pins a Node placed with x and y", () => {
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("A"), place("B", { x: 900, y: 900 })] }), { nodes: [] }, undefined, CANVAS, 0);
    expect(plan.intent.nodes[1]).toMatchObject({ x: 900, y: 900 });
    expect(plan.turn!.nodes.find((node) => node.note === "B")).toMatchObject({ fixed: true });
  });

  it("places an Excerpt and a connected Mark in the lane beside their Node, and a free Mark above", () => {
    const plan = planGrowth(parseCanvasIntent({
      canvas: "current",
      nodes: [place("Sync server")],
      excerpts: [{ mode: "create", note: "Sync server", text: "Retries with backoff." }],
      marks: [{ mode: "create", text: "Why retry here?", connect: ["Sync server"] }, { mode: "create", text: "Takeaway" }]
    }), { nodes: [] }, undefined, CANVAS, 0);
    const node = plan.intent.nodes[0] as { x: number; y: number };
    const excerpt = plan.intent.excerpts[0] as { x: number; y: number; width: number };
    expect(excerpt).toMatchObject({ x: node.x + CARD_GEOMETRY.nodeWidth / 2 + ANNOTATION_GEOMETRY.gap, y: node.y - CARD_GEOMETRY.nodeHeight / 2, width: ANNOTATION_GEOMETRY.width });
    const [connected, free] = plan.intent.marks as Array<{ x: number; y: number }>;
    expect(connected.x).toBe(excerpt.x);
    expect(connected.y).toBeGreaterThan(excerpt.y);
    expect(free.y).toBeLessThan(node.y - CARD_GEOMETRY.nodeHeight / 2);
  });

  it("tidies the turn only when the full layout removes crossings, and ends the turn", () => {
    const nodes = ["A", "B", "C", "D"];
    const positions: Record<string, { x: number; y: number }> = { A: { x: 0, y: 0 }, B: { x: 300, y: 0 }, C: { x: 300, y: 200 }, D: { x: 0, y: 200 } };
    const turn: AgentTurn = { canvasID: CANVAS, startedAt: 0, lastWriteAt: 0, direction: "TB", symbols: false, anchor: { x: 0, y: 0 },
      nodes: nodes.map((note, index) => ({ note, rank: positions[note].y / 200, slot: positions[note].x / 300, fixed: index === 0, ...positions[note] })) };
    const canvas = {
      nodes: nodes.map((title) => ({ id: title, title, position: positions[title] })),
      links: [{ id: "l1", sourceNodeID: "A", targetNodeID: "C" }, { id: "l2", sourceNodeID: "B", targetNodeID: "D" }]
    };
    const tidy = planGrowth(parseCanvasIntent({ canvas: "current", tidy: true }), canvas, turn, CANVAS, 1);
    expect(tidy.report).toMatchObject({ turn: "ended", endedBecause: "tidy", tidy: { applied: true, crossingsBefore: 1, crossingsAfter: 0 } });
    expect(tidy.turn).toBeUndefined();
    expect(tidy.intent.nodes.some((node) => "selector" in node && node.selector === "A")).toBe(false);

    const clean = planGrowth(parseCanvasIntent({ canvas: "current", tidy: true }), { ...canvas, links: [{ id: "l1", sourceNodeID: "A", targetNodeID: "D" }] }, turn, CANVAS, 1);
    expect(clean.report?.tidy).toMatchObject({ applied: false });
    expect(clean.intent.nodes).toEqual([]);
  });
});
