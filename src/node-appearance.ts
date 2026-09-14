import { z } from "zod";
import { InvalidArgumentError } from "commander";

export const nodeAppearanceSchema = z.enum(["card", "user", "developer", "player", "client", "mobileApp", "service", "api", "database", "server", "queue", "cache", "cloud", "storage", "external", "component", "auth", "loadBalancer", "ux", "decision", "terminal"]);

export function parseNodeAppearance(value: string): string {
  const result = nodeAppearanceSchema.safeParse(value);
  if (!result.success) throw new InvalidArgumentError(`Appearance must be one of: ${nodeAppearanceSchema.options.join(", ")}`);
  return result.data;
}

export const nodeGlyphSizeSchema = z.number().finite().min(24).max(160).nullable();
export const nodeFontSizeSchema = z.number().finite().min(8).max(96);

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
