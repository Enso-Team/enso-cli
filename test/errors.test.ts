import { afterEach, describe, expect, it, vi } from "vitest";
import { printEnvelope } from "../src/errors.js";

describe("printEnvelope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes duplicate_link hint after envelope.text on stderr", () => {
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
    expect(output).toContain("Link already exists between these nodes");
    expect(output).toContain("Use link update on the existing link id");
  });
});
