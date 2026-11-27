import { LABEL_FONT_SIZE_RANGE, assertVisualColor, parseLineStyle, type LineStyle, type LinkDirection, type WorldPoint } from "@enso-app/core";

export function parseLabelFontSize(value: string): number {
  const size = Number(value);
  if (!Number.isFinite(size) || size < LABEL_FONT_SIZE_RANGE.min || size > LABEL_FONT_SIZE_RANGE.max) {
    throw new Error(`label font size must be a number between ${LABEL_FONT_SIZE_RANGE.min} and ${LABEL_FONT_SIZE_RANGE.max}`);
  }
  return size;
}

export function parseMentionIndex(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) throw new Error("mention index must be a whole number from 0");
  return index;
}

export type LinkCreateBody = {
  source: string;
  target: string;
  mentionIndex?: number;
  label?: string;
  color?: string;
  direction?: LinkDirection;
  lineStyle?: LineStyle;
  labelFontSize?: number;
  dryRun: boolean;
};

export type LinkCreateOptions = Omit<LinkCreateBody, "source" | "target" | "dryRun" | "labelFontSize" | "mentionIndex"> & { labelFontSize?: number | string; mentionIndex?: number | string; dryRun?: boolean };

export type LinkUpdateOptions = {
  label?: string;
  clearLabel?: boolean;
  color?: string;
  direction?: LinkDirection;
  lineStyle?: LineStyle;
  labelFontSize?: number | string;
  mentionIndex?: number | string;
  source?: string;
  target?: string;
  delink?: boolean;
  targetPosition?: WorldPoint;
  dryRun?: boolean;
};

/**
 * One operation moves one end of a Link. `source` re-sources the tail, `target` re-targets
 * the head, and `target: null` delinks the head into open space, optionally at
 * `targetPosition`. The bridge edits the Link's own mention for every move (ADR-0008).
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
  options: LinkCreateOptions
): LinkCreateBody {
  const body: LinkCreateBody = {
    source,
    target,
    dryRun: Boolean(options.dryRun)
  };
  if (options.mentionIndex !== undefined) body.mentionIndex = parseMentionIndex(String(options.mentionIndex));
  if (options.label !== undefined) body.label = options.label;
  if (options.color !== undefined) {
    assertVisualColor(options.color);
    body.color = options.color;
  }
  if (options.direction !== undefined) body.direction = options.direction;
  if (options.lineStyle !== undefined) body.lineStyle = parseLineStyle(options.lineStyle);
  if (options.labelFontSize !== undefined) body.labelFontSize = parseLabelFontSize(String(options.labelFontSize));
  return body;
}

export function buildLinkUpdateBody(options: LinkUpdateOptions): Record<string, unknown> {
  if (options.clearLabel && options.label !== undefined) {
    throw new Error("Cannot use --label and --clear-label together");
  }

  const body: Record<string, unknown> = { dryRun: Boolean(options.dryRun) };
  const move = linkEndpointMove(options);
  Object.assign(body, move);

  if (options.mentionIndex !== undefined) {
    if (move !== undefined) throw new Error("Choose the mention after moving an endpoint");
    body.mentionIndex = parseMentionIndex(String(options.mentionIndex));
  }

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
  if (options.lineStyle !== undefined) body.lineStyle = parseLineStyle(options.lineStyle);
  if (options.labelFontSize !== undefined) body.labelFontSize = parseLabelFontSize(String(options.labelFontSize));

  return body;
}
