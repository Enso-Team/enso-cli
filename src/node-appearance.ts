import { z } from "zod";
import { InvalidArgumentError } from "commander";

export const nodeAppearanceSchema = z.enum(["card", "user", "developer", "player", "client", "mobileApp", "service", "api", "database", "server", "queue", "cache", "cloud", "storage", "external", "component", "auth", "loadBalancer", "ux", "decision", "terminal"]);

export function parseNodeAppearance(value: string): string {
  const result = nodeAppearanceSchema.safeParse(value);
  if (!result.success) throw new InvalidArgumentError(`Appearance must be one of: ${nodeAppearanceSchema.options.join(", ")}`);
  return result.data;
}
