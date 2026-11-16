import { z } from "zod/v3";

export const linkDirectionSchema = z.enum(["directed", "undirected", "bidirectional"]);
export type LinkDirection = z.infer<typeof linkDirectionSchema>;
export const lineStyleSchema = z.enum(["solid", "dashed", "dotted"]);
export type LineStyle = z.infer<typeof lineStyleSchema>;

export function parseLineStyle(value: string): LineStyle {
  return lineStyleSchema.parse(value);
}

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
  lineStyle: lineStyleSchema.optional(),
  color: z.string().optional(),
  labelFontSize: z.number().optional(),
  targetPosition: worldPointSchema.optional()
});
export type Link = z.infer<typeof linkSchema>;

/** Label size in World points. New Links default to 12 in the app, one step under a 14pt symbol title. */
export const LABEL_FONT_SIZE_RANGE = { min: 8, max: 32 } as const;
export const labelFontSizeSchema = z.number().min(LABEL_FONT_SIZE_RANGE.min).max(LABEL_FONT_SIZE_RANGE.max);

export const linkUpdateOperationSchema = z.object({
  type: z.literal("link.update"),
  id: z.string(),
  label: z.string().nullable().optional(),
  color: visualColorSchema.optional(),
  direction: linkDirectionSchema.optional(),
  lineStyle: lineStyleSchema.optional(),
  labelFontSize: labelFontSizeSchema.optional(),
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
