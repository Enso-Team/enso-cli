import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ANNOTATION_GEOMETRY, CARD_GEOMETRY } from "../../src/layout.js";
import { markWorldBox } from "../../src/mark-model.js";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

const NOTE = "55555555-5555-4555-8555-555555555555";
const EXCERPT = "33333333-3333-4333-8333-333333333333";

const DELETE_SPEC = {
  canvas: "Deleting",
  direction: "TB",
  members: [
    { title: "Delete a Canvas", excerpt: "The server hides it from everyone." },
    { title: "Server canvas list", mark: "Only the owner's delete reaches the server." },
    "Vault index"
  ],
  edges: [
    { from: "Delete a Canvas", to: "Server canvas list", label: "stamps deleted_at in" },
    { from: "Delete a Canvas", to: "Vault index", label: "flags deleted in" }
  ],
  marks: ["A tombstone keeps a delete from coming back when a teammate syncs."]
};

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Planned = { note: string; text: string; x: number; y: number; width: number };
type PatchMark = { text: string; x: number; y: number; width: number; connect?: string[] };
type PatchNode = { note: string; x: number; y: number };
type PatchRegion = { title: string; x: number; y: number; width: number; height: number };

function writeSpec(spec: unknown): string {
  const path = join(tempDir, "graph.json");
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

async function compile(spec: unknown) {
  const result = await run(["layout", writeSpec(spec)]);
  expect(result.code).toBe(0);
  const data = JSON.parse(result.stdout).data;
  return { nodes: data.patch.nodes as PatchNode[], marks: data.patch.marks as PatchMark[], regions: data.patch.primitives as PatchRegion[], excerpts: data.excerpts as Planned[] };
}

function nodeBox(node: PatchNode): Box {
  return { minX: node.x - CARD_GEOMETRY.nodeWidth / 2, maxX: node.x + CARD_GEOMETRY.nodeWidth / 2, minY: node.y - CARD_GEOMETRY.nodeHeight / 2, maxY: node.y + CARD_GEOMETRY.nodeHeight / 2 };
}

function textBox(item: { text: string; x: number; y: number; width: number }): Box {
  return markWorldBox(item);
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function vault(files: Record<string, string>): string {
  const root = join(tempDir, "vault");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("layout annotations", () => {
  it("places a member's Excerpt and Mark in a lane to the right of its Node for TB", async () => {
    const { nodes, marks, excerpts } = await compile(DELETE_SPEC);
    const canvas = nodes.find((node) => node.note === "Delete a Canvas")!;
    expect(excerpts).toEqual([{
      note: "Delete a Canvas",
      text: "The server hides it from everyone.",
      x: canvas.x + CARD_GEOMETRY.nodeWidth / 2 + ANNOTATION_GEOMETRY.gap,
      y: canvas.y - CARD_GEOMETRY.nodeHeight / 2,
      width: ANNOTATION_GEOMETRY.width
    }]);
    const server = nodes.find((node) => node.note === "Server canvas list")!;
    expect(marks).toContainEqual({
      mode: "create",
      text: "Only the owner's delete reaches the server.",
      x: server.x + CARD_GEOMETRY.nodeWidth / 2 + ANNOTATION_GEOMETRY.gap,
      y: server.y - CARD_GEOMETRY.nodeHeight / 2,
      width: ANNOTATION_GEOMETRY.width,
      connect: ["Server canvas list"]
    });
  });

  it("places annotations below their Node for LR, as wide as the column allows", async () => {
    const { nodes, excerpts } = await compile({ ...DELETE_SPEC, direction: "LR" });
    const canvas = nodes.find((node) => node.note === "Delete a Canvas")!;
    expect(excerpts[0]).toMatchObject({
      x: canvas.x - CARD_GEOMETRY.nodeWidth / 2,
      y: canvas.y + CARD_GEOMETRY.nodeHeight / 2 + ANNOTATION_GEOMETRY.gap,
      width: CARD_GEOMETRY.colStep - 2 * ANNOTATION_GEOMETRY.gap
    });
  });

  it("scales only the gaps with --spacing and adds each lane once", async () => {
    const chain = { canvas: "Chain", members: [{ title: "A", excerpt: "a" }, { title: "B", excerpt: "b" }], edges: [{ from: "A", to: "B" }] };
    for (const [direction, axis, expected] of [["LR", "x", 2 * CARD_GEOMETRY.colStep], ["TB", "y", 2 * CARD_GEOMETRY.rowStep]] as const) {
      const result = await run(["layout", writeSpec({ ...chain, direction }), "--spacing", "2"]);
      const nodes = JSON.parse(result.stdout).data.patch.nodes as PatchNode[];
      expect(Math.abs(nodes[1][axis] - nodes[0][axis])).toBe(expected);
    }
  });

  it("stacks a member's Mark under its Excerpt in the same lane", async () => {
    const spec = { ...DELETE_SPEC, members: [{ title: "Delete a Canvas", excerpt: "The server hides it from everyone.", mark: "Owner only." }, "Server canvas list", "Vault index"] };
    const { marks, excerpts } = await compile(spec);
    const mark = marks.find((item) => item.text === "Owner only.")!;
    expect(mark.x).toBe(excerpts[0].x);
    expect(mark.y).toBe(textBox(excerpts[0]).maxY + ANNOTATION_GEOMETRY.stackGap);
  });

  it("keeps every annotation clear of every Node and of every other annotation", async () => {
    for (const direction of ["TB", "LR"]) {
      const { nodes, marks, excerpts } = await compile({ ...DELETE_SPEC, direction });
      const texts = [...excerpts, ...marks].map(textBox);
      for (const text of texts) for (const node of nodes) expect(overlaps(text, nodeBox(node))).toBe(false);
      texts.forEach((text, index) => texts.slice(index + 1).forEach((other) => expect(overlaps(text, other)).toBe(false)));
    }
  });

  it("stacks canvas-wide Marks above the drawing, starting at its left edge", async () => {
    const { nodes, marks, excerpts } = await compile(DELETE_SPEC);
    const takeaway = marks.find((mark) => mark.connect === undefined)!;
    const content = [...nodes.map(nodeBox), ...excerpts.map(textBox), ...marks.filter((mark) => mark !== takeaway).map(textBox)];
    expect(takeaway.x).toBe(Math.min(...content.map((box) => box.minX)));
    expect(textBox(takeaway).maxY).toBe(Math.min(...content.map((box) => box.minY)) - ANNOTATION_GEOMETRY.canvasGap);
  });

  it("grows each region to hold its members' annotations", async () => {
    const spec = { ...DELETE_SPEC, clusters: [{ name: "Delete", members: ["Delete a Canvas"] }] };
    const { regions, excerpts } = await compile(spec);
    const region = regions.find((item) => item.title === "Delete")!;
    const excerpt = textBox(excerpts[0]);
    expect(region.x - region.width / 2).toBeLessThanOrEqual(excerpt.minX);
    expect(region.x + region.width / 2).toBeGreaterThanOrEqual(excerpt.maxX);
    expect(region.y + region.height / 2).toBeGreaterThanOrEqual(excerpt.maxY);
  });

  it("leaves a spec without annotations exactly as before", async () => {
    const plain = { canvas: "Plain", members: ["A", "B"], edges: [{ from: "A", to: "B" }] };
    const { nodes, marks, excerpts } = await compile(plain);
    expect(nodes.map(({ x, y }) => [x, y])).toEqual([[0, -CARD_GEOMETRY.rowStep / 2], [0, CARD_GEOMETRY.rowStep / 2]]);
    expect(marks).toEqual([]);
    expect(excerpts).toEqual([]);
  });

  it("rejects a member field the spec does not define", async () => {
    const result = await run(["layout", writeSpec({ ...DELETE_SPEC, members: [{ title: "A", caption: "x" }] })]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
  });

  it("checks each Excerpt passage against its Note file before applying anything", async () => {
    const root = vault({ "Deleting/Delete a Canvas.md": "# Delete a Canvas\n\nThe file goes.\n" });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/vault/current") return Response.json({ ok: true, data: { path: root } });
      return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [], marks: [] } });
    });
    const result = await run(["layout", writeSpec(DELETE_SPEC), "--apply", "--dry-run"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "passage_not_found", details: { note: "Delete a Canvas" } });
    expect(calls.some((call) => new URL(call.url).pathname === "/v1/apply")).toBe(false);
  });

  it("reports planned Excerpts on --apply --dry-run without placing them", async () => {
    const root = vault({ "Deleting/Delete a Canvas.md": "# Delete a Canvas\n\nThe server hides it from everyone.\n" });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/vault/current") return Response.json({ ok: true, data: { path: root } });
      return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [], marks: [] } });
    });
    const result = await run(["layout", writeSpec(DELETE_SPEC), "--apply", "--dry-run"]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.excerpts).toEqual([expect.objectContaining({ note: "Delete a Canvas", text: "The server hides it from everyone.", validated: "locally" })]);
    expect(calls.some((call) => new URL(call.url).pathname === "/v1/excerpts")).toBe(false);
  });

  it("places each Excerpt from its Node once the layout lands, at the applied position and width", async () => {
    const root = vault({ "Deleting/Delete a Canvas.md": "# Delete a Canvas\n\nThe server hides it from everyone.\n" });
    const nodes: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/vault/current") return Response.json({ ok: true, data: { path: root } });
      if (pathname === "/v1/apply") {
        const body = JSON.parse(String(init?.body));
        const results = body.operations.map((operation: Record<string, unknown>) => {
          if (operation.type === "node.create") {
            nodes.push({ id: `node-${nodes.length}`, kind: "note", title: operation.title, ref: `Deleting/${operation.title}.md`, noteID: NOTE, position: { x: operation.x, y: operation.y } });
            return { node: nodes.at(-1) };
          }
          if (operation.type === "mark.create") return { mark: { id: `mark-${String(operation.text).length}` } };
          return {};
        });
        return Response.json({ ok: true, data: { results } });
      }
      if (pathname === "/v1/nodes") return Response.json({ ok: true, data: { nodes } });
      if (pathname.startsWith("/v1/excerpts")) return Response.json({ ok: true, data: { excerpt: { id: EXCERPT } } });
      return Response.json({ ok: true, data: { nodes, links: [], diagramPrimitives: [], marks: [] } });
    });
    const result = await run(["layout", writeSpec({ canvas: "Deleting", members: [DELETE_SPEC.members[0]] }), "--apply"]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data;
    const create = calls.find((call) => new URL(call.url).pathname === "/v1/excerpts")!;
    const body = JSON.parse(String(create.init.body));
    const placed = data.excerpts[0];
    expect(body).toMatchObject({ selection: { noteID: NOTE, capturedMarkdown: "The server hides it from everyone." }, x: placed.x, y: placed.y });
    const canvasNode = nodes.find((node) => node.title === "Delete a Canvas")!.position as { x: number; y: number };
    expect(placed.x).toBe(canvasNode.x + CARD_GEOMETRY.nodeWidth / 2 + ANNOTATION_GEOMETRY.gap);
    const resize = calls.find((call) => new URL(call.url).pathname === `/v1/excerpts/${EXCERPT}`)!;
    expect(resize.init.method).toBe("PUT");
    expect(JSON.parse(String(resize.init.body))).toMatchObject({ width: ANNOTATION_GEOMETRY.width });
    expect(placed).toMatchObject({ note: "Delete a Canvas", id: EXCERPT });
  });
});

describe("layout Excerpt recovery", () => {
  function appWith(excerptRoute: (method: string) => Response | Promise<Response>) {
    const root = vault({ "Deleting/Delete a Canvas.md": "# Delete a Canvas\n\nThe server hides it from everyone.\n" });
    const nodes: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/vault/current") return Response.json({ ok: true, data: { path: root } });
      if (pathname === "/v1/apply") {
        const body = JSON.parse(String(init?.body));
        return Response.json({ ok: true, data: { results: body.operations.map((operation: Record<string, unknown>) => {
          nodes.push({ id: `node-${nodes.length}`, kind: "note", title: operation.title, ref: `Deleting/${operation.title}.md`, noteID: NOTE, position: { x: operation.x, y: operation.y } });
          return { node: nodes.at(-1) };
        }) } });
      }
      if (pathname === "/v1/nodes") return Response.json({ ok: true, data: { nodes } });
      if (pathname.startsWith("/v1/excerpts")) return excerptRoute(init?.method ?? "GET");
      return Response.json({ ok: true, data: { nodes, links: [], diagramPrimitives: [], marks: [] } });
    });
  }
  const spec = { canvas: "Deleting", members: [{ title: "Delete a Canvas", excerpt: "The server hides it from everyone." }] };

  it("keeps a created Excerpt's id when its formatting fails, and asks for an update rather than a second create", async () => {
    appWith((method) => method === "POST"
      ? Response.json({ ok: true, data: { excerpt: { id: EXCERPT } } })
      : Response.json({ ok: false, error: { code: "operation_failed", message: "width rejected" } }, { status: 500 }));
    const result = await run(["layout", writeSpec(spec), "--apply"]);
    expect(result.code).toBe(1);
    const error = JSON.parse(result.stderr).error;
    expect(error.details).toMatchObject({ note: "Delete a Canvas", excerptId: EXCERPT });
    expect(error.details.hint).toContain(`enso excerpt update ${EXCERPT}`);
    expect(calls.filter((call) => new URL(call.url).pathname === "/v1/excerpts")).toHaveLength(1);
  });

  it("reports the landed layout and placed Excerpts when the bridge throws mid-placement", async () => {
    appWith(() => { throw new TypeError("fetch failed"); });
    const result = await run(["layout", writeSpec(spec), "--apply"]);
    expect(result.code).toBe(1);
    const error = JSON.parse(result.stderr).error;
    expect(error.details).toMatchObject({ note: "Delete a Canvas", excerpts: [], layout: { canvas: "Deleting" } });
  });
});

describe("layout rerun", () => {
  const MARK_A = "11111111-1111-4111-8111-111111111111";
  const MARK_B = "22222222-2222-4222-8222-222222222222";

  function canvasHolding(root: string) {
    const nodes = ["Delete a Canvas", "Server canvas list", "Vault index"].map((title, index) => ({
      id: `node-${index}`, kind: "note", title, ref: `Deleting/${title}.md`, noteID: NOTE, position: { x: index * 300, y: 0 }
    }));
    const excerpts = [{ id: EXCERPT, text: "The server hides it from everyone.", linkedNodeID: "node-0", connectedNodeIDs: ["node-0"] }];
    const marks = [
      { id: MARK_A, kind: "text", text: "Only the owner's delete reaches the server.", connectedNodeIDs: ["node-1"], position: { x: 0, y: 400 } },
      { id: MARK_B, kind: "text", text: DELETE_SPEC.marks[0], connectedNodeIDs: [], position: { x: 0, y: -400 } }
    ];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/vault/current") return Response.json({ ok: true, data: { path: root } });
      if (pathname === "/v1/apply") {
        const body = JSON.parse(String(init?.body));
        return Response.json({ ok: true, data: { results: body.operations.map((operation: Record<string, unknown>) => {
          const target = [...nodes, ...marks].find((item) => [item.id, (item as { title?: string }).title].includes(String(operation.id ?? operation.selector ?? operation.title)));
          if (target && typeof operation.x === "number") target.position = { x: operation.x, y: operation.y as number };
          return target && "title" in target ? { node: target } : {};
        }) } });
      }
      if (pathname === "/v1/nodes") return Response.json({ ok: true, data: { nodes } });
      if (pathname.startsWith("/v1/excerpts")) return Response.json({ ok: true, data: { excerpt: { id: EXCERPT } } });
      return Response.json({ ok: true, data: { nodes, links: [], diagramPrimitives: [], marks, excerpts } });
    });
  }

  it("moves the Excerpts and Marks the Canvas already holds instead of creating copies", async () => {
    canvasHolding(vault({ "Deleting/Delete a Canvas.md": "# Delete a Canvas\n\nThe server hides it from everyone.\n" }));
    const result = await run(["layout", writeSpec(DELETE_SPEC), "--apply", "--dry-run"]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data;
    const operations = (data.applied.phases as Array<{ operations: Array<Record<string, unknown>> }>).flatMap((phase) => phase.operations);
    expect(operations.filter((operation) => operation.type === "mark.create")).toEqual([]);
    expect(operations.filter((operation) => operation.type === "mark.update").map((operation) => operation.id)).toEqual([MARK_A, MARK_B]);
    expect(data.excerpts).toEqual([expect.objectContaining({ note: "Delete a Canvas", id: EXCERPT, validated: "locally" })]);
    expect(data.reused).toEqual({ excerpts: [EXCERPT], marks: [MARK_A, MARK_B] });
  });

  it("moves a reused Excerpt rather than creating it again on --apply", async () => {
    canvasHolding(vault({ "Deleting/Delete a Canvas.md": "# Delete a Canvas\n\nThe server hides it from everyone.\n" }));
    await run(["layout", writeSpec({ canvas: "Deleting", members: [DELETE_SPEC.members[0]] }), "--apply"]);
    const excerptCalls = calls.filter((call) => new URL(call.url).pathname.startsWith("/v1/excerpts"));
    expect(excerptCalls.map((call) => [new URL(call.url).pathname, call.init.method])).toEqual([[`/v1/excerpts/${EXCERPT}`, "PUT"]]);
    expect(JSON.parse(String(excerptCalls[0].init.body))).toMatchObject({ width: ANNOTATION_GEOMETRY.width });
  });
});

describe("excerpt create formatting", () => {
  it("sets width, font size, and alignment on a new note Excerpt after creating it", async () => {
    const root = vault({ "docs/Auth.md": "# Auth\n\nTokens rotate.\n" });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/nodes") return Response.json({ ok: true, data: { nodes: [{ id: "n", kind: "note", title: "Auth", ref: "docs/Auth.md", noteID: NOTE }] } });
      if (pathname === "/v1/vault/current") return Response.json({ ok: true, data: { path: root } });
      return Response.json({ ok: true, data: { excerpt: { id: EXCERPT } } });
    });
    const result = await run(["excerpt", "create", "--note", "Auth", "--text", "Tokens rotate.", "--x", "0", "--y", "0", "--width", "240", "--font-size", "20", "--align", "center"]);
    expect(result.code).toBe(0);
    const update = calls.at(-1)!;
    expect(new URL(update.url).pathname).toBe(`/v1/excerpts/${EXCERPT}`);
    expect(update.init.method).toBe("PUT");
    expect(JSON.parse(String(update.init.body))).toMatchObject({ width: 240, fontSize: 20, textAlignment: "center" });
  });
});
