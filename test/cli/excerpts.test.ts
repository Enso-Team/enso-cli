import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bodyOffset, passageSelection } from "../../src/excerpt-model.js";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

const EXCERPT = "33333333-3333-4333-8333-333333333333";
const NODE = "44444444-4444-4444-8444-444444444444";
const NOTE = "55555555-5555-4555-8555-555555555555";
const OTHER_NOTE = "77777777-7777-4777-8777-777777777777";
const LINK = "66666666-6666-4666-8666-666666666666";
const MARKDOWN = "---\ntags: [auth]\n---\n# Auth\n\nTokens expire after an hour. Tokens rotate.\n";

function writeIndex(id: string, vaultRootPath: string, uuid: string): void {
  const folder = join(tempDir, "vault-index", id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "index.json"), JSON.stringify({
    schemaVersion: 1,
    vaultRootPath,
    entries: [
      { kind: "canvas", path: "Canvases/x.json", uuid: NOTE },
      { kind: "note", path: "docs/Auth.md", uuid }
    ]
  }));
}

function body(index: number): unknown {
  return JSON.parse(String(calls[index].init.body));
}

function path(index: number): string {
  return new URL(calls[index].url).pathname + new URL(calls[index].url).search;
}

function bridge(node: Record<string, unknown> = { id: NODE, kind: "note", title: "Auth", ref: "docs/Auth.md", noteID: NOTE }) {
  const vault = join(tempDir, "vault");
  mkdirSync(join(vault, "docs"), { recursive: true });
  writeFileSync(join(vault, "docs/Auth.md"), MARKDOWN);
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/nodes") return Response.json({ ok: true, data: { nodes: [node] } });
    if (pathname === "/v1/vault/current") return Response.json({ ok: true, data: { path: vault } });
    return Response.json({ ok: true, data: { excerpt: { id: EXCERPT } } });
  });
}

describe("excerpt passages", () => {
  it("addresses a passage in UTF-16 offsets of the whole file, after the frontmatter", () => {
    const markdown = "---\nid: x\n---\n🙂 Tokens expire.";
    expect(bodyOffset(markdown)).toBe(14);
    expect(passageSelection(NOTE, markdown, "Tokens expire.")).toEqual({
      noteID: NOTE, rawRange: [17, 14], capturedMarkdown: "Tokens expire.", selectedMarkdown: "Tokens expire."
    });
  });

  it("ignores text inside the frontmatter", () => {
    expect(() => passageSelection(NOTE, "---\ntitle: Tokens\n---\nBody", "Tokens")).toThrow("does not contain");
  });

  it("asks for an occurrence when the passage repeats", () => {
    expect(() => passageSelection(NOTE, MARKDOWN, "Tokens")).toThrow("2 times");
    expect(passageSelection(NOTE, MARKDOWN, "Tokens", 2).rawRange).toEqual([MARKDOWN.lastIndexOf("Tokens"), 6]);
  });
});

describe("excerpt commands", () => {
  it.each([
    [["excerpt", "list"], "/v1/excerpts", "GET"],
    [["excerpt", "get", EXCERPT], `/v1/excerpts/${EXCERPT}`, "GET"],
    [["excerpt", "source", EXCERPT], `/v1/excerpts/${EXCERPT}/source`, "GET"],
    [["excerpt", "delete", EXCERPT], `/v1/excerpts/${EXCERPT}?dryRun=false`, "DELETE"],
    [["excerpt", "connect", EXCERPT, "Auth"], `/v1/excerpts/${EXCERPT}/connect?dryRun=false`, "POST"],
    [["excerpt", "remove-from-note", EXCERPT, "--dry-run"], `/v1/excerpts/${EXCERPT}/remove-from-note?dryRun=true`, "POST"]
  ])("routes %j", async (args, route, method) => {
    const result = await run(args);
    expect(result.code).toBe(0);
    expect(path(0)).toBe(route);
    expect(calls[0].init.method).toBe(method);
  });

  it("creates an excerpt of a note passage from the note's node", async () => {
    bridge();
    const result = await run(["excerpt", "create", "--note", "Auth", "--text", "expire after an hour", "--x", "40", "--y", "-20"]);
    expect(result.code).toBe(0);
    expect(path(2)).toBe("/v1/excerpts?dryRun=false");
    expect(body(2)).toEqual({
      selection: {
        noteID: NOTE,
        rawRange: [MARKDOWN.indexOf("expire after an hour"), 20],
        capturedMarkdown: "expire after an hour",
        selectedMarkdown: "expire after an hour"
      },
      x: 40, y: -20, dryRun: false
    });
  });

  it("matches the note by its vault-relative path and forwards a dry run", async () => {
    bridge();
    await run(["excerpt", "create", "--note", "docs/Auth", "--text", "Tokens rotate.", "--x", "0", "--y", "0", "--dry-run"]);
    expect(path(2)).toBe("/v1/excerpts?dryRun=true");
    expect(body(2)).toMatchObject({ dryRun: true });
  });

  it("asks for the note's node when the open canvas has none", async () => {
    bridge({ id: NODE, kind: "note", title: "Billing", ref: "Billing.md", noteID: NOTE });
    const result = await run(["excerpt", "create", "--note", "Auth", "--text", "Tokens rotate.", "--x", "0", "--y", "0"]);
    expect(JSON.parse(result.stderr).error.code).toBe("node_not_found");
    expect(calls).toHaveLength(1);
  });

  it("names an app outdated when neither its node, --note-id, nor its index knows the note", async () => {
    bridge({ id: NODE, kind: "note", title: "Auth", ref: "docs/Auth.md" });
    writeIndex("other-vault", join(tempDir, "elsewhere"), NOTE);
    const result = await run(["excerpt", "create", "--note", "Auth", "--text", "Tokens rotate.", "--x", "0", "--y", "0"]);
    expect(JSON.parse(result.stderr).error.code).toBe("app_outdated");
  });

  it("uses --note-id when the node carries no note id", async () => {
    bridge({ id: NODE, kind: "note", title: "Auth", ref: "docs/Auth.md" });
    await run(["excerpt", "create", "--note", "Auth", "--note-id", OTHER_NOTE, "--text", "Tokens rotate.", "--x", "0", "--y", "0"]);
    expect(body(2)).toMatchObject({ selection: { noteID: OTHER_NOTE } });
  });

  it("prefers the note id the node reports over --note-id", async () => {
    bridge();
    await run(["excerpt", "create", "--note", "Auth", "--note-id", OTHER_NOTE, "--text", "Tokens rotate.", "--x", "0", "--y", "0"]);
    expect(body(2)).toMatchObject({ selection: { noteID: NOTE } });
  });

  it("reads the note id from the app's index of the open vault", async () => {
    bridge({ id: NODE, kind: "note", title: "Auth", ref: "docs/Auth.md" });
    writeIndex("this-vault", join(tempDir, "vault"), OTHER_NOTE);
    await run(["excerpt", "create", "--note", "Auth", "--text", "Tokens rotate.", "--x", "0", "--y", "0"]);
    expect(body(2)).toMatchObject({ selection: { noteID: OTHER_NOTE } });
  });

  it("reports a passage the note does not hold before posting", async () => {
    bridge();
    const result = await run(["excerpt", "create", "--note", "Auth", "--text", "Sessions", "--x", "0", "--y", "0"]);
    expect(JSON.parse(result.stderr).error.code).toBe("passage_not_found");
    expect(calls.map(call => new URL(call.url).pathname)).not.toContain("/v1/excerpts");
  });

  it("writes typed text at a dangling link's end", async () => {
    await run(["excerpt", "create", "--link", LINK, "--text", "Retry once", "--width", "200"]);
    expect(body(0)).toEqual({ link: LINK, text: "Retry once", width: 200, dryRun: false });
  });

  it("moves, formats, and edits the source passage", async () => {
    await run(["excerpt", "move", EXCERPT, "--x", "10", "--y", "20"]);
    await run(["excerpt", "update", EXCERPT, "--font-size", "14", "--align", "center"]);
    await run(["excerpt", "source", EXCERPT, "--text", "Tokens expire after a day."]);
    expect([calls[0].init.method, body(0)]).toEqual(["PUT", { x: 10, y: 20, dryRun: false }]);
    expect(body(1)).toEqual({ fontSize: 14, textAlignment: "center", dryRun: false });
    expect([path(2), calls[2].init.method, body(2)]).toEqual([
      `/v1/excerpts/${EXCERPT}/source?dryRun=false`, "PUT", { text: "Tokens expire after a day.", dryRun: false }
    ]);
  });

  it("rejects incomplete requests before contacting the app", async () => {
    for (const args of [
      ["excerpt", "create", "--text", "x", "--x", "0", "--y", "0"],
      ["excerpt", "create", "--note", "Auth", "--link", LINK, "--text", "x"],
      ["excerpt", "create", "--note", "Auth", "--text", "x"],
      ["excerpt", "create", "--link", LINK, "--note-id", NOTE, "--text", "x"],
      ["excerpt", "update", EXCERPT],
      ["excerpt", "update", EXCERPT, "--x", "1"],
      ["excerpt", "source", EXCERPT, "--text", " "]
    ]) {
      expect((await run(args)).code).toBe(1);
    }
    await expect(run(["excerpt", "update", EXCERPT, "--align", "middle"])).rejects.toThrow("alignment must be");
    expect(calls).toHaveLength(0);
  });

  it("names an app that predates Excerpts as outdated", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: false, error: { code: "not_found", message: "Bridge route not found" } });
    });
    const result = await run(["excerpt", "list"]);
    expect(JSON.parse(result.stderr).error.code).toBe("app_outdated");
  });
});
