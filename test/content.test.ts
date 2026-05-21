import { describe, expect, it } from "vitest";
import { readContentValue, unescapeAgentText } from "../src/content.js";

describe("content", () => {
  it("unescapes shell-style newlines and tabs", () => {
    expect(unescapeAgentText("line1\\nline2")).toBe("line1\nline2");
    expect(unescapeAgentText("# Title\\n\\nBody")).toBe("# Title\n\nBody");
    expect(unescapeAgentText("tab\\there")).toBe("tab\there");
    expect(unescapeAgentText("backslash\\\\end")).toBe("backslash\\end");
  });

  it("leaves @file content unchanged", () => {
    const path = new URL("./fixtures/sample-note.md", import.meta.url);
    expect(readContentValue(`@${path.pathname}`)).toBe("# Sample\n\nBody line.\n");
  });
});
