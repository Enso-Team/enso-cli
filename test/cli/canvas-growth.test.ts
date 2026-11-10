import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { growthSteps } from "../../src/growth-apply.js";
import { CANVAS_WORLD_HOME } from "../../src/layout-centering.js";
import { CARD_GEOMETRY } from "../../src/layout.js";
import { calls, fixtureTarget, requestBody, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

type FakeNode = { id: string; kind: string; title: string; ref: string; noteID: string; position: { x: number; y: number } };

/** A bridge that keeps one Canvas in memory and applies node and link operations to it. */
function fakeBridge(): { nodes: FakeNode[]; links: Array<{ id: string; sourceNodeID: string; targetNodeID: string; label?: string }> } {
  const state = { nodes: [] as FakeNode[], links: [] as Array<{ id: string; sourceNodeID: string; targetNodeID: string; label?: string }> };
  const find = (selector: string): FakeNode | undefined => state.nodes.find((node) => [node.id, node.title, node.ref].includes(selector));
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/context" || path === "/v1/nodes") return Response.json({ ok: true, data: { nodes: state.nodes, links: state.links, marks: [], excerpts: [] } });
    if (path === "/v1/search") return Response.json({ ok: true, data: { results: [] } });
    if (path === "/v1/vault/current") return Response.json({ ok: true, data: { path: tempDir, vaultID: fixtureTarget.vaultID } });
    if (path === "/v1/excerpts") return Response.json({ ok: true, data: { excerpt: { id: "33333333-3333-4333-8333-333333333333" } } });
    if (path === "/v1/apply") {
      const results = [];
      for (const operation of body.operations as Array<Record<string, any>>) {
        if (body.dryRun) continue;
        if (operation.type === "node.create") {
          const node = { id: `n${state.nodes.length}`, kind: "note", title: operation.title, ref: `${operation.title}.md`, noteID: "44444444-4444-4444-8444-44444444444" + state.nodes.length, position: { x: operation.x, y: operation.y } };
          state.nodes.push(node);
          results.push({ node });
        }
        if (operation.type === "node.move") find(operation.selector)!.position = { x: operation.x, y: operation.y };
        if (operation.type === "link.create") {
          const link = { id: `5555555${state.links.length}-5555-4555-8555-555555555555`, sourceNodeID: find(operation.source)!.id, targetNodeID: find(operation.target)!.id, label: operation.label };
          state.links.push(link);
          results.push({ link });
        }
      }
      return Response.json({ ok: true, data: { results } });
    }
    return Response.json({ ok: true, data: {} });
  });
  return state;
}

const apply = (intent: Record<string, unknown>, ...flags: string[]) => run(["canvas", "apply", "--json", JSON.stringify({ canvas: "current", ...intent }), ...flags]);
const operations = () => calls.filter((call) => new URL(call.url).pathname === "/v1/apply").flatMap((call) => requestBody(call).operations as Array<Record<string, unknown>>);

describe("canvas apply growth", () => {
  it("places Nodes without coordinates and keeps growing across applies", async () => {
    const state = fakeBridge();
    const first = await apply({ nodes: [{ kind: "note", mode: "place", note: "Client" }] });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).data.growth).toMatchObject({ status: "started", placed: ["Client"] });
    expect(state.nodes[0].position).toEqual(CANVAS_WORLD_HOME);
    expect(existsSync(join(tempDir, "growth", `${fixtureTarget.canvasID}.json`))).toBe(true);

    const second = await apply({
      nodes: [{ kind: "note", mode: "place", note: "Sync server" }],
      links: [{ mode: "create", source: "Client", target: "Sync server", label: "sends updates to" }]
    });
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).data).toMatchObject({ applied: true, growth: { status: "continued", placed: ["Sync server"] } });
    expect(state.nodes[1].position).toEqual({ x: CANVAS_WORLD_HOME.x, y: CANVAS_WORLD_HOME.y + growthSteps(CARD_GEOMETRY, "TB").rank });
    expect(state.links).toHaveLength(1);
  });

  it("writes no turn on a dry run", async () => {
    fakeBridge();
    const result = await apply({ nodes: [{ kind: "note", mode: "place", note: "Client" }] }, "--dry-run");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.growth).toMatchObject({ status: "started" });
    expect(existsSync(join(tempDir, "growth"))).toBe(false);
  });

  it("creates Excerpts after the Node they quote lands, beside that Node", async () => {
    const state = fakeBridge();
    writeFileSync(join(tempDir, "Sync server.md"), "# Sync server\n\nRetries with backoff.\n");
    const result = await apply({
      nodes: [{ kind: "note", mode: "place", note: "Sync server" }],
      excerpts: [{ mode: "create", note: "Sync server", text: "Retries with backoff." }]
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.appliedBatches).toEqual([{ name: "nodePortalWrites", count: 1 }, { name: "excerpts", count: 1 }]);
    const excerpt = calls.find((call) => new URL(call.url).pathname === "/v1/excerpts")!;
    expect(requestBody(excerpt)).toMatchObject({ x: state.nodes[0].position.x + CARD_GEOMETRY.nodeWidth / 2 + 24, y: state.nodes[0].position.y - CARD_GEOMETRY.nodeHeight / 2 });
    expect(operations().map((operation) => operation.type)).toEqual(["node.create"]);
  });

  it("moves an Excerpt with the intent it belongs to when the intent lands on the empty-Canvas home", async () => {
    const state = fakeBridge();
    writeFileSync(join(tempDir, "Sync server.md"), "# Sync server\n\nRetries with backoff.\n");
    const result = await apply({
      nodes: [{ kind: "note", mode: "place", note: "Sync server", x: 0, y: 0 }],
      excerpts: [{ mode: "create", note: "Sync server", text: "Retries with backoff." }]
    });
    expect(result.code).toBe(0);
    const node = state.nodes[0].position;
    expect(Math.abs(node.x - CANVAS_WORLD_HOME.x)).toBeLessThan(CARD_GEOMETRY.nodeWidth);
    const excerpt = calls.find((call) => new URL(call.url).pathname === "/v1/excerpts")!;
    expect(requestBody(excerpt)).toMatchObject({ x: node.x + CARD_GEOMETRY.nodeWidth / 2 + 24, y: node.y - CARD_GEOMETRY.nodeHeight / 2 });
  });

  it("checks an Excerpt's passage against its Note on a dry run", async () => {
    fakeBridge();
    writeFileSync(join(tempDir, "Sync server.md"), "# Sync server\n\nRetries with backoff.\n");
    const result = await apply({
      nodes: [{ kind: "note", mode: "place", note: "Sync server" }],
      excerpts: [{ mode: "create", note: "Sync server", text: "Never retries." }]
    }, "--dry-run");
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stderr || result.stdout).error.code).toBe("passage_not_found");
  });
});
