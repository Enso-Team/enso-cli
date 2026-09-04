import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LAYOUT_GEOMETRY } from "../../src/layout.js";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

const FLOWCHART = [
  "---",
  "title: Request Flow",
  "---",
  "%% how a request reaches the store",
  "flowchart LR",
  "  subgraph Edge",
  "    Gateway[API Gateway] -->|routes| Router",
  "  end",
  "  Router --> Store[(Object Store)]",
  "  Router -.-> Audit[\"Audit Log\"]",
  "  Audit --- Metrics",
  ""
].join("\n");

const STATE_DIAGRAM = [
  "stateDiagram-v2",
  "  direction LR",
  "  [*] --> Idle",
  "  state \"Waiting on IO\" as Busy",
  "  Idle --> Busy : work arrives",
  "  state Recovery {",
  "    Retry --> Backoff",
  "  }",
  "  Busy --> Retry: failure",
  "  Backoff --> Idle",
  "  Idle --> [*]",
  ""
].join("\n");

function writeDiagram(contents: string, name = "flow.mmd"): string {
  const path = join(tempDir, name);
  writeFileSync(path, contents);
  return path;
}

type PatchNode = { mode: string; title?: string; selector?: string; x: number; y: number };
type PatchRegion = { title: string; x: number; y: number; width: number; height: number };
type Patch = { canvas: string; nodes: PatchNode[]; links: Array<Record<string, unknown>>; primitives: PatchRegion[] };

function dataOf(stdout: string): { canvas: string; direction: string; source: string; notes: { reused: string[]; stubs: string[] }; patch: Patch } {
  return JSON.parse(stdout).data;
}

/** The vault tree lists `tree`; search finds `searchable` and nothing else. */
function vaultHolding(tree: string[], searchable: string[] = []): void {
  vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const target = new URL(String(url));
    if (target.pathname === "/v1/vault/tree") {
      return Response.json({ ok: true, data: { children: tree.map((title) => ({ path: `Files/${title}.md` })) } });
    }
    if (target.pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
    if (target.pathname === "/v1/search") {
      const query = target.searchParams.get("q");
      return Response.json({ ok: true, data: { results: searchable.includes(query ?? "") ? [{ node: { title: query } }] : [] } });
    }
    return Response.json({ ok: true, data: {} });
  });
}

describe("layout --from-mermaid", () => {
  it("prints the mermaid mapping alongside the canvas spec contract", async () => {
    const result = await run(["layout", "--schema"]);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { mermaid: { supported: ["flowchart", "stateDiagram"], mapping: { subgraphs: expect.stringContaining("clusters") } } }
    });
  });

  it("compiles a flowchart into members, Links, clusters, and a direction hint", async () => {
    vaultHolding([]);
    const data = dataOf((await run(["layout", "--from-mermaid", writeDiagram(FLOWCHART)])).stdout);
    expect(data).toMatchObject({ canvas: "Request Flow", direction: "LR", source: "mermaid" });
    expect(data.patch.nodes.map((node) => node.title).sort()).toEqual(["API Gateway", "Audit Log", "Metrics", "Object Store", "Router"]);
    expect(data.patch.links).toEqual([
      { mode: "create", source: "API Gateway", target: "Router", label: "routes", direction: "directed" },
      { mode: "create", source: "Router", target: "Object Store", direction: "directed" },
      { mode: "create", source: "Router", target: "Audit Log", direction: "directed" },
      { mode: "create", source: "Audit Log", target: "Metrics", direction: "undirected" }
    ]);
    expect(data.patch.primitives.map((region) => region.title)).toEqual(["Edge"]);
    const gateway = data.patch.nodes.find((node) => node.title === "API Gateway")!;
    const router = data.patch.nodes.find((node) => node.title === "Router")!;
    expect(router.x - gateway.x).toBe(LAYOUT_GEOMETRY.colStep);
  });

  it("compiles a state diagram, mapping composite states to clusters and dropping the start marker", async () => {
    vaultHolding([]);
    const data = dataOf((await run(["layout", "--from-mermaid", writeDiagram(STATE_DIAGRAM, "states.mmd"), "--canvas", "Worker"])).stdout);
    expect(data).toMatchObject({ canvas: "Worker", direction: "LR" });
    expect(data.patch.nodes.map((node) => node.title)).toEqual(["Idle", "Waiting on IO", "Retry", "Backoff"]);
    expect(data.patch.links).toContainEqual({ mode: "create", source: "Waiting on IO", target: "Retry", label: "failure", direction: "directed" });
    expect(data.patch.primitives.map((region) => region.title)).toEqual(["Recovery"]);
    expect(data.patch.nodes.some((node) => node.title === "[*]")).toBe(false);
  });

  it("places titles the vault already holds and stubs the rest for the agent to fill", async () => {
    vaultHolding(["Router", "Object Store"]);
    const data = dataOf((await run(["layout", "--from-mermaid", writeDiagram(FLOWCHART)])).stdout);
    expect(data.notes).toEqual({
      reused: ["Router", "Object Store"],
      stubs: ["API Gateway", "Audit Log", "Metrics"]
    });
    expect(data.patch.nodes.filter((node) => node.mode === "reuse").map((node) => node.selector).sort()).toEqual(["Object Store", "Router"]);
    expect(data.patch.nodes.filter((node) => node.mode === "create").map((node) => node.title).sort()).toEqual(["API Gateway", "Audit Log", "Metrics"]);
  });

  it("emits byte-identical geometry for identical mermaid input", async () => {
    vaultHolding(["Router"]);
    const diagram = writeDiagram(FLOWCHART);
    const first = await run(["layout", "--from-mermaid", diagram]);
    const second = await run(["layout", "--from-mermaid", diagram]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it("ranks a TB flowchart down the canvas and an LR flowchart across it", async () => {
    vaultHolding([]);
    const vertical = dataOf((await run(["layout", "--from-mermaid", writeDiagram("flowchart TB\n  A --> B\n", "tb.mmd")])).stdout);
    const horizontal = dataOf((await run(["layout", "--from-mermaid", writeDiagram("flowchart LR\n  A --> B\n", "lr.mmd")])).stdout);
    expect(vertical.patch.nodes[1].y - vertical.patch.nodes[0].y).toBe(LAYOUT_GEOMETRY.rowStep);
    expect(vertical.patch.nodes[0].x).toBe(0);
    expect(horizontal.patch.nodes[1].x - horizontal.patch.nodes[0].x).toBe(LAYOUT_GEOMETRY.colStep);
    expect(horizontal.patch.nodes[0].y).toBe(0);
  });

  it("lands the compiled diagram on a canvas with --apply", async () => {
    let inspections = 0;
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/canvases/Request%20Flow/inspect") {
        inspections += 1;
        return Response.json({
          ok: true,
          data: {
            nodes: inspections === 1
              ? []
              : ["API Gateway", "Router", "Object Store", "Audit Log", "Metrics"].map((title, index) => ({ id: `node-${index}`, title })),
            links: inspections === 1
              ? []
              : [["node-0", "node-1"], ["node-1", "node-2"], ["node-1", "node-3"], ["node-3", "node-4"]]
                .map(([sourceNodeID, targetNodeID], index) => ({ id: `link-${index}`, sourceNodeID, targetNodeID })),
            diagramPrimitives: []
          }
        });
      }
      if (pathname === "/v1/apply") return Response.json({ ok: true, data: { results: [{ type: "node.create", id: "node-0", status: "created" }] } });
      return Response.json({ ok: true, data: {} });
    });
    const result = await run(["layout", "--from-mermaid", writeDiagram(FLOWCHART), "--apply"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        canvas: "Request Flow",
        source: "mermaid",
        compiled: { nodes: 5, links: 4, regions: 1 },
        applied: { verification: { status: "verified", target: "Request Flow" } }
      }
    });
  });

  it("points a reversed arrow at the node its head touches", async () => {
    vaultHolding([]);
    for (const [connector, name] of [["<--", "left.mmd"], ["o--", "circle.mmd"], ["x--", "cross.mmd"]]) {
      const data = dataOf((await run(["layout", "--from-mermaid", writeDiagram(`flowchart LR\n  A ${connector} B\n`, name)])).stdout);
      expect(data.patch.links).toEqual([{ mode: "create", source: "B", target: "A", direction: "directed" }]);
    }
  });

  it("folds a reciprocal pair into one bidirectional Link", async () => {
    vaultHolding([]);
    const data = dataOf((await run(["layout", "--from-mermaid", writeDiagram("flowchart LR\n  A -->|calls| B\n  B --> A\n", "cycle.mmd")])).stdout);
    expect(data.patch.links).toEqual([{ mode: "create", source: "A", target: "B", label: "calls", direction: "bidirectional" }]);
  });

  it("lays out a cycle without dropping a node or a Link", async () => {
    vaultHolding([]);
    const data = dataOf((await run(["layout", "--from-mermaid", writeDiagram("flowchart TD\n  A --> B\n  B --> C\n  C --> A\n", "loop.mmd")])).stdout);
    expect(data.patch.nodes.map((node) => node.title).sort()).toEqual(["A", "B", "C"]);
    expect(data.patch.links).toHaveLength(3);
  });

  it("keeps every member clear of every other member and inside its cluster", async () => {
    vaultHolding([]);
    const patch = dataOf((await run(["layout", "--from-mermaid", writeDiagram(FLOWCHART)])).stdout).patch;
    for (const [index, node] of patch.nodes.entries()) {
      for (const other of patch.nodes.slice(index + 1)) {
        const overlaps = Math.abs(node.x - other.x) < LAYOUT_GEOMETRY.nodeWidth
          && Math.abs(node.y - other.y) < LAYOUT_GEOMETRY.nodeHeight;
        expect(overlaps).toBe(false);
      }
    }
    const region = patch.primitives.find((primitive) => primitive.title === "Edge")!;
    const members = patch.nodes.filter((node) => ["API Gateway", "Router"].includes(node.title ?? ""));
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member.x - LAYOUT_GEOMETRY.nodeWidth / 2).toBeGreaterThanOrEqual(region.x - region.width / 2);
      expect(member.x + LAYOUT_GEOMETRY.nodeWidth / 2).toBeLessThanOrEqual(region.x + region.width / 2);
      expect(member.y - LAYOUT_GEOMETRY.nodeHeight / 2).toBeGreaterThanOrEqual(region.y - region.height / 2);
      expect(member.y + LAYOUT_GEOMETRY.nodeHeight / 2).toBeLessThanOrEqual(region.y + region.height / 2);
    }
  });

  it("places a Note the vault tree lists even when search does not return it", async () => {
    vaultHolding(["Router", "Audit Log"], []);
    const data = dataOf((await run(["layout", "--from-mermaid", writeDiagram(FLOWCHART)])).stdout);
    expect(data.notes.reused).toEqual(["Router", "Audit Log"]);
    expect(data.notes.stubs).toEqual(["API Gateway", "Object Store", "Metrics"]);
  });

  it("places a Note search returns even when the vault tree omits it", async () => {
    vaultHolding([], ["Metrics"]);
    const data = dataOf((await run(["layout", "--from-mermaid", writeDiagram(FLOWCHART)])).stdout);
    expect(data.notes.reused).toEqual(["Metrics"]);
  });

  it("stops the compile when the vault listing is unavailable rather than stubbing every Note", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/vault/tree") {
        return Response.json({ ok: false, error: { code: "app_unavailable", message: "No vault is open", details: {} } }, { status: 503 });
      }
      return Response.json({ ok: true, data: {} });
    });
    const result = await run(["layout", "--from-mermaid", writeDiagram(FLOWCHART), "--apply"]);
    expect(result.code).toBe(1);
    expect(calls.some((call) => new URL(call.url).pathname === "/v1/apply")).toBe(false);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "app_unavailable" } });
  });

  it("names the supported diagram set when the diagram type has no canvas mapping", async () => {
    const result = await run(["layout", "--from-mermaid", writeDiagram("sequenceDiagram\n  Alice->>Bob: hi\n", "sequence.mmd")]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_diagram",
        message: expect.stringContaining("sequenceDiagram"),
        details: { found: "sequenceDiagram", supported: ["flowchart", "stateDiagram"], expected: expect.stringContaining("stateDiagram") }
      }
    });
  });

  it.each([
    ["a class diagram", "classDiagram\n  Animal <|-- Duck\n"],
    ["an entity relationship diagram", "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n"],
    ["a gantt chart", "gantt\n  title A\n"]
  ])("rejects %s before any bridge call", async (_description, contents) => {
    const result = await run(["layout", "--from-mermaid", writeDiagram(contents, "other.mmd")]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "unsupported_diagram", details: { supported: ["flowchart", "stateDiagram"] } });
  });

  it.each([
    ["a direction that reverses the flow", "flowchart BT\n  A --> B\n", "mermaid:1"],
    ["a node linked to itself", "flowchart TD\n  A --> A\n", "mermaid:2"],
    ["the same arrow drawn twice", "flowchart TD\n  A --> B\n  A --> B\n", "mermaid:3"],
    ["one Link asked to carry two labels", "flowchart TD\n  A -->|go| B\n  B -->|back| A\n", "mermaid:3"],
    ["a nested subgraph", "flowchart TD\n  subgraph Outer\n    subgraph Inner\n    end\n  end\n", "mermaid:3"],
    ["an unclosed subgraph", "flowchart TD\n  subgraph Edge\n    A --> B\n", "mermaid:3"],
    ["a styling statement", "flowchart TD\n  A --> B\n  classDef hot fill:#f00\n", "mermaid:3"],
    ["a connector with no endpoint", "flowchart TD\n  A -->\n", "mermaid:2"],
    ["two nodes sharing one title", "flowchart TD\n  A[Store] --> B[Store]\n", "mermaid:2"],
    ["a title the app cannot hold", "flowchart TD\n  A[HTTP/2] --> B\n", "mermaid:2"],
    ["a state statement with no mapping", "stateDiagram-v2\n  note left of A: hello\n", "mermaid:2"]
  ])("rejects %s as a structured envelope", async (_description, contents, path) => {
    const result = await run(["layout", "--from-mermaid", writeDiagram(contents, "broken.mmd")]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.any(String), details: { path, expected: expect.any(String), hint: expect.any(String) } }
    });
  });

  it("reports an unreadable diagram as a structured envelope", async () => {
    const result = await run(["layout", "--from-mermaid", join(tempDir, "missing.mmd")]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "invalid_input", details: { path: "mermaid" } } });
  });

  it.each([
    ["a canvas spec and a mermaid diagram together", ["layout", "spec.canvas.md", "--from-mermaid", "graph.mmd"]],
    ["--canvas without a mermaid diagram", ["layout", "spec.canvas.md", "--canvas", "Flow"]],
    ["--schema with a mermaid diagram", ["layout", "--schema", "--from-mermaid", "graph.mmd"]]
  ])("rejects %s as a usage error", async (_description, args) => {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "invalid_input", details: { path: "usage" } } });
  });
});
