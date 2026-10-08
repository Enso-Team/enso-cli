import { describe, expect, it } from "vitest";
import { compileCanvasApply, parseCanvasIntent, verifyCanvasIntent } from "../../src/canvas-intent.js";

const linkId = "00000000-0000-4000-8000-000000000003";
const context = {
  nodes: [{ id: "a", title: "A", ref: "DBS/A.md", position: { x: 100, y: 200 } }, { id: "b", title: "B" }, { id: "c", title: "C" }],
  links: [{ id: linkId, sourceNodeID: "a", targetNodeID: "b", label: "opens", color: "blue", direction: "directed", lineStyle: "solid" }],
  diagramPrimitives: []
};

describe("Canvas state verification", () => {
  it("detects a position mismatch while resolving an extensionless Note path", () => {
    const intent = parseCanvasIntent({ canvas: "current", nodes: [{ kind: "note", mode: "update", selector: "dbs/a", x: 300, y: 400 }] });
    expect(verifyCanvasIntent(intent, context).mismatches).toEqual(["nodes:dbs/a:x", "nodes:dbs/a:y"]);
    expect(compileCanvasApply(intent, context).phases[0].operations).toEqual([{ type: "node.move", selector: "a", x: 300, y: 400 }]);
    expect(verifyCanvasIntent(intent, { ...context, nodes: [{ ...context.nodes[0], position: { x: 300, y: 400 } }] }).ok).toBe(true);
  });

  it("detects a Portal destination mismatch", () => {
    const intent = parseCanvasIntent({ canvas: "current", nodes: [{ kind: "portal", mode: "update", selector: "Detail", subcanvasRef: "Canvases/Expected.json" }] });
    expect(verifyCanvasIntent(intent, { nodes: [{ id: "p", title: "Detail", subcanvasRef: "Canvases/Other.json" }] }).mismatches).toEqual(["nodes:Detail:subcanvasRef"]);
  });

  it("verifies Link labels, colors, direction, style, and endpoint moves", () => {
    const intent = parseCanvasIntent({ canvas: "current", links: [{ mode: "update", id: linkId, label: "", color: "red", direction: "undirected", lineStyle: "dotted", target: "C" }] });
    expect(verifyCanvasIntent(intent, context).mismatches).toEqual([
      "links:" + linkId + ":label", "links:" + linkId + ":color", "links:" + linkId + ":direction",
      "links:" + linkId + ":lineStyle", "links:" + linkId + ":target"
    ]);
    const updated = { ...context, links: [{ ...context.links[0], label: "", color: "red", direction: "undirected", lineStyle: "dotted", targetNodeID: "c" }] };
    expect(verifyCanvasIntent(intent, updated).ok).toBe(true);
  });

  it("verifies detached endpoint coordinates", () => {
    const intent = parseCanvasIntent({ canvas: "current", links: [{ mode: "update", id: linkId, target: null, targetPosition: { x: 320, y: -180 } }] });
    const detached = { ...context, links: [{ ...context.links[0], targetNodeID: null, targetPosition: { x: 320, y: -180 } }] };
    expect(verifyCanvasIntent(intent, detached).ok).toBe(true);
    expect(verifyCanvasIntent(intent, context).mismatches).toContain("links:" + linkId + ":target");
  });

  it("binds region creation to its returned ID and verifies geometry and color", () => {
    const intent = parseCanvasIntent({ canvas: "current", primitives: [{ kind: "region", mode: "create", x: 100, y: 200, width: 400, height: 240, color: "red" }] });
    const primitive = { id: "region", kind: "group", position: { x: 100, y: 200 }, bounds: { x: -100, y: 80, width: 400, height: 240 }, color: "red" };
    const results = [{ type: "group.create", id: "region" }];
    expect(verifyCanvasIntent(intent, { diagramPrimitives: [primitive] }, results).ok).toBe(true);
    expect(verifyCanvasIntent(intent, { diagramPrimitives: [] }, results).ok).toBe(false);
    expect(verifyCanvasIntent(intent, { diagramPrimitives: [{ ...primitive, id: "other" }] }, results).ok).toBe(false);
    expect(verifyCanvasIntent(intent, { diagramPrimitives: [primitive] }).ok).toBe(false);
    expect(verifyCanvasIntent(intent, { diagramPrimitives: [{ ...primitive, color: "blue" }] }, results).mismatches).toEqual(["primitives:create:0:color"]);
  });

  it("checks line endpoint geometry", () => {
    const intent = parseCanvasIntent({ canvas: "current", primitives: [{ kind: "line", mode: "create", x1: 10, y1: 20, x2: 100, y2: 20, lineStyle: "dashed" }] });
    const primitive = { id: "line", kind: "line", start: { x: 10, y: 20 }, end: { x: 100, y: 30 }, lineStyle: "dashed" };
    expect(verifyCanvasIntent(intent, { diagramPrimitives: [primitive] }, [{ type: "line.create", id: "line" }]).mismatches).toEqual(["primitives:create:0:y2"]);
  });

  it("treats an absent Canvas Link removal as complete and keeps prose deletion strict", () => {
    const intent = parseCanvasIntent({ canvas: "current", links: [{ mode: "remove", id: linkId }] });
    expect(compileCanvasApply(intent, { links: [] }).phases).toEqual([]);
    expect(verifyCanvasIntent(intent, { links: [] }).ok).toBe(true);
    expect(() => compileCanvasApply(parseCanvasIntent({ canvas: "current", links: [{ mode: "remove", id: linkId, fromNote: true }] }), { links: [] })).toThrow(/does not exist/);
  });

  it("refuses a create that reverses an existing directed Link", () => {
    const intent = parseCanvasIntent({ canvas: "current", links: [{ mode: "create", source: "B", target: "A" }] });
    expect(() => compileCanvasApply(intent, context)).toThrow(/different state/);
  });

  it("passes normalized placement paths to the bridge and refuses ambiguous endpoints", () => {
    const intent = parseCanvasIntent({ canvas: "current", nodes: [{ kind: "note", mode: "place", note: "DBS/Entry", x: 0, y: 0 }, { kind: "note", mode: "place", note: "DBS/QR", x: 200, y: 0 }], links: [{ mode: "create", source: "DBS/Entry", target: "DBS/QR", lineStyle: "dotted" }] });
    const operations = compileCanvasApply(intent, { nodes: [], availableNotes: ["DBS/Entry.md", "DBS/QR.md"] }).phases.flatMap(phase => phase.operations);
    expect(operations).toContainEqual({ type: "node.create", title: "DBS/Entry.md", placeExisting: true, x: 0, y: 0 });
    expect(operations).toContainEqual({ type: "link.create", source: "DBS/Entry.md", target: "DBS/QR.md", lineStyle: "dotted" });
    const ambiguous = parseCanvasIntent({ canvas: "current", nodes: [{ kind: "note", mode: "place", note: "A", x: 0, y: 0 }] });
    expect(() => compileCanvasApply(ambiguous, { availableNotes: ["One/A.md", "Two/A.md"] })).toThrow(/Multiple Notes/);
  });
});
