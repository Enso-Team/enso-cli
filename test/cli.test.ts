import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/index.js";
import { writeConfig } from "../src/config.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

const nativeFetch = globalThis.fetch.bind(globalThis);
const calls: FetchCall[] = [];
let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "enso-cli-"));
  process.env.ENSO_CLI_CONFIG_DIR = tempDir;
  process.env.ENSO_CLI_OPEN = "0";
  calls.length = 0;
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: { url: String(url), method: init?.method ?? "GET" } });
    })
  );
  writeConfig({ bridgeUrl: "http://127.0.0.1:17650", token: "test-token" });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENSO_CLI_CONFIG_DIR;
  delete process.env.ENSO_CLI_OPEN;
  delete process.env.ENSO_CLI_PAIRING_URL_FILE;
  delete process.env.ENSO_CLI_SKILL_INSTALLER_BIN;
  delete process.env.MOCK_NPX_ARGS_FILE;
  vi.unstubAllGlobals();
});

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await buildProgram().parseAsync(["node", "enso", ...args], { from: "node" });
    return { stdout: stdout.join(""), stderr: stderr.join(""), code: process.exitCode };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = originalExitCode;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("commands", () => {
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
    [["node", "delete", "Auth"], "/v1/nodes/Auth?dryRun=false", "DELETE"],
    [["node", "neighbors", "Auth", "--depth", "2"], "/v1/nodes/Auth/neighbors?depth=2", "GET"],
    [["portal", "create", "--title", "Auth Detail", "--subcanvas-ref", "Canvases/Auth%20Detail.json"], "/v1/nodes?dryRun=false", "POST"],
    [["portal", "open", "Auth Detail"], "/v1/nodes/Auth%20Detail/subcanvas/open?dryRun=false", "POST"],
    [["portal", "change-subcanvas", "Auth Detail", "Canvases/New%20Detail.json"], "/v1/nodes/Auth%20Detail?dryRun=false", "PUT"],
    [["portal", "delete", "Auth Detail"], "/v1/nodes/Auth%20Detail?dryRun=false", "DELETE"],
    [["link", "list", "--canvas", "current"], "/v1/links?canvas=current", "GET"],
    [["link", "create", "A", "B", "--label", "uses"], "/v1/links?dryRun=false", "POST"],
    [["link", "update", "abc", "--label", "uses"], "/v1/links/abc?dryRun=false", "PUT"],
    [["link", "delete", "abc"], "/v1/links/abc?dryRun=false", "DELETE"],
    [["diagram", "list"], "/v1/diagram-primitives", "GET"],
    [["diagram", "line", "--x1", "10", "--y1", "20", "--x2", "410", "--y2", "20"], "/v1/diagram-primitives?dryRun=false", "POST"],
    [["diagram", "divider", "--orientation", "horizontal", "--x", "10", "--y", "20", "--length", "400"], "/v1/diagram-primitives?dryRun=false", "POST"],
    [["diagram", "group", "--x", "10", "--y", "20", "--width", "400", "--height", "240"], "/v1/diagram-primitives?dryRun=false", "POST"],
    [["diagram", "update", "abc", "--title", "Identity"], "/v1/diagram-primitives/abc?dryRun=false", "PUT"],
    [["diagram", "delete", "abc"], "/v1/diagram-primitives/abc?dryRun=false", "DELETE"],
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

    await run(["portal", "delete", "Auth Detail", "--dry-run"]);
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

  it("surfaces duplicate_link hint with --pretty", async () => {
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
    expect(result.stderr).toContain("duplicate_link");
    expect(result.stderr).toContain("Use link update on the existing link id");
  });

  it("surfaces duplicate_link errors with a stderr hint", async () => {
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
    const [envelopeLine] = result.stderr.trim().split("\n");
    expect(JSON.parse(envelopeLine)).toMatchObject({
      ok: false,
      error: { code: "duplicate_link" }
    });
    expect(result.stderr).toContain("Use link update on the existing link id");
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
      error: { code: "app_unavailable" }
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

describe("auth", () => {
  it("reports local auth status and unlinks", async () => {
    expect((await run(["auth", "status"])).stdout).toContain("Enso CLI is linked to the Enso app.");
    expect(JSON.parse((await run(["--pretty", "auth", "status"])).stdout)).toMatchObject({
      ok: true,
      data: { status: "linked", linked: true }
    });
    expect((await run(["auth", "unlink"])).stdout).toBe("Enso CLI is no longer linked to the Enso app.\n");
    expect(JSON.parse((await run(["--pretty", "auth", "unlink"])).stdout)).toMatchObject({
      ok: true,
      data: { status: "unlinked", linked: false }
    });
    expect((await run(["auth", "status"])).stdout).toBe("Enso CLI is not linked to the Enso app.\n");
  });

  it("links through the localhost callback flow", async () => {
    const urlFile = join(tempDir, "pairing-url.txt");
    process.env.ENSO_CLI_PAIRING_URL_FILE = urlFile;

    const pending = run(["auth", "link"]);
    let settled = false;
    const pendingResult = pending.finally(() => {
      settled = true;
    });
    let pairingUrl = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        pairingUrl = readFileSync(urlFile, "utf8");
        break;
      } catch {
        await sleep(10);
      }
    }

    const parsed = new URL(pairingUrl);
    const callback = parsed.searchParams.get("callback");
    const nonce = parsed.searchParams.get("nonce");
    expect(callback).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(new URL(request.url).pathname).toBe("/v1/pair/request");
    expect(JSON.parse(String(request.init.body))).toMatchObject({ callback, nonce });

    await sleep(20);
    expect(settled).toBe(false);

    await nativeFetch(callback!, {
      method: "POST",
      body: JSON.stringify({ token: "paired-token", bridgeUrl: "http://127.0.0.1:17651", nonce })
    });

    const result = await pendingResult;
    expect(result.stdout).toContain("Enso CLI linked successfully.");
    expect(result.stdout).toContain("Bridge: http://127.0.0.1:17651");
    expect(result.stdout).toContain("Linked at:");
    expect(JSON.parse(readFileSync(join(tempDir, "config.json"), "utf8"))).toMatchObject({
      token: "paired-token"
    });
  });
});

describe("apply and skill", () => {
  it("validates patch input before sending", async () => {
    const patch = join(tempDir, "patch.json");
    writeFileSync(patch, JSON.stringify({ operations: [{ type: "node.write", selector: "Auth", content: "x" }] }));
    await run(["apply", patch, "--dry-run"]);
    expect(new URL(calls[0].url).pathname + new URL(calls[0].url).search).toBe("/v1/apply?dryRun=true");
  });

  it("allows link visual fields in apply patches", async () => {
    const patch = join(tempDir, "link-visuals.json");
    writeFileSync(patch, JSON.stringify({
      operations: [
        {
          type: "link.create",
          source: "A",
          target: "B",
          label: "uses",
          color: "#3B82F6",
          direction: "directed"
        },
        {
          type: "link.update",
          id: "abc",
          color: "green",
          direction: "undirected"
        },
        {
          type: "link.update",
          id: "def",
          label: "queries"
        },
        {
          type: "link.update",
          id: "ghi",
          boundLine: "Custom prose with [[Target]] in the middle"
        }
      ]
    }));

    await run(["apply", patch, "--dry-run"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      dryRun: true,
      operations: [
        { type: "link.create", color: "#3B82F6", direction: "directed" },
        { type: "link.update", id: "abc", color: "green", direction: "undirected" },
        { type: "link.update", id: "def", label: "queries" },
        { type: "link.update", id: "ghi", boundLine: "Custom prose with [[Target]] in the middle" }
      ]
    });
  });

  it("rejects apply link.update with label null and syncProse", async () => {
    const patch = join(tempDir, "bad-link-update.json");
    writeFileSync(
      patch,
      JSON.stringify({ operations: [{ type: "link.update", id: "abc", label: null, syncProse: true }] })
    );
    const result = await run(["apply", patch, "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("allows diagram primitive fields in apply patches", async () => {
    const patch = join(tempDir, "diagram-primitives.json");
    writeFileSync(patch, JSON.stringify({
      operations: [
        {
          type: "line.create",
          x1: 100,
          y1: 180,
          x2: 1000,
          y2: 180,
          title: "Section split",
          color: "#6B7280"
        },
        {
          type: "divider.create",
          orientation: "horizontal",
          x: 100,
          y: 200,
          length: 900,
          title: "Live sync",
          color: "#6B7280",
          lineStyle: "dashed"
        },
        {
          type: "group.create",
          x: 80,
          y: 240,
          width: 1000,
          height: 360,
          title: "Persistence",
          fillOpacity: 0.08
        },
        {
          type: "diagramPrimitive.update",
          id: "abc",
          title: null,
          x: 90
        },
        {
          type: "diagramPrimitive.delete",
          id: "def"
        }
      ]
    }));

    await run(["apply", patch, "--dry-run"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      dryRun: true,
      operations: [
        { type: "line.create", x1: 100, y1: 180, x2: 1000, y2: 180 },
        { type: "divider.create", orientation: "horizontal", length: 900 },
        { type: "group.create", width: 1000, height: 360, fillOpacity: 0.08 },
        { type: "diagramPrimitive.update", id: "abc", title: null, x: 90 },
        { type: "diagramPrimitive.delete", id: "def" }
      ]
    });
  });

  it("allows portal operations in apply patches", async () => {
    const patch = join(tempDir, "portals.json");
    writeFileSync(patch, JSON.stringify({
      operations: [
        { type: "portal.create", title: "Auth Detail", subcanvasRef: "Canvases/Auth Detail.json" },
        { type: "portal.open", selector: "Auth Detail" },
        { type: "portal.changeSubcanvas", selector: "Auth Detail", subcanvasRef: "Canvases/New Detail.json" },
        { type: "portal.delete", selector: "Auth Detail" }
      ]
    }));

    await run(["apply", patch, "--dry-run"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      dryRun: true,
      operations: [
        { type: "portal.create", title: "Auth Detail", subcanvasRef: "Canvases/Auth Detail.json" },
        { type: "portal.open", selector: "Auth Detail" },
        { type: "portal.changeSubcanvas", selector: "Auth Detail", subcanvasRef: "Canvases/New Detail.json" },
        { type: "portal.delete", selector: "Auth Detail" }
      ]
    });
  });

  it("installs the bundled skill through the npx skills installer", async () => {
    const mockInstaller = join(tempDir, "mock-npx.js");
    const argsFile = join(tempDir, "mock-npx-args.json");
    writeFileSync(mockInstaller, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.MOCK_NPX_ARGS_FILE, JSON.stringify(process.argv.slice(2), null, 2));",
      "process.stdout.write('skills installer stdout');",
      "process.stderr.write('skills installer stderr');"
    ].join("\n"), "utf8");
    chmodSync(mockInstaller, 0o755);
    process.env.ENSO_CLI_SKILL_INSTALLER_BIN = mockInstaller;
    process.env.MOCK_NPX_ARGS_FILE = argsFile;

    const result = await run(["skill", "install"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        installed: true,
        installer: mockInstaller,
        stdout: "skills installer stdout",
        stderr: "skills installer stderr"
      }
    });

    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args[0]).toBe("--yes");
    expect(args[1]).toBe("skills");
    expect(args[2]).toBe("add");
    expect(args[3]).toMatch(/skills\/enso-agent$/);
    expect(args.slice(4)).toEqual(["-g", "-y", "--copy"]);
  });
});
