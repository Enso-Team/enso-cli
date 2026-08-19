import { z } from "zod";

export const linkDirectionSchema = z.enum(["directed", "undirected", "bidirectional"]);
export type LinkDirection = z.infer<typeof linkDirectionSchema>;

// Mirrors Link.visualUIColor in the app (Enso/Models/Data Models/Link.swift): a #RGB,
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

export const primaryBindingStatusSchema = z.enum(["bound", "unbound", "unresolved"]);
export type PrimaryBindingStatus = z.infer<typeof primaryBindingStatusSchema>;

export const primaryBindingSchema = z.object({
  status: primaryBindingStatusSchema,
  lastKnownRelationText: z.string().optional()
});
export type PrimaryBinding = z.infer<typeof primaryBindingSchema>;

export const linkSchema = z.object({
  id: z.string(),
  sourceNodeID: z.string(),
  targetNodeID: z.string(),
  label: z.string().nullable(),
  type: z.string(),
  isUnbound: z.boolean(),
  primaryBinding: primaryBindingSchema.nullable().optional(),
  direction: linkDirectionSchema.optional(),
  color: z.string().optional()
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
  boundLine?: string;
  color?: string;
  direction?: LinkDirection;
  syncProse?: boolean;
  dryRun?: boolean;
};

const WIKILINK_PATTERN = /\[\[[^\]]+\]\]/;

export function assertBoundLineHasWikilink(boundLine: string): void {
  if (!WIKILINK_PATTERN.test(boundLine)) {
    throw new Error("bound line must include a target wikilink like [[Target Title]]");
  }
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
  if (options.color !== undefined) body.color = options.color;
  if (options.direction !== undefined) body.direction = options.direction;
  return body;
}

export function buildLinkUpdateBody(options: LinkUpdateOptions): Record<string, unknown> {
  if (options.clearLabel && options.label !== undefined) {
    throw new Error("Cannot use --label and --clear-label together");
  }
  if (options.syncProse && options.boundLine !== undefined) {
    throw new Error("Cannot use --sync-prose and --bound-line together");
  }
  if (options.clearLabel && options.syncProse) {
    throw new Error("Cannot use --clear-label and --sync-prose together");
  }

  const body: Record<string, unknown> = { dryRun: Boolean(options.dryRun) };

  if (options.clearLabel) {
    body.label = null;
  } else if (options.label !== undefined) {
    body.label = options.label;
  }

  if (options.color !== undefined) body.color = options.color;
  if (options.direction !== undefined) body.direction = options.direction;
  if (options.syncProse) body.syncProse = true;
  if (options.boundLine !== undefined) {
    assertBoundLineHasWikilink(options.boundLine);
    body.boundLine = options.boundLine;
  }

  return body;
}

export const linkUpdateOperationSchema = z.object({
  type: z.literal("link.update"),
  id: z.string(),
  label: z.string().nullable().optional(),
  boundLine: z.string().optional(),
  syncProse: z.boolean().optional(),
  color: z.string().optional(),
  direction: linkDirectionSchema.optional()
});

export type LinkUpdateOperation = z.infer<typeof linkUpdateOperationSchema>;

export function validateLinkUpdateOperation(op: LinkUpdateOperation): void {
  if (op.syncProse && op.boundLine !== undefined) {
    throw new Error("link.update cannot set both syncProse and boundLine");
  }
  if (op.label === null && op.syncProse) {
    throw new Error("link.update cannot set both label: null and syncProse");
  }
  if (op.boundLine !== undefined) {
    assertBoundLineHasWikilink(op.boundLine);
  }
}
