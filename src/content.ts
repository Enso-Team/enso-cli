import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readContentValue(value: string): string {
  if (!value.startsWith("@")) return value;
  return readFileSync(resolve(value.slice(1)), "utf8");
}
