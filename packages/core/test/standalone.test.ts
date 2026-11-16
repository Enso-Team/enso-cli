import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

type Core = typeof import("../src/index.js");

async function evaluateLikeJavaScriptCore(): Promise<Core> {
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "..", "src", "index.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "EnsoCore",
    platform: "neutral",
    mainFields: ["module", "main"]
  });
  const context: { EnsoCore?: Core } = {};
  runInNewContext(`${bundle.outputFiles[0].text}\nglobalThis.EnsoCore = EnsoCore;`, context);
  return context.EnsoCore!;
}

describe("core in a bare script context", () => {
  it("parses, lays out and grows a diagram with no Node or browser globals", async () => {
    const core = await evaluateLikeJavaScriptCore();
    const spec = core.parseCanvasSpec(JSON.stringify({ canvas: "current", members: ["Client", "Server"], edges: [{ from: "Client", to: "Server", label: "calls" }] }));
    expect(core.compileCanvasSpec(spec).nodes.length).toBe(2);
    const intent = core.parseCanvasIntent({ canvas: "current", nodes: [{ kind: "note", mode: "place", note: "Client" }] });
    expect(core.planGrowth(intent, { nodes: [] }, undefined, "22222222-2222-4222-8222-222222222222", 0).intent.nodes).toHaveLength(1);
    expect(core.utf8Length("rocket 🚀")).toBe(11);
  });
});
