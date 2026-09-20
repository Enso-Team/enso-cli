import { z } from "zod";

export const linkDirectionSchema = z.enum(["directed", "undirected", "bidirectional"]);
export type LinkDirection = z.infer<typeof linkDirectionSchema>;

// Mirrors the released Enso app's visual color grammar: a #RGB,
// #RRGGBB, or #RRGGBBAA hex value, or one of these names, matched case-insensitively.
export const VISUAL_COLOR_NAMES = [
  "black", "blue", "cyan", "gray", "green", "grey", "orange", "pink", "purple", "red", "teal", "white", "yellow"
] as const;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isVisualColor(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("#")) return HEX_COLOR_PATTERN.test(trimmed);
  return (VISUAL_COLOR_NAMES as readonly string[]).includes(trimmed.toLowerCase());
}

export const VISUAL_COLOR_GRAMMAR = `#RGB, #RRGGBB, #RRGGBBAA, or one of ${VISUAL_COLOR_NAMES.join(", ")}`;

export const visualColorSchema = z.string().refine(isVisualColor, {
  message: `color must be ${VISUAL_COLOR_GRAMMAR}`
});

export function assertVisualColor(value: string): void {
  if (!isVisualColor(value)) throw new Error(`color must be ${VISUAL_COLOR_GRAMMAR}`);
}

/** A World-space point, the shape every bridge coordinate object takes. */
export const worldPointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export type WorldPoint = z.infer<typeof worldPointSchema>;

export const linkSchema = z.object({
  id: z.string(),
  sourceNodeID: z.string(),
  targetNodeID: z.string(),
  label: z.string().nullable(),
  type: z.string(),
  /** What the curve shows: the label override, else the first mentioning sentence minus its token. */
  displayLabel: z.string().nullable().optional(),
  /** Every sentence in the source Note that mentions the target. */
  mentions: z.array(z.string()).optional(),
  direction: linkDirectionSchema.optional(),
  color: z.string().optional(),
  targetPosition: worldPointSchema.optional()
});
export type Link = z.infer<typeof linkSchema>;

export type LinkCreateBody = {
  source: string;
  target: string;
  label?: string;
  color?: string;
  direction?: LinkDirection;
  dryRun: boolean;
};

export type LinkUpdateOptions = {
  label?: string;
  clearLabel?: boolean;
  color?: string;
  direction?: LinkDirection;
  source?: string;
  target?: string;
  delink?: boolean;
  targetPosition?: WorldPoint;
  dryRun?: boolean;
};

/**
 * One operation moves one end of a Link. `source` re-sources the tail, `target` re-targets
 * the head, and `target: null` delinks the head into open space, optionally at
 * `targetPosition`. The bridge edits the first mention for every move (ADR-0008).
 */
export type LinkEndpointMove = { source: string } | { target: string } | { target: null; targetPosition?: WorldPoint };

export function linkEndpointMove(options: LinkUpdateOptions): LinkEndpointMove | undefined {
  const moves = [options.source !== undefined, options.target !== undefined, Boolean(options.delink)].filter(Boolean).length;
  if (moves > 1) throw new Error("Choose one of --source, --target, or --delink");
  if (options.targetPosition !== undefined && !options.delink) {
    throw new Error("--target-position only applies with --delink");
  }
  if (moves === 0) return undefined;
  if (options.source !== undefined) return { source: options.source };
  if (options.target !== undefined) return { target: options.target };
  return options.targetPosition === undefined ? { target: null } : { target: null, targetPosition: options.targetPosition };
}

/** Parses `x,y` from a flag value into a World-space point. */
export function parseWorldPoint(value: string): WorldPoint {
  const parts = value.split(",").map((part) => part.trim());
  const [x, y] = parts.map(Number);
  if (parts.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("expected a World-space point as x,y such as 320,-180");
  }
  return { x, y };
}

export function buildLinkCreateBody(
  source: string,
  target: string,
  options: Omit<LinkCreateBody, "source" | "target" | "dryRun"> & { dryRun?: boolean }
): LinkCreateBody {
  const body: LinkCreateBody = {
    source,
    target,
    dryRun: Boolean(options.dryRun)
  };
  if (options.label !== undefined) body.label = options.label;
  if (options.color !== undefined) {
    assertVisualColor(options.color);
    body.color = options.color;
  }
  if (options.direction !== undefined) body.direction = options.direction;
  return body;
}

export function buildLinkUpdateBody(options: LinkUpdateOptions): Record<string, unknown> {
  if (options.clearLabel && options.label !== undefined) {
    throw new Error("Cannot use --label and --clear-label together");
  }

  const body: Record<string, unknown> = { dryRun: Boolean(options.dryRun) };
  Object.assign(body, linkEndpointMove(options));

  if (options.clearLabel) {
    body.label = null;
  } else if (options.label !== undefined) {
    body.label = options.label;
  }

  if (options.color !== undefined) {
    assertVisualColor(options.color);
    body.color = options.color;
  }
  if (options.direction !== undefined) body.direction = options.direction;

  return body;
}

export const linkUpdateOperationSchema = z.object({
  type: z.literal("link.update"),
  id: z.string(),
  label: z.string().nullable().optional(),
  color: visualColorSchema.optional(),
  direction: linkDirectionSchema.optional(),
  source: z.string().optional(),
  target: z.string().nullable().optional(),
  targetPosition: worldPointSchema.optional()
});

export type LinkUpdateOperation = z.infer<typeof linkUpdateOperationSchema>;

export function validateLinkUpdateOperation(op: LinkUpdateOperation): void {
  validateLinkEndpointMove(op);
}

/** The refusals the bridge applies to an endpoint move, checked before any bytes leave. */
export function validateLinkEndpointMove(op: { source?: string; target?: string | null; targetPosition?: WorldPoint }): void {
  if (op.source !== undefined && op.target !== undefined) {
    throw new Error("link.update cannot move source and target in one operation");
  }
  if (op.targetPosition !== undefined && op.target !== null) {
    throw new Error("link.update targetPosition only applies when target is null");
  }
}
