import { utf8Length, validateFilename } from "@enso-app/core";
import { describe, expect, it } from "vitest";

describe("utf8Length", () => {
  it.each(["plain.md", "café", "設計メモ", "rocket 🚀", "lone \ud800 surrogate", ""])("counts %j as Node's Buffer does", (value) => {
    expect(utf8Length(value)).toBe(Buffer.byteLength(value, "utf8"));
  });

  it("rejects a filename one byte over 255 with its extension", () => {
    expect(() => validateFilename("é".repeat(127), "title", ".md")).toThrow(/at most 255 UTF-8 bytes/);
    expect(() => validateFilename("é".repeat(126), "title", ".md")).not.toThrow();
  });
});
