// Shared diagram spacing conventions (see skills/enso/references/diagram-design.md).
// `enso layout` compiles a canvas spec onto these steps; canvas apply forwards the result.

import { compareStrings, type CanvasSpec } from "./canvas-spec.js";
import type { CanvasIntent } from "./canvas-intent.js";
import { parseCanvasIntent } from "./canvas-intent.js";

// Two densities, one per text role. Cards carry 17pt reading text and lay out four or
// five across at zoom 1. Symbols carry 14pt diagram text under a 56pt icon, so seven
// columns fit a Mac window at zoom 1. Steps are block plus the room a link label needs.
export const CARD_GEOMETRY = {
  colStep: 300,
  rowStep: 200,
  nodeWidth: 220,
  nodeHeight: 140,
  clusterPadding: 60,
  clusterFillOpacity: 0.06
} as const;

export const SYMBOL_GEOMETRY = {
  colStep: 200,
  rowStep: 140,
  nodeWidth: 140,
  nodeHeight: 82,
  clusterPadding: 40,
  clusterFillOpacity: 0.06
} as const;

export const LAYOUT_GEOMETRY = CARD_GEOMETRY;

export type LayoutGeometry = typeof CARD_GEOMETRY | typeof SYMBOL_GEOMETRY;

export function isSymbolAppearance(appearance: string | undefined): boolean {
  return appearance !== undefined && !["card", "decision", "terminal"].includes(appearance);
}

/** Symbol density applies only when every member is a symbol; one card sets card density. */
export function layoutGeometry(spec: CanvasSpec): LayoutGeometry {
  const allSymbols = spec.members.every((member) => isSymbolAppearance(member.appearance));
  return allSymbols ? SYMBOL_GEOMETRY : CARD_GEOMETRY;
}

const ORDERING_SWEEPS = 4;

export type LayoutNode = { title: string; appearance?: string; x: number; y: number };
export type LayoutRegion = { name: string; color?: string; x: number; y: number; width: number; height: number };
export type CanvasLayout = { nodes: LayoutNode[]; regions: LayoutRegion[] };

/**
 * Layered (Sugiyama-style) placement: rank along the direction hint, order within each
 * rank to reduce crossings, then coordinates on the shared spacing steps. With clusters,
 * each cluster and each unclustered Node holds a band on the along-rank axis that stays
 * fixed across its ranks, so a cluster's members stay contiguous, and gaps open wherever
 * a region's padding meets another group, so regions never cross each other or enclose a
 * non-member. Pure and deterministic — every tie breaks on declaration order and then title.
 */
export function computeCanvasLayout(spec: CanvasSpec, spacing = 1): CanvasLayout {
  const titles = spec.members.map((member) => member.title);
  const position = new Map(titles.map((title, index) => [title, index]));
  const edges = spec.edges.map((edge) => ({ from: position.get(edge.from)!, to: position.get(edge.to)! }));
  const ranks = assignRanks(titles.length, edges);
  const clusters = clusterIndexes(spec, position);
  const layers = orderLayers(titles, edges, ranks, clusters);
  const geometry = layoutGeometry(spec);
  const nodes = spec.clusters.length === 0
    ? placeNodes(spec, layers, spacing, geometry)
    : placeGroups(spec, groupLayers(spec, layers, ranks, clusters), spacing, geometry);
  const byTitle = new Map(nodes.map((node) => [node.title, node]));
  const regions = spec.clusters.map((cluster) => {
    const members = cluster.members.map((member) => byTitle.get(member)!);
    const left = Math.min(...members.map((member) => member.x)) - geometry.nodeWidth / 2 - geometry.clusterPadding;
    const right = Math.max(...members.map((member) => member.x)) + geometry.nodeWidth / 2 + geometry.clusterPadding;
    const top = Math.min(...members.map((member) => member.y)) - geometry.nodeHeight / 2 - geometry.clusterPadding;
    const bottom = Math.max(...members.map((member) => member.y)) + geometry.nodeHeight / 2 + geometry.clusterPadding;
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

export type RegionWarning = { code: "region_overlap" | "region_contains_nonmember"; message: string; details: Record<string, unknown>; hint: string };

/**
 * Cluster regions are member bounding boxes. Layout keeps each cluster in its own band and
 * opens the gaps its padding needs, so compiled regions never cross another region or
 * enclose a non-member; this check guards that promise and any layout edited afterwards.
 * Regions placed inside one another are never compiled: a member belongs to one cluster.
 */
export function regionWarnings(spec: CanvasSpec, layout: CanvasLayout): RegionWarning[] {
  const geometry = layoutGeometry(spec);
  const owner = new Map(spec.clusters.flatMap((cluster) => cluster.members.map((member) => [member, cluster.name] as const)));
  const warnings: RegionWarning[] = [];
  layout.regions.forEach((region, index) => {
    for (const other of layout.regions.slice(index + 1)) {
      if (!boxesIntersect(region, other)) continue;
      warnings.push({
        code: "region_overlap",
        message: `Regions '${region.name}' and '${other.name}' overlap`,
        details: { regions: [region.name, other.name] },
        hint: "Redraw each region from its own members' bounds plus padding with canvas apply, moving members apart where the boxes still meet"
      });
    }
    for (const node of layout.nodes) {
      if (owner.get(node.title) === region.name) continue;
      if (!boxesIntersect(region, { x: node.x, y: node.y, width: geometry.nodeWidth, height: geometry.nodeHeight })) continue;
      warnings.push({
        code: "region_contains_nonmember",
        message: `'${node.title}' sits inside region '${region.name}' without being a member`,
        details: { region: region.name, member: node.title },
        hint: "Add it to the cluster if it belongs there; otherwise move it clear of the region or redraw the region with canvas apply"
      });
    }
  });
  return warnings;
}

export type LinkCrossing = { links: [{ from: string; to: string }, { from: string; to: string }] };

/**
 * Pairs of unrelated Links whose straight paths between Node centers cross. Links that
 * share a Node never count. The app draws curves, so this estimates the crossings its
 * diagnostics will report; pairs come in edge declaration order.
 */
export function linkCrossings(spec: CanvasSpec, layout: CanvasLayout): LinkCrossing[] {
  const at = new Map(layout.nodes.map((node) => [node.title, node]));
  const edges = spec.edges.filter((edge) => edge.from !== edge.to);
  const crossings: LinkCrossing[] = [];
  edges.forEach((edge, index) => {
    for (const other of edges.slice(index + 1)) {
      if ([other.from, other.to].some((end) => end === edge.from || end === edge.to)) continue;
      if (!segmentsCross(at.get(edge.from)!, at.get(edge.to)!, at.get(other.from)!, at.get(other.to)!)) continue;
      crossings.push({ links: [{ from: edge.from, to: edge.to }, { from: other.from, to: other.to }] });
    }
  });
  return crossings;
}

type Point = { x: number; y: number };

/** Proper crossing only: segments that touch or run collinear do not count. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point): number => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

type CenteredBox = { x: number; y: number; width: number; height: number };

function boxesIntersect(a: CenteredBox, b: CenteredBox): boolean {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2;
}

/** Compile a canvas spec into an apply patch with final create geometry. */
// Spacing scales the distance between node centers and nothing else, so every extra
// point goes into the gaps where link labels render. Node and region sizes stay fixed.
export function compileCanvasSpec(spec: CanvasSpec, spacing = 1): CanvasIntent {
  const layout = computeCanvasLayout(spec, spacing);
  return parseCanvasIntent({
    canvas: spec.canvas,
    nodes: layout.nodes.map((node) => ({ kind: "note", mode: "place", note: node.title, x: node.x, y: node.y, ...(node.appearance === undefined ? {} : { appearance: node.appearance }) })),
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
      fillOpacity: layoutGeometry(spec).clusterFillOpacity
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

  const forwardOut = outgoing.map((indexes) => indexes.filter((index) => !backEdges.has(index)));
  const indegree = new Array<number>(count).fill(0);
  for (const indexes of forwardOut) for (const index of indexes) indegree[edges[index].to] += 1;
  const ranks = new Array<number>(count).fill(0);
  // Each rank is the max over its predecessors, and a node is processed only once every
  // predecessor has been, so the ranks hold whatever order the queue drains in.
  const ready = indegree.flatMap((degree, node) => degree === 0 ? [node] : []);
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const node = ready[cursor];
    for (const index of forwardOut[node]) {
      const next = edges[index].to;
      ranks[next] = Math.max(ranks[next], ranks[node] + 1);
      indegree[next] -= 1;
      if (indegree[next] === 0) ready.push(next);
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

/** Centered placement for a spec without clusters: each rank centered on its own. */
function placeNodes(spec: CanvasSpec, layers: number[][], spacing: number, geometry: LayoutGeometry): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  layers.forEach((layer, rank) => {
    layer.forEach((node, order) => {
      const along = (order - (layer.length - 1) / 2) * spacing * (spec.direction === "TB" ? geometry.colStep : geometry.rowStep);
      const across = (rank - (layers.length - 1) / 2) * spacing * (spec.direction === "TB" ? geometry.rowStep : geometry.colStep);
      const member = spec.members[node];
      nodes.push({
        title: member.title,
        ...(member.appearance === undefined ? {} : { appearance: member.appearance }),
        x: spec.direction === "TB" ? along : across,
        y: spec.direction === "TB" ? across : along
      });
    });
  });
  return nodes;
}

type Group = { cluster: boolean; low: number; high: number; slots: number; ideal: number; byRank: Map<number, number[]> };

/**
 * One group per cluster and per unclustered Node, ordered by its members' mean centered
 * position after the sweeps. Ties break on the first-declared member, then its title.
 * Within a group, each rank keeps the sweep order, then title.
 */
function groupLayers(spec: CanvasSpec, layers: number[][], ranks: number[], clusters: number[]): Group[] {
  const centered = new Array<number>(ranks.length);
  layers.forEach((layer) => layer.forEach((node, order) => { centered[node] = order - (layer.length - 1) / 2; }));
  const memberSets: number[][] = spec.clusters.map(() => []);
  const singles: number[][] = [];
  ranks.forEach((_rank, node) => {
    if (clusters[node] < spec.clusters.length) memberSets[clusters[node]].push(node);
    else singles.push([node]);
  });
  const title = (node: number): string => spec.members[node].title;
  const groups = [...memberSets.map((members) => ({ members, cluster: true })), ...singles.map((members) => ({ members, cluster: false }))]
    .map(({ members, cluster }) => {
      const byRank = new Map<number, number[]>();
      for (const node of [...members].sort((a, b) => centered[a] - centered[b] || compareStrings(title(a), title(b)))) {
        byRank.set(ranks[node], [...(byRank.get(ranks[node]) ?? []), node]);
      }
      const memberRanks = members.map((node) => ranks[node]);
      return {
        cluster,
        low: Math.min(...memberRanks),
        high: Math.max(...memberRanks),
        slots: Math.max(...[...byRank.values()].map((nodes) => nodes.length)),
        ideal: members.reduce((total, node) => total + centered[node], 0) / members.length,
        byRank,
        first: Math.min(...members)
      };
    });
  groups.sort((a, b) => a.ideal - b.ideal || a.first - b.first || compareStrings(title(a.first), title(b.first)));
  return groups.map(({ first: _first, ...group }) => group);
}

/**
 * Band placement for a spec with clusters. Each group keeps one band on the along-rank
 * axis across every rank it spans, taken in group order at the free offset nearest its
 * ideal position (snapped to half a step), clear of every placed group whose rank range meets its own. Bands sit
 * a step apart, widened to two paddings plus a margin beside a cluster; ranks widen the
 * same way where a cluster ends and an overlapping group begins on the next rank. The
 * whole drawing is centered at the end, not each rank.
 */
function placeGroups(spec: CanvasSpec, groups: Group[], spacing: number, geometry: LayoutGeometry): LayoutNode[] {
  const vertical = spec.direction === "TB";
  const alongStep = spacing * (vertical ? geometry.colStep : geometry.rowStep);
  const acrossStep = spacing * (vertical ? geometry.rowStep : geometry.colStep);
  const alongSize = vertical ? geometry.nodeWidth : geometry.nodeHeight;
  const acrossSize = vertical ? geometry.nodeHeight : geometry.nodeWidth;
  const padding = geometry.clusterPadding;
  const clearance = (step: number, size: number, a: Group, b: Group): number => {
    const sides = Number(a.cluster) + Number(b.cluster);
    return sides === 0 ? step - size : Math.max(step - size, sides * padding + padding / 2);
  };
  const width = (group: Group): number => (group.slots - 1) * alongStep + alongSize;
  const placed: Array<{ group: Group; center: number }> = [];
  for (const group of groups) {
    const rivals = placed.filter(({ group: other }) => other.low <= group.high && group.low <= other.high);
    const reach = (other: Group): number => (width(group) + width(other)) / 2 + clearance(alongStep, alongSize, group, other);
    const ideal = Math.round(group.ideal * 2) / 2 * alongStep;
    const free = (center: number): boolean => rivals.every(({ group: other, center: at }) => Math.abs(center - at) >= reach(other));
    const center = [ideal, ...rivals.flatMap(({ group: other, center: at }) => [at - reach(other), at + reach(other)])]
      .filter(free)
      .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal) || a - b)[0];
    placed.push({ group, center });
  }

  const rankCount = Math.max(...groups.map((group) => group.high)) + 1;
  const extent = ({ group, center }: { group: Group; center: number }): [number, number] => {
    const reach = width(group) / 2 + (group.cluster ? padding : 0);
    return [center - reach, center + reach];
  };
  const acrossAt = [0];
  for (let rank = 0; rank < rankCount - 1; rank++) {
    let gap = acrossStep - acrossSize;
    for (const ending of placed.filter(({ group }) => group.high === rank)) {
      for (const starting of placed.filter(({ group }) => group.low === rank + 1)) {
        const [endLow, endHigh] = extent(ending);
        const [startLow, startHigh] = extent(starting);
        if (endLow < startHigh && startLow < endHigh) gap = Math.max(gap, clearance(acrossStep, acrossSize, ending.group, starting.group));
      }
    }
    acrossAt.push(acrossAt[rank] + acrossSize + gap);
  }

  const spots = placed.flatMap(({ group, center }) => [...group.byRank].flatMap(([rank, members]) =>
    members.map((node, order) => ({ node, rank, along: center + (order - (members.length - 1) / 2) * alongStep, across: acrossAt[rank] }))));
  const middle = (values: number[]): number => (Math.min(...values) + Math.max(...values)) / 2;
  const alongMiddle = middle(spots.map((spot) => spot.along));
  const acrossMiddle = middle(spots.map((spot) => spot.across));
  return spots
    .sort((a, b) => a.rank - b.rank || a.along - b.along)
    .map(({ node, along, across }) => {
      const member = spec.members[node];
      return {
        title: member.title,
        ...(member.appearance === undefined ? {} : { appearance: member.appearance }),
        x: (vertical ? along - alongMiddle : across - acrossMiddle) + 0,
        y: (vertical ? across - acrossMiddle : along - alongMiddle) + 0
      };
    });
}
