import { afterEach, describe, expect, it, vi } from "vitest";
import { printEnvelope } from "../src/errors.js";

describe("printEnvelope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes duplicate_link recovery inside one JSON envelope", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    printEnvelope(
      {
        ok: false,
        error: { code: "duplicate_link", message: "Link already exists" },
        text: "Link already exists between these nodes\n"
      },
      false,
      process.stderr
    );

    const output = chunks.join("");
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: {
        code: "duplicate_link",
        message: "Link already exists",
        details: {
          hint: "Use link update on the existing link id instead of link create"
        }
      }
    });
  });
});
