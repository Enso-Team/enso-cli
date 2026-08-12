import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeConfig } from "../../src/config.js";
import { buildProgram } from "../../src/index.js";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

describe("commands", () => {
  it("exposes only the new surgical removal names", () => {
    const program = buildProgram();
    for (const group of ["node", "portal"]) {
      const command = program.commands.find((candidate) => candidate.name() === group)!;
      expect(command.commands.map((candidate) => candidate.name())).toContain("remove");
      expect(command.commands.map((candidate) => candidate.name())).not.toContain("delete");
    }
    const link = program.commands.find((candidate) => candidate.name() === "link")!;
    expect(link.commands.map((candidate) => candidate.name())).toEqual(expect.arrayContaining(["remove", "delete"]));
    const primitive = program.commands.find((candidate) => candidate.name() === "primitive")!;
    expect(primitive.commands.map((candidate) => candidate.name())).toEqual(["list", "line", "region", "update", "delete"]);
  });

  const cases: Array<[string[], string, string]> = [
    [["status"], "/v1/status", "GET"],
    [["vault", "current"], "/v1/vault/current", "GET"],
    [["vault", "tree"], "/v1/vault/tree", "GET"],
    [["search", "auth"], "/v1/search?q=auth", "GET"],
    [["search", "auth link"], "/v1/search?q=auth%20link", "GET"],
    [["canvas", "list"], "/v1/canvases", "GET"],
    [["canvas", "current"], "/v1/canvases/current", "GET"],
    [["canvas", "create", "Roadmap"], "/v1/canvases?dryRun=false", "POST"],
    [["canvas", "open", "Roadmap"], "/v1/canvases/Roadmap/open?dryRun=false", "POST"],
    [["canvas", "inspect", "Roadmap"], "/v1/canvases/Roadmap/inspect", "GET"],
    [["node", "list", "--canvas", "current"], "/v1/nodes?canvas=current", "GET"],
    [["node", "read", "Auth"], "/v1/nodes/Auth", "GET"],
    [["node", "write", "Auth", "--content", "hello"], "/v1/nodes/Auth?dryRun=false", "PUT"],
    [["node", "create", "--title", "Auth"], "/v1/nodes?dryRun=false", "POST"],
    [["node", "move", "Auth", "--x", "1", "--y", "2"], "/v1/nodes/Auth?dryRun=false", "PUT"],
    [["node", "remove", "Auth"], "/v1/nodes/Auth?dryRun=false", "DELETE"],
    [["node", "neighbors", "Auth", "--depth", "2"], "/v1/nodes/Auth/neighbors?depth=2", "GET"],
    [["portal", "create", "--title", "Auth Detail", "--subcanvas-ref", "Canvases/Auth%20Detail.json"], "/v1/nodes?dryRun=false", "POST"],
    [["portal", "open", "Auth Detail"], "/v1/nodes/Auth%20Detail/subcanvas/open?dryRun=false", "POST"],
    [["portal", "change-subcanvas", "Auth Detail", "Canvases/New%20Detail.json"], "/v1/nodes/Auth%20Detail?dryRun=false", "PUT"],
    [["portal", "remove", "Auth Detail"], "/v1/nodes/Auth%20Detail?dryRun=false", "DELETE"],
    [["link", "list", "--canvas", "current"], "/v1/links?canvas=current", "GET"],
    [["link", "create", "A", "B", "--label", "uses"], "/v1/links?dryRun=false", "POST"],
    [["link", "update", "abc", "--label", "uses"], "/v1/links/abc?dryRun=false", "PUT"],
    [["link", "remove", "abc"], "/v1/links/abc?dryRun=false", "DELETE"],
    [["link", "delete", "abc"], "/v1/links/abc?dryRun=false", "DELETE"],
    [["primitive", "list"], "/v1/diagram-primitives", "GET"],
    [["primitive", "line", "--x1", "10", "--y1", "20", "--x2", "410", "--y2", "20"], "/v1/diagram-primitives?dryRun=false", "POST"],
    [["primitive", "region", "--x", "10", "--y", "20", "--width", "400", "--height", "240"], "/v1/diagram-primitives?dryRun=false", "POST"],
    [["primitive", "update", "abc", "--title", "Identity"], "/v1/diagram-primitives/abc?dryRun=false", "PUT"],
    [["primitive", "delete", "abc"], "/v1/diagram-primitives/abc?dryRun=false", "DELETE"],
    [["graph", "inspect"], "/v1/context", "POST"],
    [["graph", "broken"], "/v1/context", "POST"],
    [["graph", "path", "A", "B"], "/v1/context", "POST"],
    [["context", "--query", "auth"], "/v1/context", "POST"]
  ];

  it.each(cases)("routes %j", async (args, path, method) => {
    const result = await run(args);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(new URL(request.url).pathname + new URL(request.url).search).toBe(path);
    expect(request.init.method ?? "GET").toBe(method);
    expect((request.init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("passes dry-run in query and body", async () => {
    await run(["node", "write", "Auth", "--content", "hello", "--dry-run"]);
    const request = calls[0];
    expect(new URL(request.url).searchParams.get("dryRun")).toBe("true");
    expect(JSON.parse(String(request.init.body))).toMatchObject({ content: "hello", dryRun: true });
  });

  it("passes from-note in body on link delete", async () => {
    await run(["link", "delete", "abc"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ fromNote: true });
  });

  it("defaults from-note to false on link delete", async () => {
    await run(["link", "remove", "abc"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ fromNote: false });
  });

  it("emits null for primitive clear-title and clear-color", async () => {
    await run(["primitive", "update", "abc", "--clear-title", "--clear-color"]);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.title).toBeNull();
    expect(body.color).toBeNull();
  });

  it("rejects --title combined with --clear-title on primitive update", async () => {
    const result = await run(["primitive", "update", "abc", "--title", "New", "--clear-title"]);
    expect(result.code).not.toBe(0);
    expect(calls).toHaveLength(0);
    // Same structured error code as the analogous link update mutex guard.
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
  });

  it("rejects --color combined with --clear-color on primitive update", async () => {
    const result = await run(["primitive", "update", "abc", "--color", "#fff", "--clear-color"]);
    expect(result.code).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
  });

  it("rejects out-of-range fill-opacity on primitive region", async () => {
    const result = await run(["primitive", "region", "--x", "10", "--y", "20", "--width", "400", "--height", "240", "--fill-opacity", "5"]);
    expect(result.code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("creates note nodes explicitly", async () => {
    await run(["node", "create", "--title", "Auth", "--content", "hello", "--dry-run"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      kind: "note",
      title: "Auth",
      content: "hello",
      canvas: "current",
      dryRun: true
    });
  });

  it("places nodes with world-space x/y on create", async () => {
    await run(["node", "create", "--title", "Placed", "--x", "2700", "--y", "2850", "--dry-run"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      kind: "note",
      title: "Placed",
      x: 2700,
      y: 2850,
      dryRun: true
    });
  });

  it("omits x/y when not provided on create", async () => {
    await run(["node", "create", "--title", "Auto"]);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).not.toHaveProperty("x");
    expect(body).not.toHaveProperty("y");
  });

  it("passes portal operations", async () => {
    await run(["portal", "create", "--title", "Auth Detail", "--subcanvas-ref", "Canvases/Auth Detail.json", "--dry-run"]);
    expect(new URL(calls[0].url).pathname + new URL(calls[0].url).search).toBe("/v1/nodes?dryRun=true");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      kind: "portal",
      title: "Auth Detail",
      subcanvasRef: "Canvases/Auth Detail.json",
      canvas: "current",
      dryRun: true
    });

    await run(["portal", "open", "Auth Detail", "--dry-run"]);
    expect(new URL(calls[1].url).pathname + new URL(calls[1].url).search).toBe("/v1/nodes/Auth%20Detail/subcanvas/open?dryRun=true");
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ dryRun: true });

    await run(["portal", "change-subcanvas", "Auth Detail", "Canvases/New Detail.json"]);
    expect(new URL(calls[2].url).pathname + new URL(calls[2].url).search).toBe("/v1/nodes/Auth%20Detail?dryRun=false");
    expect(JSON.parse(String(calls[2].init.body))).toMatchObject({
      subcanvasRef: "Canvases/New Detail.json",
      dryRun: false
    });

    await run(["portal", "remove", "Auth Detail", "--dry-run"]);
    expect(new URL(calls[3].url).pathname + new URL(calls[3].url).search).toBe("/v1/nodes/Auth%20Detail?dryRun=true");
    expect(JSON.parse(String(calls[3].init.body))).toMatchObject({ dryRun: true });
  });

  it("passes link direction and color on create and update", async () => {
    await run(["link", "create", "A", "B", "--label", "uses", "--color", "#3B82F6", "--direction", "bidirectional"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      source: "A",
      target: "B",
      label: "uses",
      color: "#3B82F6",
      direction: "bidirectional",
      dryRun: false
    });

    await run(["link", "update", "abc", "--color", "green", "--direction", "undirected", "--dry-run"]);
    expect(new URL(calls[1].url).pathname + new URL(calls[1].url).search).toBe("/v1/links/abc?dryRun=true");
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({
      color: "green",
      direction: "undirected",
      dryRun: true
    });
  });

  it("rejects invalid link directions before sending", async () => {
    await expect(run(["link", "create", "A", "B", "--direction", "sideways"])).rejects.toThrow(
      "expected directed, undirected, or bidirectional"
    );
    expect(calls).toHaveLength(0);
  });

  it("sends label-only link update without syncProse", async () => {
    await run(["link", "update", "abc", "--label", "queries"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      label: "queries",
      dryRun: false
    });
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("syncProse");
  });

  it("sends syncProse on link update", async () => {
    await run(["link", "update", "abc", "--sync-prose"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      syncProse: true,
      dryRun: false
    });
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("label");
  });

  it("sends label and syncProse together on link update", async () => {
    await run(["link", "update", "abc", "--label", "queries", "--sync-prose"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      label: "queries",
      syncProse: true,
      dryRun: false
    });
  });

  it("sends null label when clearing canvas label", async () => {
    await run(["link", "update", "abc", "--clear-label"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      label: null,
      dryRun: false
    });
  });

  it("sends boundLine on link update without changing label semantics", async () => {
    await run([
      "link",
      "update",
      "abc",
      "--bound-line",
      "Streams events to [[Event Bus]] before persistence"
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      boundLine: "Streams events to [[Event Bus]] before persistence",
      dryRun: false
    });
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("syncProse");
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("label");
  });

  it("reads bound-line content from @file", async () => {
    const line = join(tempDir, "relation.md");
    writeFileSync(line, "Before [[Target]] after\n", "utf8");
    await run(["link", "update", "abc", "--bound-line", `@${line}`]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      boundLine: "Before [[Target]] after\n"
    });
  });

  it("rejects bound-line without a wikilink", async () => {
    const result = await run(["link", "update", "abc", "--bound-line", "no wikilink here"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects --sync-prose and --bound-line together", async () => {
    const result = await run(["link", "update", "abc", "--sync-prose", "--bound-line", "x [[T]]"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Cannot use --sync-prose and --bound-line together" }
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects --label and --clear-label together", async () => {
    const result = await run(["link", "update", "abc", "--label", "x", "--clear-label"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Cannot use --label and --clear-label together" }
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects --clear-label and --sync-prose together", async () => {
    const result = await run(["link", "update", "abc", "--clear-label", "--sync-prose"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Cannot use --clear-label and --sync-prose together" }
    });
    expect(calls).toHaveLength(0);
  });

  it("passes through link primaryBinding fields from bridge responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({
          ok: true,
          data: {
            link: {
              id: "link-1",
              sourceNodeID: "a",
              targetNodeID: "b",
              label: "queries",
              type: "interfile",
              isUnbound: false,
              primaryBinding: {
                status: "bound",
                lastKnownRelationText: "queries: [[Target]]"
              }
            }
          }
        });
      })
    );
    const result = await run(["--pretty", "link", "create", "A", "B", "--label", "queries"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        link: {
          isUnbound: false,
          primaryBinding: {
            status: "bound",
            lastKnownRelationText: "queries: [[Target]]"
          }
        }
      }
    });
  });

  it("keeps duplicate_link recovery inside the pretty JSON envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({
          ok: false,
          error: {
            code: "duplicate_link",
            message: "Link already exists between these nodes"
          }
        });
      })
    );
    const result = await run(["--pretty", "link", "create", "A", "B"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "duplicate_link", details: { hint: expect.stringContaining("link update") } }
    });
  });

  it("emits one duplicate_link JSON envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({
          ok: false,
          error: {
            code: "duplicate_link",
            message: "Link already exists between these nodes"
          }
        });
      })
    );
    const result = await run(["link", "create", "A", "B"]);
    expect(result.code).toBe(1);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "duplicate_link", details: { hint: expect.stringContaining("link update") } }
    });
  });

  it("omits vision context by default", async () => {
    await run(["context", "--canvas", "current"]);
    const request = calls[0];
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      canvas: "current",
      depth: 1
    });
    expect(JSON.parse(String(request.init.body))).not.toHaveProperty("vision");
  });

  it("projects default context to compact structural fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: {
        nodes: [{ id: "n1", title: "Auth", ref: "Files/Auth.md", markdownContent: "# very long", createdAt: "yesterday", position: { x: 1, y: 2 } }],
        links: [{ id: "l1", sourceNodeID: "n1", targetNodeID: "n2", boundLine: "long prose" }],
        diagramPrimitives: []
      } });
    }));
    const result = await run(["context", "--canvas", "current"]);
    const data = JSON.parse(result.stdout).data;
    expect(data.nodes[0]).toEqual({ id: "n1", title: "Auth", ref: "Files/Auth.md", position: { x: 1, y: 2 } });
    expect(data.links[0]).toEqual({ id: "l1", sourceNodeID: "n1", targetNodeID: "n2" });
  });

  it("requests file-backed viewport vision context", async () => {
    await run(["context", "--canvas", "current", "--vision"]);
    const request = calls[0];
    expect(new URL(request.url).pathname).toBe("/v1/context");
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      canvas: "current",
      depth: 1,
      vision: {
        enabled: true,
        scope: "viewport",
        transport: "file"
      }
    });
  });

  it("prints enriched vision diagnostics returned by the bridge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({
          ok: true,
          data: {
            context: {},
            vision: {
              ok: true,
              diagnostics: {
                ok: false,
                score: 0.78,
                metrics: {
                  nodeOverlapCount: 1,
                  nodeOffscreenCount: 0,
                  lowNodeGapCount: 0,
                  linkNodeIntersectionCount: 0,
                  linkCrossingCount: 0,
                  linkLabelOverlapCount: 0,
                  labelOffscreenCount: 0
                },
                issues: [
                  {
                    severity: "error",
                    code: "node_overlap",
                    message: "Two visible nodes overlap",
                    subjects: [{ type: "node", id: "node-a" }],
                    bounds: { x: 10, y: 20, width: 30, height: 40 }
                  }
                ]
              }
            }
          }
        });
      })
    );

    const result = await run(["--pretty", "context", "--canvas", "current", "--vision"]);

    expect(result.stderr).toBe("");
    expect(new URL(calls[0].url).pathname).toBe("/v1/context");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        vision: {
          diagnostics: {
            ok: false,
            score: 0.78,
            metrics: { nodeOverlapCount: 1 },
            issues: [{ code: "node_overlap" }]
          }
        }
      }
    });
  });

  it("omits vision element geometry from projected context", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: {
        nodes: [{ id: "n1", title: "Auth", position: { x: 1, y: 2 } }],
        links: [],
        diagramPrimitives: [],
        vision: {
          capturedAt: "2026-07-17T12:00:00Z",
          ok: true,
          scope: "viewport",
          viewport: { scale: 1, visibleRect: { x: 0, y: 0, width: 100, height: 100 } },
          diagnostics: { ok: true, score: 1, metrics: {}, issues: [] },
          image: { path: join(tempDir, "missing-capture.png"), width: 2660, height: 1996 },
          nodes: [{ id: "n1", bounds: { x: 1, y: 2 }, worldBounds: { x: 1, y: 2 }, fontSize: 12, selected: false, visible: true }],
          links: [{ id: "l1", path: [{ x: 0, y: 0 }], labelBounds: { x: 0, y: 0 } }],
          diagramPrimitives: [{ id: "p1", bounds: { x: 0, y: 0 } }]
        }
      } });
    }));
    const result = await run(["context", "--canvas", "current", "--vision"]);
    const vision = JSON.parse(result.stdout).data.vision;
    expect(vision).toMatchObject({
      ok: true,
      viewport: { scale: 1 },
      diagnostics: { score: 1 },
      image: { width: 2660, height: 1996 }
    });
    expect(vision).not.toHaveProperty("nodes");
    expect(vision).not.toHaveProperty("links");
    expect(vision).not.toHaveProperty("diagramPrimitives");
  });

  it("reads content from @file", async () => {
    const note = join(tempDir, "note.md");
    writeFileSync(note, "# Auth\n", "utf8");
    await run(["node", "write", "Auth", "--content", `@${note}`]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ content: "# Auth\n" });
  });

  it("unescapes literal \\n in --content before sending to bridge", async () => {
    await run(["node", "create", "--title", "Router", "--content", "# Router\\n\\nDispatches events."]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      content: "# Router\n\nDispatches events."
    });
  });

  it("unescapes literal \\n in link --bound-line", async () => {
    await run(["link", "update", "abc", "--bound-line", "Routes to [[Target]]\\nnext clause"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      boundLine: "Routes to [[Target]]\nnext clause"
    });
  });

  it("renders app unavailable as structured JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const result = await run(["status"]);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "app_unavailable",
        details: {
          bridgeUrl: "http://127.0.0.1:17650",
          hint: "Run `enso auth link` to relink, or launch the configured Enso app"
        }
      }
    });
  });

  it("rejects a non-loopback bridge URL before sending", async () => {
    writeConfig({ bridgeUrl: "http://192.0.2.10:17650", token: "test-token" });
    const result = await run(["status"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "invalid_bridge_url",
        details: { expected: "http://127.0.0.1, http://[::1], or http://localhost" }
      }
    });
  });

  it("renders bridge errors including ambiguous selectors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: false,
          error: {
            code: "ambiguous_selector",
            message: "Multiple nodes match",
            details: { candidates: [{ title: "Auth" }, { title: "Auth" }] }
          }
        })
      )
    );
    const result = await run(["node", "read", "Auth"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "ambiguous_selector" }
    });
  });
});
