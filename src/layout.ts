// Shared diagram spacing conventions (see skills/enso/references/diagram-design.md).
// `enso layout` compiles a canvas spec onto these steps; canvas apply forwards the result.

import { compareStrings, type CanvasSpec } from "./canvas-spec.js";
import type { CanvasIntent } from "./canvas-intent.js";
import { parseCanvasIntent } from "./canvas-intent.js";

export const LAYOUT_GEOMETRY = {
  colStep: 450,
  rowStep: 280,
  nodeWidth: 220,
  nodeHeight: 140,
  clusterPadding: 60,
  clusterFillOpacity: 0.06
} as const;

const ORDERING_SWEEPS = 4;

export type LayoutNode = { title: string; mode: "create" | "reuse"; rank: number; order: number; x: number; y: number };
export type LayoutRegion = { name: string; color?: string; x: number; y: number; width: number; height: number };
export type CanvasLayout = { nodes: LayoutNode[]; regions: LayoutRegion[] };

/**
 * Layered (Sugiyama-style) placement: rank along the direction hint, order within each
 * rank to reduce crossings, then coordinates on the shared spacing steps. Pure and
 * deterministic — every tie breaks on declaration order and then title.
 */
export function computeCanvasLayout(spec: CanvasSpec): CanvasLayout {
  const titles = spec.members.map((member) => member.title);
  const position = new Map(titles.map((title, index) => [title, index]));
  const edges = spec.edges.map((edge) => ({ from: position.get(edge.from)!, to: position.get(edge.to)! }));
  const ranks = assignRanks(titles.length, edges);
  const layers = orderLayers(titles, edges, ranks, clusterIndexes(spec, position));
  const nodes = placeNodes(spec, layers, ranks);
  const byTitle = new Map(nodes.map((node) => [node.title, node]));
  const regions = spec.clusters.map((cluster) => {
    const members = cluster.members.map((member) => byTitle.get(member)!);
    const left = Math.min(...members.map((member) => member.x)) - LAYOUT_GEOMETRY.nodeWidth / 2 - LAYOUT_GEOMETRY.clusterPadding;
    const right = Math.max(...members.map((member) => member.x)) + LAYOUT_GEOMETRY.nodeWidth / 2 + LAYOUT_GEOMETRY.clusterPadding;
    const top = Math.min(...members.map((member) => member.y)) - LAYOUT_GEOMETRY.nodeHeight / 2 - LAYOUT_GEOMETRY.clusterPadding;
    const bottom = Math.max(...members.map((member) => member.y)) + LAYOUT_GEOMETRY.nodeHeight / 2 + LAYOUT_GEOMETRY.clusterPadding;
    return {
      name: cluster.name,
      ...(cluster.color === undefined ? {} : { color: cluster.color }),
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: right - left,
      height: bottom - top
    };
  });
  return { nodes, regions };
}

/** Compile a canvas spec into an apply patch with final create geometry. */
export function compileCanvasSpec(spec: CanvasSpec): CanvasIntent {
  const layout = computeCanvasLayout(spec);
  return parseCanvasIntent({
    canvas: spec.canvas,
    nodes: layout.nodes.map((node) => node.mode === "reuse"
      ? { kind: "note", mode: "reuse", selector: node.title, x: node.x, y: node.y }
      : { kind: "note", mode: "create", title: node.title, x: node.x, y: node.y }),
    links: spec.edges.map((edge) => ({
      mode: "create",
      source: edge.from,
      target: edge.to,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      ...(edge.color === undefined ? {} : { color: edge.color }),
      ...(edge.direction === undefined ? {} : { direction: edge.direction })
    })),
    primitives: layout.regions.map((region) => ({
      kind: "region",
      mode: "create",
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      title: region.name,
      ...(region.color === undefined ? {} : { color: region.color }),
      fillOpacity: LAYOUT_GEOMETRY.clusterFillOpacity
    }))
  });
}

type Edge = { from: number; to: number };

/** Longest-path layering over the spec graph with deterministic cycle breaking. */
function assignRanks(count: number, edges: Edge[]): number[] {
  const outgoing: number[][] = Array.from({ length: count }, () => []);
  edges.forEach((edge, index) => outgoing[edge.from].push(index));
  const state = new Array<number>(count).fill(0);
  const backEdges = new Set<number>();
  const visit = (node: number): void => {
    state[node] = 1;
    for (const index of outgoing[node]) {
      const next = edges[index].to;
      if (state[next] === 1) backEdges.add(index);
      else if (state[next] === 0) visit(next);
    }
    state[node] = 2;
  };
  for (let node = 0; node < count; node++) if (state[node] === 0) visit(node);

  const forward = edges.map((edge, index) => ({ edge, index })).filter((item) => !backEdges.has(item.index));
  const indegree = new Array<number>(count).fill(0);
  for (const item of forward) indegree[item.edge.to] += 1;
  const ranks = new Array<number>(count).fill(0);
  const ready = indegree.flatMap((degree, node) => degree === 0 ? [node] : []);
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const node = ready.shift()!;
    for (const item of forward) {
      if (item.edge.from !== node) continue;
      ranks[item.edge.to] = Math.max(ranks[item.edge.to], ranks[node] + 1);
      indegree[item.edge.to] -= 1;
      if (indegree[item.edge.to] === 0) ready.push(item.edge.to);
    }
  }
  return ranks;
}

function clusterIndexes(spec: CanvasSpec, position: Map<string, number>): number[] {
  const indexes = new Array<number>(position.size).fill(spec.clusters.length);
  spec.clusters.forEach((cluster, index) => {
    for (const member of cluster.members) indexes[position.get(member)!] = index;
  });
  return indexes;
}

/** Barycenter crossing reduction, sweeping down then up over the ranks. */
function orderLayers(titles: string[], edges: Edge[], ranks: number[], clusters: number[]): number[][] {
  const rankCount = ranks.reduce((highest, rank) => Math.max(highest, rank), 0) + 1;
  const layers: number[][] = Array.from({ length: rankCount }, () => []);
  ranks.forEach((rank, node) => layers[rank].push(node));
  const neighbours: number[][] = titles.map(() => []);
  for (const edge of edges) {
    neighbours[edge.from].push(edge.to);
    neighbours[edge.to].push(edge.from);
  }
  for (let sweep = 0; sweep < ORDERING_SWEEPS; sweep++) {
    const downward = sweep % 2 === 0;
    const order = downward
      ? Array.from({ length: rankCount - 1 }, (_unused, index) => index + 1)
      : Array.from({ length: rankCount - 1 }, (_unused, index) => rankCount - 2 - index);
    for (const rank of order) {
      const reference = downward ? rank - 1 : rank + 1;
      const positions = new Map(layers[reference].map((node, index) => [node, index]));
      const current = new Map(layers[rank].map((node, index) => [node, index]));
      const barycenters = new Map(layers[rank].map((node) => {
        const seen = neighbours[node].flatMap((neighbour) => positions.has(neighbour) ? [positions.get(neighbour)!] : []);
        const average = seen.length > 0 ? seen.reduce((total, value) => total + value, 0) / seen.length : current.get(node)!;
        return [node, average];
      }));
      layers[rank] = [...layers[rank]].sort((a, b) =>
        barycenters.get(a)! - barycenters.get(b)!
        || clusters[a] - clusters[b]
        || compareStrings(titles[a], titles[b]));
    }
  }
  return layers;
}

function placeNodes(spec: CanvasSpec, layers: number[][], ranks: number[]): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  layers.forEach((layer, rank) => {
    layer.forEach((node, order) => {
      const along = (order - (layer.length - 1) / 2) * (spec.direction === "TB" ? LAYOUT_GEOMETRY.colStep : LAYOUT_GEOMETRY.rowStep);
      const across = (rank - (layers.length - 1) / 2) * (spec.direction === "TB" ? LAYOUT_GEOMETRY.rowStep : LAYOUT_GEOMETRY.colStep);
      const member = spec.members[node];
      nodes.push({
        title: member.title,
        mode: member.mode,
        rank: ranks[node],
        order,
        x: spec.direction === "TB" ? along : across,
        y: spec.direction === "TB" ? across : along
      });
    });
  });
  return nodes;
}
