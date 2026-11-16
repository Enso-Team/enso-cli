import { InvalidArgumentError } from "commander";
import { nodeAppearanceSchema, nodeFontSizeSchema, nodeGlyphSizeSchema, nodeTitleGapSchema } from "@enso-app/core";


export function parseNodeAppearance(value: string): string {
  const result = nodeAppearanceSchema.safeParse(value);
  if (!result.success) throw new InvalidArgumentError(`Appearance must be one of: ${nodeAppearanceSchema.options.join(", ")}`);
  return result.data;
}


export function parseGlyphSize(value: string): number {
  const size = Number(value);
  if (!nodeGlyphSizeSchema.safeParse(size).success) throw new InvalidArgumentError("Glyph size must be 24–160 World points");
  return size;
}

export function parseFontSize(value: string): number {
  const size = Number(value);
  if (!nodeFontSizeSchema.safeParse(size).success) throw new InvalidArgumentError("Font size must be 8–96 World points");
  return size;
}


export function parseTitleGap(value: string): number {
  const gap = Number(value);
  if (!nodeTitleGapSchema.safeParse(gap).success) throw new InvalidArgumentError("Title gap must be positive World points");
  return gap;
}

export function parseRatioLock(value: string): boolean {
  if (value !== "true" && value !== "false") throw new InvalidArgumentError("Lock ratio must be true or false");
  return value === "true";
}
