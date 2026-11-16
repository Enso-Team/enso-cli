import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = join(import.meta.dirname, "..", "src");

describe("core boundary", () => {
  it("imports only zod and its own modules, so JavaScriptCore and Electron can both load it", () => {
    const specifiers = readdirSync(srcDir)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => [...readFileSync(join(srcDir, file), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]));
    const outside = specifiers.filter((specifier) => !specifier.startsWith("./") && specifier !== "zod/v3");
    expect(outside).toEqual([]);
  });
});
