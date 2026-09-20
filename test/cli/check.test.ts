import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

type Finding = { code: string; file: string; message: string; details?: Record<string, unknown> };

let folderCount = 0;

function fixture(files: Record<string, string>): string {
  folderCount += 1;
  const root = join(tempDir, `enso-${folderCount}`);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function note(title: string, body = ""): string {
  return ["---", `topic: ${title.toLowerCase().replace(/\s+/g, "-")}`, "---", "", body, ""].join("\n");
}

const GATEWAY = note("Gateway", "The Gateway hands each request to [[Router]].");
const ROUTER = note("Router", "The Router writes through [[Store]].");
const STORE = note("Store", "The Store owns durable state.");

const CLEAN = { "Gateway.md": GATEWAY, "Router.md": ROUTER, "Store.md": STORE };

function violations(stderr: string): Finding[] {
  return JSON.parse(stderr).error.details.violations as Finding[];
}

function snapshotTree(root: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else sizes[`${prefix}${entry.name}`] = statSync(path).size;
    }
  };
  walk(root, "");
  return sizes;
}

describe("check", () => {
  it("accepts a clean folder without touching the bridge", async () => {
    const root = fixture(CLEAN);
    const before = snapshotTree(root);
    const result = await run(["check", root]);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(snapshotTree(root)).toEqual(before);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { root, checked: { notes: 3, outlines: 0 }, violations: [], warnings: [] }
    });
  });

  it("refuses a file path and says to run on the folder", async () => {
    const root = fixture(CLEAN);
    const result = await run(["check", join(root, "Gateway.md")]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.message).toContain("takes the Vault folder");
  });

  it("does not read a wikilink shown in a code span as a wikilink", async () => {
    const root = fixture({
      ...CLEAN,
      "Guide.md": note("Guide", "Write `[[Nowhere]]` to link. Fences too:\n```\n[[Nowhere]]\n```\nReal: [[Store]].")
    });
    const result = await run(["check", root]);
    expect(result.code).toBe(0);
  });

  it("reports a folder that cannot be read as a structured envelope", async () => {
    const result = await run(["check", join(tempDir, "absent")]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { path: "folder" } }
    });
  });

  describe("frontmatter parses", () => {
    it("rejects a Note whose frontmatter is malformed and names the line", async () => {
      const root = fixture({ ...CLEAN, "Broken.md": "---\ntopic: broken\nbroken\n---\n\nText.\n" });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr)).toEqual([
        expect.objectContaining({
          code: "frontmatter_invalid",
          file: "Broken.md",
          details: expect.objectContaining({ line: 3 })
        })
      ]);
    });

    it("ignores a leftover canvas.md manifest", async () => {
      const root = fixture({ ...CLEAN, "broken.canvas.md": "canvas: Broken\nmembers:\n  - Gateway\n" });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
    });

    it("accepts a Note with no frontmatter at all", async () => {
      const root = fixture({ "Loose.md": "Just prose, no fence.\n" });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
    });
  });

  describe("wikilinks resolve", () => {
    it("rejects a wikilink with no matching Note", async () => {
      const root = fixture({ ...CLEAN, "Gateway.md": note("Gateway", "The Gateway calls [[Ghost Service]].") });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr)).toEqual([
        expect.objectContaining({
          code: "unresolved_wikilink",
          file: "Gateway.md",
          details: expect.objectContaining({ target: "Ghost Service", line: 5 })
        })
      ]);
    });

    it("accepts wikilinks that resolve through nested folders, aliases, and headings", async () => {
      const root = fixture({
        "Gateway.md": note("Gateway", "The Gateway hands off to [[Router|the router]] and reads [[Store#state]]."),
        "services/Router.md": ROUTER,
        "services/Store.md": STORE
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
    });

    it("leaves wikilinks inside fenced code blocks alone", async () => {
      const root = fixture({ "Gateway.md": note("Gateway", "```\n[[Ghost Service]]\n```") });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
    });
  });

  describe("outlines", () => {
    it("accepts a generated outline beside Notes", async () => {
      const root = fixture({
        ...CLEAN,
        "Canvases/Request Flow.md": "<!-- Canvas outline generated by Enso from Canvas 00000000-0000-4000-8000-000000000001. Edits are overwritten. -->\n\n- Gateway\n"
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { checked: { notes: 3, outlines: 1 } } });
    });
  });

  describe("title collisions", () => {
    it("rejects two Notes sharing a title instead of picking a winner", async () => {
      const root = fixture({
        "Gateway.md": note("Gateway", "The edge Gateway."),
        "services/Gateway.md": note("Gateway", "The service Gateway.")
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      const found = violations(result.stderr);
      expect(found.map((violation) => violation.file).sort()).toEqual(["Gateway.md", "services/Gateway.md"]);
      for (const violation of found) {
        expect(violation).toMatchObject({
          code: "duplicate_title",
          details: { title: "Gateway", files: ["Gateway.md", "services/Gateway.md"] }
        });
      }
    });

    it("treats a generated outline with the same stem as a title collision", async () => {
      const root = fixture({
        "Gateway.md": note("Gateway", "The Gateway."),
        "Canvases/Gateway.md": "<!-- Canvas outline generated by Enso from Canvas 00000000-0000-4000-8000-000000000001. Edits are overwritten. -->\n\n- Gateway\n"
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr).map((violation) => violation.code).sort()).toEqual([
        "duplicate_title",
        "duplicate_title"
      ]);
    });

    it("accepts one Note per title across nested folders", async () => {
      const root = fixture(CLEAN);
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
    });
  });

  it("collects every violation in one run", async () => {
    const root = fixture({
      "Gateway.md": note("Gateway", "The Gateway calls [[Ghost Service]]."),
      "services/Gateway.md": note("Gateway", "A second Gateway.")
    });
    const result = await run(["check", root]);
    expect(result.code).toBe(1);
    const codes = violations(result.stderr).map((violation) => violation.code).sort();
    expect(codes).toEqual(["duplicate_title", "duplicate_title", "unresolved_wikilink"]);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "check_failed", message: "3 violations in " + root }
    });
  });
});
