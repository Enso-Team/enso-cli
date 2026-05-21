import { z } from "zod";

export const linkDirectionSchema = z.enum(["directed", "undirected", "bidirectional"]);
export type LinkDirection = z.infer<typeof linkDirectionSchema>;

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
  if (op.boundLine !== undefined) {
    assertBoundLineHasWikilink(op.boundLine);
  }
}
