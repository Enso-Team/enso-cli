import { z } from "zod";
import { EnsoCliError, type EnsoEnvelope } from "./errors.js";

// A Mark is canvas-owned writing: typed text an agent or person places on the Canvas, or
// handwriting a person draws. It labels, decorates, or expands on the Canvas without being a
// concept, so it has no Note file. Agents write typed Marks only.

export const MARK_DEFAULT_FONT_SIZE = 17;
export const markFontSizeSchema = z.number().finite().min(8).max(96);

export const markStyleSchema = z.enum(["bold", "italic", "highlight", "strikethrough", "code"]);

/** A styled range of Mark text, in UTF-16 code units, which is JavaScript string indexing. */
export const markTextRunSchema = z.object({
  location: z.number().int().min(0),
  length: z.number().int().positive(),
  styles: z.array(markStyleSchema).min(1)
}).strict();
export type MarkTextRun = z.infer<typeof markTextRunSchema>;

export const markTextSchema = z.string().refine((value) => value.trim().length > 0, "mark text must contain a nonblank character");

/** Typed text wraps at this World width when the Mark sets none. Source: MarkTextLayout.maxNaturalWidthWorld. */
export const MARK_NATURAL_WIDTH = 420;
/** World height of one line of Mark text. Source: MarkTextLayout.lineHeightWorld. */
export const MARK_LINE_HEIGHT = 17 * 1.35;

export function runsOutsideText(text: string, runs: MarkTextRun[]): boolean {
  return runs.some((run) => run.location + run.length > text.length);
}

export function parseMarkTextRuns(value: string): MarkTextRun[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("expected a JSON array of {location, length, styles}");
  }
  const parsed = z.array(markTextRunSchema).safeParse(decoded);
  if (!parsed.success) throw new Error(`expected {location, length, styles} ranges with styles from ${markStyleSchema.options.join(", ")}`);
  return parsed.data;
}

/**
 * World box a typed Mark can occupy: its top-left origin, its wrap width, and an estimate of
 * the lines its text wraps onto. The app measures the real block. This errs toward larger.
 */
export function markWorldBox(mark: { x: number; y: number; width?: number | null; fontSize?: number; text?: string }): { minX: number; minY: number; maxX: number; maxY: number } {
  const width = mark.width ?? MARK_NATURAL_WIDTH;
  const perLine = Math.max(1, Math.floor(width / ((mark.fontSize ?? MARK_DEFAULT_FONT_SIZE) * 0.6)));
  const lines = (mark.text ?? "").split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return { minX: mark.x, minY: mark.y, maxX: mark.x + width, maxY: mark.y + Math.max(1, lines) * (mark.fontSize ?? MARK_DEFAULT_FONT_SIZE) * 1.35 };
}

export function marksUnsupported(details: Record<string, unknown> = {}): EnsoCliError {
  return new EnsoCliError("app_outdated", "The Enso app does not support Marks yet", {
    ...details,
    hint: "Update the Enso app"
  });
}

/**
 * An app that predates Marks answers their routes with its generic missing-route error. A
 * missing Mark or Node carries its own message and passes through.
 */
export function requireMarkSupport(envelope: EnsoEnvelope): EnsoEnvelope {
  if (!envelope.ok && envelope.error.code === "not_found" && envelope.error.message === "Bridge route not found") {
    throw marksUnsupported(envelope.error.details ?? {});
  }
  return envelope;
}
