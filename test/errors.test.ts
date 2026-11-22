import { afterEach, describe, expect, it, vi } from "vitest";
import { printEnvelope } from "../src/errors.js";
import { CANVAS_INTENT_CONTRACT_HINT, errorEnvelope, parseCanvasIntent, specError, type EnsoEnvelope } from "@enso-app/core";

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
          hint: "Use link update on the existing link id, or pass --mention-index to link create to point a new link at another sentence from its mentions"
        }
      }
    });
  });
});

describe("core hints in CLI output", () => {
  const printed = (run: () => unknown): Record<string, unknown> => {
    let envelope: EnsoEnvelope | undefined;
    try { run(); } catch (error) { envelope = errorEnvelope(error); }
    const chunks: string[] = [];
    const stream = { write: (chunk: string) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
    printEnvelope(envelope!, false, stream);
    return JSON.parse(chunks.join("")).error.details;
  };

  it("points an invalid intent at `enso canvas apply --schema`", () => {
    expect(printed(() => parseCanvasIntent({ canvas: "current", nodes: [{ kind: "nope" }] })).hint).toBe("Run `enso canvas apply --schema` for the machine-readable contract");
  });

  it("keeps the CLI's name for the schema an invalid intent fails", () => {
    expect(printed(() => parseCanvasIntent({ canvas: "current", nodes: [{ kind: "nope" }] })).expected).toBe("canvas apply schema");
  });

  it("points an invalid canvas spec at `enso layout --schema`", () => {
    expect(printed(() => { throw specError("bad graph", "members"); }).hint).toBe("Run `enso layout --schema` for the machine-readable canvas spec contract");
  });

  it("keeps core's door-neutral hint out of CLI output", () => {
    expect(printed(() => parseCanvasIntent({ canvas: "current", nodes: [{ kind: "nope" }] })).hint).not.toBe(CANVAS_INTENT_CONTRACT_HINT);
  });
});
