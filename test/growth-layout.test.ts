import { describe, expect, it } from "vitest";
import { parseCanvasIntent } from "../src/canvas-intent.js";
import { growLayout, type GrowthNode } from "../src/growth-layout.js";
import { GROWTH_QUIET_MS, growthSteps, planGrowth, type Growth } from "../src/growth-apply.js";
import { CANVAS_WORLD_HOME } from "../src/layout-centering.js";
import { markWorldBox } from "../src/mark-model.js";
import { ANNOTATION_GEOMETRY, CARD_GEOMETRY, SYMBOL_GEOMETRY } from "../src/layout.js";

const CANVAS = "22222222-2222-4222-8222-222222222222";
const TB = growthSteps(CARD_GEOMETRY, "TB");
const LR = growthSteps(CARD_GEOMETRY, "LR");

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

  it("starts a growth on the empty-Canvas home and grows the next Node one rank down", () => {
    const first = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("Client")] }), { nodes: [], links: [] }, undefined, CANVAS, 1_000);
    expect(first.intent.nodes[0]).toMatchObject({ x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y });
    expect(first.report).toMatchObject({ status: "started", placed: ["Client"], moved: [] });

    const canvas = { nodes: [{ id: "c1", title: "Client", position: { ...CANVAS_WORLD_HOME } }], links: [] };
    const second = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("Sync server")], links: [{ mode: "create", source: "Client", target: "Sync server" }] }), canvas, first.growth, CANVAS, 2_000);
    expect(second.intent.nodes[0]).toMatchObject({ x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y + TB.rank });
    expect(second.report).toMatchObject({ status: "continued", placed: ["Sync server"] });
    expect(second.growth!.nodes.map((node) => node.note)).toEqual(["Sync server", "Client"]);
  });

  it("grows left to right when the growth starts with that direction", () => {
    const first = planGrowth(parseCanvasIntent({ canvas: "current", direction: "LR", nodes: [place("A"), place("B")], links: [{ mode: "create", source: "A", target: "B" }] }), { nodes: [] }, undefined, CANVAS, 0);
    expect(first.intent.nodes[1]).toMatchObject({ x: CANVAS_WORLD_HOME.x + LR.rank, y: CANVAS_WORLD_HOME.y });
  });

  // A Link label of about five words at the app's 14pt label size, plus a little air on each side.
  const FIVE_WORD_LABEL = { width: 200, height: 22 };

  it("leaves room for a five-word Link label between linked Nodes growing left to right", () => {
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", direction: "LR", nodes: [place("A"), place("B")], links: [{ mode: "create", source: "A", target: "B" }] }), { nodes: [] }, undefined, CANVAS, 0);
    const [a, b] = plan.intent.nodes as Array<{ x: number; y: number }>;
    expect(b.y).toBe(a.y);
    expect(b.x - a.x - CARD_GEOMETRY.nodeWidth).toBeGreaterThanOrEqual(FIVE_WORD_LABEL.width);
  });

  it("leaves room for a Link label between linked symbols growing top to bottom", () => {
    const symbol = { appearance: "server" };
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("A", symbol), place("B", symbol)], links: [{ mode: "create", source: "A", target: "B" }] }), { nodes: [] }, undefined, CANVAS, 0);
    const [a, b] = plan.intent.nodes as Array<{ x: number; y: number }>;
    expect(b.x).toBe(a.x);
    expect(b.y - a.y - SYMBOL_GEOMETRY.nodeHeight).toBeGreaterThanOrEqual(FIVE_WORD_LABEL.height + 2 * ANNOTATION_GEOMETRY.gap);
  });

  it("ends the growth when a person moves one of its Nodes, or after a quiet stretch", () => {
    const growth: Growth = { canvasID: CANVAS, startedAt: 0, lastWriteAt: 0, direction: "TB", symbols: false, anchor: { x: 0, y: 0 }, regions: [], nodes: [{ note: "A", rank: 0, slot: 0, fixed: true, x: 0, y: 0 }] };
    const intent = parseCanvasIntent({ canvas: "current", nodes: [place("B")], links: [{ mode: "create", source: "A", target: "B" }] });
    const dragged = planGrowth(intent, { nodes: [{ id: "a", title: "A", position: { x: 40, y: 0 } }] }, growth, CANVAS, 10);
    expect(dragged.report).toMatchObject({ status: "started", endedBecause: "moved" });
    // The new growth anchors on the moved Node, which now belongs to the person, and grows below it.
    expect(dragged.intent.nodes[0]).toMatchObject({ x: 40, y: TB.rank });

    const quiet = planGrowth(intent, { nodes: [{ id: "a", title: "A", position: { x: 0, y: 0 } }] }, growth, CANVAS, GROWTH_QUIET_MS + 1);
    expect(quiet.report).toMatchObject({ status: "started", endedBecause: "quiet" });
  });

  it("leaves Nodes from before the growth in place and keeps new Nodes off them", () => {
    const canvas = { nodes: [
      { id: "old", title: "Old", position: { x: 0, y: 0 } },
      { id: "blocker", title: "Blocker", position: { x: 0, y: TB.rank } }
    ] };
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("New")], links: [{ mode: "create", source: "Old", target: "New" }] }), canvas, undefined, CANVAS, 0);
    const placed = plan.intent.nodes.find((node) => node.mode === "place")!;
    expect(placed).toMatchObject({ y: TB.rank });
    expect(Math.abs((placed as { x: number }).x)).toBeGreaterThanOrEqual(CARD_GEOMETRY.nodeWidth);
    expect(plan.intent.nodes.every((node) => node.mode === "place")).toBe(true);
  });

  it("pins a Node placed with x and y", () => {
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("A"), place("B", { x: 900, y: 900 })] }), { nodes: [] }, undefined, CANVAS, 0);
    expect(plan.intent.nodes[1]).toMatchObject({ x: 900, y: 900 });
    expect(plan.growth!.nodes.find((node) => node.note === "B")).toMatchObject({ fixed: true });
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

  it("keeps a new Node off the Excerpt lane below its neighbor growing left to right", () => {
    const long = "Retries with exponential backoff and jitter, then parks the update in a dead-letter queue the operator drains by hand.";
    const plan = planGrowth(parseCanvasIntent({
      canvas: "current", direction: "LR",
      nodes: [place("A"), place("B"), place("C")],
      links: [{ mode: "create", source: "A", target: "B" }, { mode: "create", source: "A", target: "C" }],
      excerpts: [{ mode: "create", note: "B", text: long }]
    }), { nodes: [] }, undefined, CANVAS, 0);
    const c = plan.intent.nodes[2] as { x: number; y: number };
    const lane = markWorldBox(plan.intent.excerpts[0] as { x: number; y: number; width: number; text: string });
    const box = { minX: c.x - CARD_GEOMETRY.nodeWidth / 2, minY: c.y - CARD_GEOMETRY.nodeHeight / 2, maxX: c.x + CARD_GEOMETRY.nodeWidth / 2, maxY: c.y + CARD_GEOMETRY.nodeHeight / 2 };
    expect(box.minX < lane.maxX && lane.minX < box.maxX && box.minY < lane.maxY && lane.minY < box.maxY).toBe(false);
  });

  it("tidies the turn only when the full layout removes crossings, and ends the growth", () => {
    const nodes = ["A", "B", "C", "D"];
    const positions: Record<string, { x: number; y: number }> = { A: { x: 0, y: 0 }, B: { x: TB.slot, y: 0 }, C: { x: TB.slot, y: TB.rank }, D: { x: 0, y: TB.rank } };
    const growth: Growth = { canvasID: CANVAS, startedAt: 0, lastWriteAt: 0, direction: "TB", symbols: false, anchor: { x: 0, y: 0 }, regions: [],
      nodes: nodes.map((note, index) => ({ note, rank: positions[note].y / TB.rank, slot: positions[note].x / TB.slot, fixed: index === 0, ...positions[note] })) };
    const canvas = {
      nodes: nodes.map((title) => ({ id: title, title, position: positions[title] })),
      links: [{ id: "l1", sourceNodeID: "A", targetNodeID: "C" }, { id: "l2", sourceNodeID: "B", targetNodeID: "D" }]
    };
    const tidy = planGrowth(parseCanvasIntent({ canvas: "current", tidy: true }), canvas, growth, CANVAS, 1);
    expect(tidy.report).toMatchObject({ status: "ended", endedBecause: "tidy", tidy: { applied: true, crossingsBefore: 1, crossingsAfter: 0 } });
    expect(tidy.growth).toBeUndefined();
    expect(tidy.intent.nodes.some((node) => "selector" in node && node.selector === "A")).toBe(false);

    const clean = planGrowth(parseCanvasIntent({ canvas: "current", tidy: true }), { ...canvas, links: [{ id: "l1", sourceNodeID: "A", targetNodeID: "D" }] }, growth, CANVAS, 1);
    expect(clean.report?.tidy).toMatchObject({ applied: false });
    expect(clean.intent.nodes).toEqual([]);
  });
});

describe("growth with Regions", () => {
  const place = (note: string, extra: Record<string, unknown> = {}) => ({ kind: "note", mode: "place", note, ...extra });
  const pad = CARD_GEOMETRY.clusterPadding;
  const REGION_ID = "66666666-6666-4666-8666-666666666666";
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  const boxOf = (primitive: Record<string, any>): Box => ({ minX: primitive.x - primitive.width / 2, minY: primitive.y - primitive.height / 2, maxX: primitive.x + primitive.width / 2, maxY: primitive.y + primitive.height / 2 });
  const group = (box: Box, title: string, id = REGION_ID) => ({ id, kind: "group", title, bounds: { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY } });
  const nodeBox = (x: number, y: number): Box => ({ minX: x - CARD_GEOMETRY.nodeWidth / 2, minY: y - CARD_GEOMETRY.nodeHeight / 2, maxX: x + CARD_GEOMETRY.nodeWidth / 2, maxY: y + CARD_GEOMETRY.nodeHeight / 2 });
  const boundsOf = (bounds: Record<string, number>): Box => ({ minX: bounds.x, minY: bounds.y, maxX: bounds.x + bounds.width, maxY: bounds.y + bounds.height });
  const overlaps = (a: Box, b: Box) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

  it("draws a declared Region around its first member in the declared color, then grows it with the next", () => {
    const first = planGrowth(parseCanvasIntent({ canvas: "current", regions: [{ title: "Sync layer", color: "blue" }], nodes: [place("Client", { in: "Sync layer" })] }), { nodes: [] }, undefined, CANVAS, 0);
    const created = first.intent.primitives[0] as Record<string, any>;
    expect(created).toMatchObject({ kind: "region", mode: "create", title: "Sync layer", color: "blue", x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y, width: CARD_GEOMETRY.nodeWidth + 2 * pad, height: CARD_GEOMETRY.nodeHeight + 2 * pad });
    expect(first.intent.nodes[0]).not.toHaveProperty("in");
    expect(first.report?.regions.drawn).toEqual(["Sync layer"]);

    const canvas = { nodes: [{ id: "c", title: "Client", position: { ...CANVAS_WORLD_HOME } }], diagramPrimitives: [group(boxOf(created), "Sync layer")] };
    const second = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("Queue", { in: "Sync layer" })], links: [{ mode: "create", source: "Client", target: "Queue" }] }), canvas, first.growth, CANVAS, 1);
    const queue = second.intent.nodes[0] as { x: number; y: number };
    const resized = second.intent.primitives.find((primitive) => primitive.mode === "update") as Record<string, any>;
    expect(resized).toMatchObject({ id: REGION_ID });
    const box = boxOf(resized);
    expect(box.maxY).toBeGreaterThanOrEqual(queue.y + CARD_GEOMETRY.nodeHeight / 2 + pad);
    expect(second.report?.regions.resized).toEqual(["Sync layer"]);
  });

  it("keeps a Node placed outside every Region clear of their boxes", () => {
    const region = { minX: -200, minY: 100, maxX: 200, maxY: 400 };
    const canvas = { nodes: [{ id: "a", title: "A", position: { x: 0, y: 0 } }], diagramPrimitives: [group(region, "Store")] };
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("B")], links: [{ mode: "create", source: "A", target: "B" }] }), canvas, undefined, CANVAS, 0);
    const b = plan.intent.nodes[0] as { x: number; y: number };
    const padded = nodeBox(b.x, b.y);
    expect(overlaps({ minX: padded.minX - pad, minY: padded.minY - pad, maxX: padded.maxX + pad, maxY: padded.maxY + pad }, region)).toBe(false);
    expect(plan.intent.primitives).toEqual([]);
  });

  it("grows a person's Region to take a new member when that covers nothing outside it", () => {
    const region = nodeBox(0, 0);
    const outer = { minX: region.minX - pad, minY: region.minY - pad, maxX: region.maxX + pad, maxY: region.maxY + pad };
    const canvas = { nodes: [{ id: "a", title: "A", position: { x: 0, y: 0 } }], diagramPrimitives: [group(outer, "Store")] };
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("B", { in: "Store" })], links: [{ mode: "create", source: "A", target: "B" }] }), canvas, undefined, CANVAS, 0);
    const update = plan.intent.primitives[0] as Record<string, any>;
    expect(update).toMatchObject({ kind: "region", mode: "update", id: REGION_ID });
    const b = plan.intent.nodes[0] as { x: number; y: number };
    expect(boxOf(update).minX).toBeLessThanOrEqual(outer.minX);
    expect(boxOf(update).maxY).toBeGreaterThanOrEqual(b.y + CARD_GEOMETRY.nodeHeight / 2);
  });

  it("counts a Node whose box overlaps a person's Region as a member, though its center sits outside", () => {
    const region = { minX: -200, minY: -150, maxX: 200, maxY: 150 };
    const canvas = { nodes: [{ id: "a", title: "A", position: { x: 0, y: 0 } }, { id: "edge", title: "Edge", position: { x: 250, y: 0 } }], diagramPrimitives: [group(region, "Store")] };
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("B", { in: "Store" })], links: [{ mode: "create", source: "A", target: "B" }] }), canvas, undefined, CANVAS, 0);
    const b = plan.intent.nodes[0] as { x: number; y: number };
    const update = plan.intent.primitives[0] as Record<string, any>;
    expect(update).toMatchObject({ kind: "region", mode: "update", id: REGION_ID });
    expect(boxOf(update).maxX).toBeGreaterThanOrEqual(250 + CARD_GEOMETRY.nodeWidth / 2);
    expect(boxOf(update).maxY).toBeGreaterThanOrEqual(b.y + CARD_GEOMETRY.nodeHeight / 2);
  });

  it.each(["LR", "TB"] as const)("keeps a linked member of the next Region in line growing %s, both paddings plus a margin apart", (direction) => {
    const canvas = { nodes: [] as Array<Record<string, unknown>>, links: [] as Array<Record<string, unknown>>, diagramPrimitives: [] as Array<Record<string, unknown>> };
    let growth: Growth | undefined;
    const chain = [["A", "One"], ["B", "Two"], ["C", "Three"]];
    chain.forEach(([note, region], index) => {
      const links = index === 0 ? [] : [{ mode: "create", source: chain[index - 1][0], target: note }];
      const plan = planGrowth(parseCanvasIntent({ canvas: "current", ...(index === 0 ? { direction } : {}), nodes: [place(note, { in: region })], links }), canvas, growth, CANVAS, index);
      const placed = plan.intent.nodes[0] as { x: number; y: number };
      canvas.nodes.push({ id: note, title: note, position: { x: placed.x, y: placed.y } });
      for (const link of links) canvas.links.push({ id: `l${index}`, sourceNodeID: link.source, targetNodeID: link.target });
      for (const primitive of plan.intent.primitives as Array<Record<string, any>>) {
        if (primitive.mode === "create") canvas.diagramPrimitives.push(group(boxOf(primitive), primitive.title, `0000000${index}-0000-4000-8000-000000000000`));
      }
      growth = plan.growth;
    });
    const [across, along] = direction === "LR" ? ["y", "x"] as const : ["x", "y"] as const;
    expect(new Set(canvas.nodes.map((node) => (node.position as Record<string, number>)[across])).size).toBe(1);
    const boxes = canvas.diagramPrimitives.map((primitive) => boundsOf(primitive.bounds as Record<string, number>));
    const [low, high] = along === "x" ? ["minX", "maxX"] as const : ["minY", "maxY"] as const;
    for (let index = 1; index < boxes.length; index++) expect(boxes[index][low] - boxes[index - 1][high]).toBeGreaterThanOrEqual(pad / 2);
  });

  const contains = (outer: Box, inner: Box) => inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
  const LONG = "Retries with exponential backoff and jitter, then parks the update in a dead-letter queue the operator drains by hand.";

  it("draws a Region around its member's Excerpt lane", () => {
    const plan = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("A", { in: "Store" })], excerpts: [{ mode: "create", note: "A", text: LONG }] }), { nodes: [] }, undefined, CANVAS, 0);
    const region = boxOf(plan.intent.primitives[0] as Record<string, any>);
    const excerpt = plan.intent.excerpts[0] as { x: number; y: number; width: number; text: string };
    expect(contains(region, markWorldBox(excerpt))).toBe(true);
  });

  it("grows a Region around an Excerpt its member already shows", () => {
    const first = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("A", { in: "Store" })] }), { nodes: [] }, undefined, CANVAS, 0);
    const created = boxOf(first.intent.primitives[0] as Record<string, any>);
    const lane = { x: CANVAS_WORLD_HOME.x + CARD_GEOMETRY.nodeWidth / 2 + ANNOTATION_GEOMETRY.gap, y: CANVAS_WORLD_HOME.y - CARD_GEOMETRY.nodeHeight / 2, width: ANNOTATION_GEOMETRY.width, height: 220 };
    const canvas = {
      nodes: [{ id: "a", title: "A", position: { ...CANVAS_WORLD_HOME } }],
      diagramPrimitives: [group(created, "Store")],
      excerpts: [{ id: "e1", linkedNodeID: "a", connectedNodeIDs: [], bounds: lane }]
    };
    const second = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("B", { in: "Store" })], links: [{ mode: "create", source: "A", target: "B" }] }), canvas, first.growth, CANVAS, 1);
    const update = boxOf(second.intent.primitives.find((primitive) => primitive.mode === "update") as Record<string, any>);
    expect(contains(update, { minX: lane.x, minY: lane.y, maxX: lane.x + lane.width, maxY: lane.y + lane.height })).toBe(true);
  });

  it("refuses a member its Region cannot reach without covering an outside Node", () => {
    const region = nodeBox(0, 0);
    const outer = { minX: region.minX - pad, minY: region.minY - pad, maxX: region.maxX + pad, maxY: region.maxY + pad };
    const walls = Array.from({ length: 41 }, (_unused, index) => index - 20).flatMap((step) => [
      { id: `w${step}`, title: `W${step}`, position: { x: step * TB.slot, y: TB.rank } },
      { id: `s${step}`, title: `S${step}`, position: { x: step * TB.slot, y: -TB.rank } }
    ]).concat(
      [-1, 1].map((side) => ({ id: `side${side}`, title: `Side${side}`, position: { x: side * TB.slot, y: 0 } }))
    );
    const canvas = { nodes: [{ id: "a", title: "A", position: { x: 0, y: 0 } }, ...walls], diagramPrimitives: [group(outer, "Store")] };
    expect(() => planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("B", { in: "Store" })] }), canvas, undefined, CANVAS, 0))
      .toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "region_blocked" }) }));
  });

  it("removes a Region the growth drew once its last member goes, and keeps a person's Region", () => {
    const first = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("A", { in: "Temp" })] }), { nodes: [] }, undefined, CANVAS, 0);
    const created = first.intent.primitives[0] as Record<string, any>;
    const canvas = { nodes: [{ id: "a", title: "A", position: { ...CANVAS_WORLD_HOME } }], diagramPrimitives: [group(boxOf(created), "Temp")] };
    const removal = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [{ kind: "note", mode: "remove", selector: "A" }] }), canvas, first.growth, CANVAS, 1);
    expect(removal.intent.primitives).toEqual([{ kind: "region", mode: "remove", id: REGION_ID }]);

    const kept = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [{ kind: "note", mode: "remove", selector: "A" }] }), canvas, { ...first.growth!, regions: [] }, CANVAS, 1);
    expect(kept.intent.primitives).toEqual([]);
  });

  it("ends the growth when a person reshapes one of its Regions", () => {
    const first = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("A", { in: "Temp" })] }), { nodes: [] }, undefined, CANVAS, 0);
    const box = boxOf(first.intent.primitives[0] as Record<string, any>);
    const canvas = { nodes: [{ id: "a", title: "A", position: { ...CANVAS_WORLD_HOME } }], diagramPrimitives: [group({ ...box, maxX: box.maxX + 100 }, "Temp")] };
    const next = planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("B")], links: [{ mode: "create", source: "A", target: "B" }] }), canvas, first.growth, CANVAS, 1);
    expect(next.report).toMatchObject({ status: "started", endedBecause: "moved" });
  });

  it("fails on a Region title several Regions share, naming their ids", () => {
    const other = "77777777-7777-4777-8777-777777777777";
    const canvas = { nodes: [], diagramPrimitives: [group(nodeBox(0, 0), "Store"), group(nodeBox(900, 0), "Store", other)] };
    expect(() => planGrowth(parseCanvasIntent({ canvas: "current", nodes: [place("B", { in: "Store" })] }), canvas, undefined, CANVAS, 0))
      .toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "ambiguous_selector", details: expect.objectContaining({ regions: [REGION_ID, other] }) }) }));
  });
});
