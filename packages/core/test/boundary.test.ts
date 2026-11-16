import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = join(import.meta.dirname, "..", "src");
const sources = readdirSync(srcDir).filter((file) => file.endsWith(".ts")).map((file) => ({ file, text: readFileSync(join(srcDir, file), "utf8") }));

describe("core boundary", () => {
  it("imports only zod and its own modules, so JavaScriptCore and Electron can both load it", () => {
    const outside = sources.flatMap(({ text }) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])).filter((specifier) => !specifier.startsWith("./") && specifier !== "zod/v3");
    expect(outside).toEqual([]);
  });

  it("names no CLI command or flag, since MCP agents read its errors too", () => {
    const cliWording = sources.flatMap(({ file, text }) => [...text.matchAll(/`enso [a-z]+[^`]*`|\bcanvas apply\b|--[a-z][a-z-]{2,}|\bthe CLI\b/g)].map((match) => `${file}: ${match[0]}`));
    expect(cliWording).toEqual([]);
  });
});
