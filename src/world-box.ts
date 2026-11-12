// Axis-aligned boxes in Canvas world points, with the one overlap rule every placement and
// Region check shares: two boxes overlap when their interiors meet, so boxes that only touch
// stay apart. A Node is in a Region when its box overlaps the Region's box.

export type WorldBox = { minX: number; minY: number; maxX: number; maxY: number };
export type WorldPoint = { x: number; y: number };

const SAME_BOX_TOLERANCE = 0.5;

export function centeredBox(center: WorldPoint, width: number, height: number): WorldBox {
  return { minX: center.x - width / 2, minY: center.y - height / 2, maxX: center.x + width / 2, maxY: center.y + height / 2 };
}

/** App bounds are an origin plus a size, not a center plus a size. */
export function boundsBox(value: unknown): WorldBox | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every(finiteNumber)) return undefined;
  return { minX: x as number, minY: y as number, maxX: (x as number) + (width as number), maxY: (y as number) + (height as number) };
}

export function pointsBox(x1: number, y1: number, x2: number, y2: number): WorldBox {
  return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

export function inflate(box: WorldBox, margin: number): WorldBox {
  return { minX: box.minX - margin, minY: box.minY - margin, maxX: box.maxX + margin, maxY: box.maxY + margin };
}

export function translateBox(box: WorldBox, offset: { dx: number; dy: number }): WorldBox {
  return { minX: box.minX + offset.dx, minY: box.minY + offset.dy, maxX: box.maxX + offset.dx, maxY: box.maxY + offset.dy };
}

export function unionBoxes(boxes: WorldBox[]): WorldBox | undefined {
  if (boxes.length === 0) return undefined;
  return boxes.reduce((all, box) => ({ minX: Math.min(all.minX, box.minX), minY: Math.min(all.minY, box.minY), maxX: Math.max(all.maxX, box.maxX), maxY: Math.max(all.maxY, box.maxY) }));
}

export function boxCenter(box: WorldBox): WorldPoint {
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

export function overlaps(a: WorldBox, b: WorldBox): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** Two boxes the app reports as one, within its rounding. */
export function sameBox(a: WorldBox, b: WorldBox): boolean {
  return Math.abs(a.minX - b.minX) <= SAME_BOX_TOLERANCE && Math.abs(a.minY - b.minY) <= SAME_BOX_TOLERANCE
    && Math.abs(a.maxX - b.maxX) <= SAME_BOX_TOLERANCE && Math.abs(a.maxY - b.maxY) <= SAME_BOX_TOLERANCE;
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
