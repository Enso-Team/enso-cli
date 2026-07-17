import { describe, expect, it } from "vitest";
import { LAYOUT_GEOMETRY } from "../../src/layout.js";

describe("layout", () => {
  it("exposes spacing constants for agent layout recipes", () => {
    expect(LAYOUT_GEOMETRY).toMatchObject({ colStep: 450, rowStep: 280, nodeWidth: 220, nodeHeight: 140 });
  });
});
