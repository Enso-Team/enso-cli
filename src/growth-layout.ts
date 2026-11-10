// Incremental placement for a diagram an agent builds one write at a time. Every Node the
// growth tracks holds a spot: a rank along the direction and a slot across it, in grid
// steps from the turn's anchor. A new Node takes the free spot nearest its neighbors.
// Placed Nodes keep their rank and their order within it, so the diagram grows instead of
// re-sorting, and the Nodes next to new work drift at most half a step toward it.

export type GrowthSpot = { rank: number; slot: number };
export type GrowthNode = GrowthSpot & { fixed: boolean };
export type GrowthEdge = { from: string; to: string };
/** Whether `key` may not stand at `spot`, given where every placed Node stands so far. */
export type SpotTaken = (spot: GrowthSpot, key: string, placed: ReadonlyMap<string, GrowthNode>) => boolean;

/** A Node with no free spot within reach, such as a Region member hemmed in by outsiders. */
export class GrowthBlocked extends Error {
  constructor(readonly key: string) {
    super(`No free spot for '${key}'`);
  }
}

/** How far a placed Node drifts toward its neighbors on one write, in grid steps. */
export const DRIFT_LIMIT = 0.5;
const HALF = 0.5;
const SEARCH_LIMIT = 200;
const RANK_FALLBACK = 6;

/**
 * Place `added` Nodes into `previous` and drift the Nodes the new work touches.
 * `fixed` Nodes never move. A rerun with nothing added and no new edge moves nothing.
 * A Node with `peers`, such as the other members of its Region, lands near the placed ones.
 */
export function growLayout(
  previous: ReadonlyMap<string, GrowthNode>,
  added: Array<{ key: string; fixed?: GrowthSpot; peers?: string[] }>,
  edges: GrowthEdge[],
  newEdges: GrowthEdge[] = [],
  taken: SpotTaken = () => false
): Map<string, GrowthNode> {
  const next = new Map([...previous].map(([key, node]) => [key, { ...node }]));
  const neighbours = adjacency(edges);
  for (const { key, fixed } of added) if (fixed) next.set(key, { ...fixed, fixed: true });

  const pending = added.filter(({ key, fixed }) => !fixed && !next.has(key)).map(({ key }) => key);
  while (pending.length > 0) {
    const index = Math.max(0, pending.findIndex((key) => (neighbours.get(key) ?? []).some((other) => next.has(other))));
    const [key] = pending.splice(index, 1);
    const peers = added.find((item) => item.key === key)?.peers ?? [];
    const peerSpots = peers.flatMap((other) => next.has(other) ? [next.get(other)!] : []);
    const desired = desiredSpot(key, next, edges, neighbours, peers);
    next.set(key, { ...freeSpot(key, next, desired, taken, peerSpots), fixed: false });
  }

  const touched = new Set<string>();
  for (const { key } of added) for (const other of neighbours.get(key) ?? []) touched.add(other);
  for (const edge of newEdges) { touched.add(edge.from); touched.add(edge.to); }
  for (const { key } of added) touched.delete(key);
  for (const key of [...next.keys()].filter((candidate) => touched.has(candidate))) drift(key, next, neighbours, taken);
  return next;
}

/** A new Node sits one rank past its placed sources, or one before its placed targets. */
function desiredSpot(key: string, placed: Map<string, GrowthNode>, edges: GrowthEdge[], neighbours: Map<string, string[]>, peers: string[]): GrowthSpot {
  const sources = edges.flatMap((edge) => edge.to === key && placed.has(edge.from) ? [placed.get(edge.from)!] : []);
  const targets = edges.flatMap((edge) => edge.from === key && placed.has(edge.to) ? [placed.get(edge.to)!] : []);
  const rank = sources.length > 0
    ? Math.max(...sources.map((node) => node.rank)) + 1
    : targets.length > 0 ? Math.min(...targets.map((node) => node.rank)) - 1 : 0;
  const placedPeers = peers.flatMap((other) => placed.has(other) ? [placed.get(other)!.slot] : []);
  const slots = placedPeers.length > 0 ? placedPeers : (neighbours.get(key) ?? []).flatMap((other) => placed.has(other) ? [placed.get(other)!.slot] : []);
  if (slots.length > 0) return { rank, slot: roundHalf(median(slots)) };
  const inRank = [...placed.values()].filter((node) => node.rank === rank).map((node) => node.slot);
  return { rank, slot: inRank.length === 0 ? 0 : Math.max(...inRank) + 1 };
}

/**
 * The nearest spot in the rank a full step clear of its peers, preferring the far side on a
 * tie. When the whole rank is blocked, the Node drops a rank at a time and its Links stretch.
 * A Node with group peers, such as Region members, then tries the ranks they hold, so its
 * Link points back rather than its Region stretching over everything in between.
 */
function freeSpot(key: string, placed: Map<string, GrowthNode>, desired: GrowthSpot, taken: SpotTaken, peers: GrowthSpot[] = []): GrowthSpot {
  const dropped = Array.from({ length: RANK_FALLBACK + 1 }, (_unused, drop) => ({ rank: desired.rank + drop, slot: desired.slot }));
  const peerRanks = [...new Set(peers.flatMap((peer) => [peer.rank, peer.rank + 1]))]
    .sort((a, b) => Math.abs(a - desired.rank) - Math.abs(b - desired.rank) || a - b)
    .map((rank) => ({ rank, slot: roundHalf(median(peers.map((peer) => peer.slot))) }));
  for (const candidate of [...dropped, ...peerRanks]) {
    const inRank = [...placed.values()].filter((node) => node.rank === candidate.rank).map((node) => node.slot);
    const free = (slot: number): boolean => inRank.every((peer) => Math.abs(peer - slot) >= 1) && !taken({ rank: candidate.rank, slot }, key, placed);
    for (let step = 0; step <= SEARCH_LIMIT; step++) {
      for (const slot of step === 0 ? [candidate.slot] : [candidate.slot + step * HALF, candidate.slot - step * HALF]) {
        if (free(slot)) return { rank: candidate.rank, slot };
      }
    }
  }
  throw new GrowthBlocked(key);
}

/** Move a placed Node up to the drift limit toward its neighbors' median slot, never past a peer. */
function drift(key: string, placed: Map<string, GrowthNode>, neighbours: Map<string, string[]>, taken: SpotTaken): void {
  const node = placed.get(key)!;
  if (node.fixed) return;
  const slots = (neighbours.get(key) ?? []).flatMap((other) => placed.has(other) ? [placed.get(other)!.slot] : []);
  if (slots.length === 0) return;
  const step = roundHalf(Math.max(-DRIFT_LIMIT, Math.min(DRIFT_LIMIT, median(slots) - node.slot)));
  if (step === 0) return;
  const slot = node.slot + step;
  const clear = [...placed].every(([other, peer]) => other === key || peer.rank !== node.rank || Math.abs(peer.slot - slot) >= 1);
  if (clear && !taken({ rank: node.rank, slot }, key, placed)) placed.set(key, { ...node, slot });
}

function adjacency(edges: GrowthEdge[]): Map<string, string[]> {
  const neighbours = new Map<string, string[]>();
  for (const { from, to } of edges) {
    if (from === to) continue;
    neighbours.set(from, [...(neighbours.get(from) ?? []), to]);
    neighbours.set(to, [...(neighbours.get(to) ?? []), from]);
  }
  return neighbours;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundHalf(value: number): number {
  return Math.round(value / HALF) * HALF + 0;
}
