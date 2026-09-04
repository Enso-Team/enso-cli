import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

// Frozen from the operation set the released Enso app (1.2.2) accepts on /v1/apply.
// The app rejects anything else as an unsupported patch operation, so an operation the
// compiler learns to emit outside this set fails on a paired app. Widen this list only
// after confirming the released app accepts the new type.
const RELEASED_BRIDGE_OPS = new Set([
  "node.create", "node.write", "node.move", "node.delete",
  "portal.create", "portal.open", "portal.delete", "portal.changeSubcanvas",
  "canvas.create", "canvas.open",
  "link.create", "link.update", "link.delete",
  "line.create", "divider.create", "group.create",
  "diagramPrimitive.update", "diagramPrimitive.delete"
]);

// A reuse member and a cluster are required: without them placeExisting and group.create
// never appear in the compiled phases.
const CONTRACT_SPEC = [
  "---",
  "canvas: current",
  "direction: LR",
  "members:",
  "  - Gateway",
  "  - Router",
  "  - title: Object Store",
  "    mode: reuse",
  "edges:",
  "  - from: Gateway",
  "    to: Router",
  "    label: routes",
  "  - from: Router",
  "    to: Object Store",
  "clusters:",
  "  - name: Edge",
  "    color: \"#6B7280\"",
  "    members:",
  "      - Gateway",
  "      - Router",
  "---",
  "",
  "Every op type the compiler can emit.",
  ""
].join("\n");

// The mermaid front end compiles through the same engine, so it emits the same op set:
// a vault title places an existing Note, an unmatched title creates one, a subgraph groups.
const CONTRACT_DIAGRAM = [
  "flowchart LR",
  "  subgraph Edge",
  "    Gateway -->|routes| Router",
  "  end",
  "  Router --> Store[Object Store]",
  ""
].join("\n");

function mockVault(): void {
  vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const target = new URL(String(url));
    if (target.pathname === "/v1/context") return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
    if (target.pathname === "/v1/search") {
      const query = target.searchParams.get("q");
      return Response.json({ ok: true, data: { results: query === "Object Store" ? [{ node: { title: query } }] : [] } });
    }
    return Response.json({ ok: true, data: {} });
  });
}

describe("layout bridge contract", () => {
  it("emits only operation types the released bridge implements", async () => {
    mockVault();
    const spec = join(tempDir, "contract.canvas.md");
    writeFileSync(spec, CONTRACT_SPEC);

    const result = await run(["layout", spec, "--apply", "--dry-run"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const phases = JSON.parse(result.stdout).data.applied.phases as Array<{ operations: Array<{ type: string }> }>;
    const emitted = [...new Set(phases.flatMap((phase) => phase.operations.map((operation) => operation.type)))].sort();

    expect(emitted.filter((type) => !RELEASED_BRIDGE_OPS.has(type))).toEqual([]);
    expect(emitted).toEqual(["group.create", "link.create", "node.create"]);
    expect(phases.flatMap((phase) => phase.operations).some((operation) => "placeExisting" in operation)).toBe(true);
  });

  it("keeps the operation set the same for a mermaid diagram", async () => {
    mockVault();
    const diagram = join(tempDir, "contract.mmd");
    writeFileSync(diagram, CONTRACT_DIAGRAM);

    const result = await run(["layout", "--from-mermaid", diagram, "--apply", "--dry-run"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const phases = JSON.parse(result.stdout).data.applied.phases as Array<{ operations: Array<{ type: string }> }>;
    const emitted = [...new Set(phases.flatMap((phase) => phase.operations.map((operation) => operation.type)))].sort();

    expect(emitted.filter((type) => !RELEASED_BRIDGE_OPS.has(type))).toEqual([]);
    expect(emitted).toEqual(["group.create", "link.create", "node.create"]);
    expect(phases.flatMap((phase) => phase.operations).some((operation) => "placeExisting" in operation)).toBe(true);
  });
});
