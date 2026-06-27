import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/index.js";
import { writeConfig } from "../src/config.js";
import { LAYOUT_GEOMETRY } from "../src/layout.js";

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
    [["primitive", "list"], "/v1/diagram-primitives", "GET"],
    [["primitive", "line", "--x1", "10", "--y1", "20", "--x2", "410", "--y2", "20"], "/v1/diagram-primitives?dryRun=false", "POST"],
    [["primitive", "divider", "--orientation", "horizontal", "--x", "10", "--y", "20", "--length", "400"], "/v1/diagram-primitives?dryRun=false", "POST"],
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
    await run(["link", "delete", "abc", "--from-note"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ fromNote: true });
  });

  it("defaults from-note to false on link delete", async () => {
    await run(["link", "delete", "abc"]);
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

describe("layout", () => {
  it("exposes spacing constants for agent layout recipes", () => {
    expect(LAYOUT_GEOMETRY).toMatchObject({ colStep: 450, rowStep: 280, nodeWidth: 220, nodeHeight: 140 });
  });
});

describe("canvas apply", () => {
  it("builds notes, portals, links, regions, dividers, and lines from one JSON file", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      }
      return Response.json({ ok: true, data: { url: String(url), method: init?.method ?? "GET" } });
    });
    const intent = join(tempDir, "sync-server.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "Sync Server",
      nodes: [
        { kind: "note", title: "CLI", content: "Command surface", x: 550, y: 2000 },
        { kind: "existing", title: "Vault Manager", x: 1000, y: 2000 },
        { kind: "portal", title: "Sync Detail", subcanvasRef: "Canvases/Sync Detail.json", x: 1450, y: 2000 }
      ],
      links: [
        { source: "CLI", target: "Vault Manager", label: "writes through", direction: "directed" },
        { source: "Vault Manager", target: "Sync Detail", label: "syncs", direction: "directed" }
      ],
      regions: [
        { title: "Persistence", x: 1225, y: 2000, width: 830, height: 300 }
      ],
      dividers: [
        { title: "Control Plane", orientation: "horizontal", x: 1000, y: 1820, length: 1220 }
      ],
      lines: [
        { title: "Section split", x1: 800, y1: 2300, x2: 1700, y2: 2300, color: "#6B7280" }
      ]
    }));

    const result = await run(["canvas", "apply", intent]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(new URL(calls[0].url).pathname).toBe("/v1/context");
    // A named canvas is opened before applying so operations land on the right canvas.
    const openCall = calls.find((call) => new URL(call.url).pathname === "/v1/canvases/Sync%20Server/open");
    expect(openCall).toBeDefined();
    expect(new URL(openCall!.url).searchParams.get("dryRun")).toBe("false");

    const applyCalls = calls.filter((call) => new URL(call.url).pathname === "/v1/apply");
    // Every batch — not just the first — must carry ?dryRun=false on a real apply.
    expect(applyCalls).toHaveLength(3);
    for (const call of applyCalls) {
      expect(new URL(call.url).searchParams.get("dryRun")).toBe("false");
    }
    const nodePatch = JSON.parse(String(applyCalls[0].init.body));
    expect(nodePatch.operations).toMatchObject([
      { type: "node.create", title: "CLI", content: "Command surface", x: 550, y: 2000 },
      { type: "node.create", title: "Vault Manager", placeExisting: true, x: 1000, y: 2000 },
      { type: "portal.create", title: "Sync Detail", subcanvasRef: "Canvases/Sync Detail.json", x: 1450, y: 2000 }
    ]);

    const linkPatch = JSON.parse(String(applyCalls[1].init.body));
    expect(linkPatch.operations).toMatchObject([
      { type: "link.create", source: "CLI", target: "Vault Manager", label: "writes through", direction: "directed" },
      { type: "link.create", source: "Vault Manager", target: "Sync Detail", label: "syncs", direction: "directed" }
    ]);

    const primitivePatch = JSON.parse(String(applyCalls[2].init.body));
    expect(primitivePatch.operations).toMatchObject([
      { type: "group.create", title: "Persistence", x: 1225, y: 2000, width: 830, height: 300 },
      { type: "divider.create", title: "Control Plane", orientation: "horizontal", x: 1000, y: 1820, length: 1220 },
      { type: "line.create", title: "Section split", x1: 800, y1: 2300, x2: 1700, y2: 2300, color: "#6B7280" }
    ]);
  });

  it("retargets an existing portal via the subcanvas shorthand", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: {
          nodes: [{ id: "portal-1", title: "Sync Detail", position: { x: 1450, y: 2000 } }],
          links: [],
          diagramPrimitives: []
        } });
      }
      return Response.json({ ok: true, data: { url: String(url), method: init?.method ?? "GET" } });
    });
    const intent = join(tempDir, "retarget.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "Sync Server",
      nodes: [{ kind: "portal", title: "Sync Detail", subcanvas: "New Detail.json" }]
    }));

    const result = await run(["canvas", "apply", intent]);
    expect(result.code).toBe(0);
    const applyCall = calls.find((call) => new URL(call.url).pathname === "/v1/apply");
    const nodePatch = JSON.parse(String(applyCall!.init.body));
    expect(nodePatch.operations).toMatchObject([
      { type: "portal.changeSubcanvas", selector: "Sync Detail", subcanvasRef: "Canvases/New Detail.json" }
    ]);
  });

  it("reports partial-apply state when a later batch fails", async () => {
    let applyCalls = 0;
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/context") {
        return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      }
      if (pathname !== "/v1/apply") return Response.json({ ok: true, data: {} });
      applyCalls += 1;
      if (applyCalls === 1) return Response.json({ ok: true, data: {} });
      return Response.json({ ok: false, error: { code: "invalid_input", message: "link failed", details: {} } });
    });
    const intent = join(tempDir, "partial.json");
    writeFileSync(intent, JSON.stringify({
      canvas: "X",
      nodes: [{ kind: "note", title: "A", content: "a", x: 1, y: 1 }, { kind: "note", title: "B", content: "b", x: 2, y: 2 }],
      links: [{ source: "A", target: "B" }]
    }));

    const result = await run(["canvas", "apply", intent]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.details.partialApply).toMatchObject({
      failedBatch: "links",
      applied: { nodeOps: 2, linkOps: 0, primitiveOps: 0 }
    });
  });

  it("updates existing primitives by title and sends dryRun=false on every batch", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: {
          nodes: [],
          links: [],
          diagramPrimitives: [
            { id: "grp-1", kind: "group", title: "Persistence" },
            { id: "div-1", kind: "line", title: "Boundary", orientation: "horizontal" },
            { id: "line-1", kind: "line", title: "Boundary" }
          ]
        } });
      }
      return Response.json({ ok: true, data: {} });
    });
    const intent = join(tempDir, "dedupe.json");
    writeFileSync(intent, JSON.stringify({
      regions: [{ title: "Persistence", x: 1, y: 2, width: 100, height: 50 }],
      dividers: [{ title: "Boundary", orientation: "horizontal", x: 1, y: 2, length: 100 }],
      lines: [{ title: "Boundary", x1: 1, y1: 2, x2: 3, y2: 4 }]
    }));

    const result = await run(["canvas", "apply", intent]);
    expect(result.code).toBe(0);
    const applyCall = calls.find((call) => new URL(call.url).pathname === "/v1/apply")!;
    expect(new URL(applyCall.url).searchParams.get("dryRun")).toBe("false");
    // divider matches the orientation primitive, line matches the orientation-less one — no cross-update.
    expect(JSON.parse(String(applyCall.init.body)).operations).toMatchObject([
      { type: "diagramPrimitive.update", id: "grp-1", title: "Persistence" },
      { type: "diagramPrimitive.update", id: "div-1", title: "Boundary" },
      { type: "diagramPrimitive.update", id: "line-1", title: "Boundary" }
    ]);
  });

  it("rejects duplicate node and primitive titles before any bridge call", async () => {
    const dupNodes = join(tempDir, "dup-nodes.json");
    writeFileSync(dupNodes, JSON.stringify({ nodes: [{ title: "A", x: 1, y: 1 }, { title: "A", x: 2, y: 2 }] }));
    const r1 = await run(["canvas", "apply", dupNodes, "--dry-run"]);
    expect(r1.code).toBe(1);
    expect(calls).toHaveLength(0);

    const dupRegions = join(tempDir, "dup-regions.json");
    writeFileSync(dupRegions, JSON.stringify({ regions: [
      { title: "R", x: 1, y: 1, width: 10, height: 10 },
      { title: "R", x: 2, y: 2, width: 10, height: 10 }
    ] }));
    const r2 = await run(["canvas", "apply", dupRegions, "--dry-run"]);
    expect(r2.code).toBe(1);
    expect(calls).toHaveLength(0);

    const dupLinks = join(tempDir, "dup-links.json");
    writeFileSync(dupLinks, JSON.stringify({ links: [
      { source: "A", target: "B" },
      { source: "A", target: "B" }
    ] }));
    const r3 = await run(["canvas", "apply", dupLinks, "--dry-run"]);
    expect(r3.code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("skips node.move when an existing node's position is unchanged", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: {
          nodes: [{ id: "n1", title: "A", displayTitle: "A", position: { x: 5, y: 5 } }],
          links: [], diagramPrimitives: []
        } });
      }
      return Response.json({ ok: true, data: {} });
    });
    const intent = join(tempDir, "noop-move.json");
    writeFileSync(intent, JSON.stringify({ nodes: [{ kind: "note", title: "A", x: 5, y: 5 }] }));
    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(0);
    // No batches: the only node is unchanged, so no node.move op is emitted.
    expect(JSON.parse(result.stdout).data.planned.nodeOps).toBe(0);
  });

  it("rejects content on an existing node", async () => {
    const intent = join(tempDir, "existing-content.json");
    writeFileSync(intent, JSON.stringify({
      nodes: [{ kind: "existing", title: "API Gateway", content: "updated body", x: 1, y: 2 }]
    }));
    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("rejects a subcanvas shorthand containing path separators", async () => {
    const intent = join(tempDir, "bad-subcanvas.json");
    writeFileSync(intent, JSON.stringify({
      nodes: [{ kind: "portal", title: "Detail", subcanvas: "Canvases/Detail.json", x: 1, y: 2 }]
    }));
    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("dry-runs only the first bridge patch and returns the full compiled plan", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      }
      return Response.json({ ok: true, data: { dryRun: true, valid: true } });
    });
    const intent = join(tempDir, "auth-flow-dry-run.json");
    writeFileSync(intent, JSON.stringify({
      nodes: [
        { title: "A", x: 100, y: 200 },
        { title: "B", x: 550, y: 200 }
      ],
      links: [{ source: "A", target: "B" }]
    }));

    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).pathname + new URL(calls[1].url).search).toBe("/v1/apply?dryRun=true");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        dryRun: true,
        valid: true,
        planned: { nodeOps: 2, linkOps: 1, primitiveOps: 0 }
      }
    });
  });

  it("forwards the bridge's valid:false verdict on dry-run", async () => {
    vi.mocked(fetch).mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/context") {
        return Response.json({ ok: true, data: { nodes: [], links: [], diagramPrimitives: [] } });
      }
      return Response.json({ ok: true, data: { dryRun: true, valid: false } });
    });
    const intent = join(tempDir, "invalid-dry-run.json");
    writeFileSync(intent, JSON.stringify({ nodes: [{ title: "A", x: 1, y: 2 }] }));

    const result = await run(["canvas", "apply", intent, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { dryRun: true, valid: false } });
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
