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

function note(title: string, body = "", uuid = `uuid-${title.toLowerCase().replace(/\s+/g, "-")}`): string {
  return ["---", `uuid: ${uuid}`, "---", "", body, ""].join("\n");
}

const GATEWAY = note("Gateway", "The Gateway hands each request to [[Router]].");
const ROUTER = note("Router", "The Router writes through [[Store]].");
const STORE = note("Store", "The Store owns durable state.");

const FLOW = [
  "---",
  "canvas: Request Flow",
  "direction: LR",
  "members:",
  "  - Gateway",
  "  - Router",
  "  - Store",
  "edges:",
  "  - from: Gateway",
  "    to: Router",
  "clusters:",
  "  - name: Edge",
  "    members:",
  "      - Gateway",
  "      - Router",
  "---",
  "",
  "How a request reaches the store.",
  ""
].join("\n");

const CLEAN = { "Gateway.md": GATEWAY, "Router.md": ROUTER, "Store.md": STORE, "flow.canvas.md": FLOW };

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
      data: { root, checked: { notes: 3, manifests: 1, outlines: 0 }, violations: [], warnings: [] }
    });
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
      const root = fixture({ ...CLEAN, "Broken.md": "---\nuuid: uuid-broken\nbroken\n---\n\nText.\n" });
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

    it("rejects a canvas manifest whose frontmatter is malformed", async () => {
      const root = fixture({ ...CLEAN, "broken.canvas.md": "canvas: Broken\nmembers:\n  - Gateway\n" });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr)).toEqual([
        expect.objectContaining({ code: "frontmatter_invalid", file: "broken.canvas.md" })
      ]);
    });

    it("accepts a Note with no frontmatter at all", async () => {
      const root = fixture({ "Loose.md": "Just prose, no fence.\n" });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
    });
  });

  describe("UUIDs", () => {
    it("rejects two Notes claiming the same UUID and names both files", async () => {
      const root = fixture({ ...CLEAN, "Copy.md": note("Copy", "A copied file.", "uuid-gateway") });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      const found = violations(result.stderr);
      expect(found.map((violation) => violation.file).sort()).toEqual(["Copy.md", "Gateway.md"]);
      for (const violation of found) {
        expect(violation).toMatchObject({
          code: "duplicate_uuid",
          details: { uuid: "uuid-gateway", files: ["Copy.md", "Gateway.md"] }
        });
      }
    });

    it("counts a generated outline in the UUID scan", async () => {
      const root = fixture({
        "Gateway.md": note("Gateway", "The Gateway."),
        "Gateway Outline.md": ["---", "uuid: uuid-gateway", "generated: true", "---", "", "- Gateway", ""].join("\n")
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr).map((violation) => violation.file).sort()).toEqual(["Gateway Outline.md", "Gateway.md"]);
    });

    it("warns without failing when a Note carries no UUID", async () => {
      const root = fixture({ "Gateway.md": "---\ntags:\n  - edge\n---\n\nThe Gateway.\n" });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: { violations: [], warnings: [expect.objectContaining({ code: "missing_uuid", file: "Gateway.md" })] }
      });
    });

    it("accepts distinct UUIDs across the folder", async () => {
      const root = fixture(CLEAN);
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

  describe("canvas manifests", () => {
    it("rejects a member that matches no Note", async () => {
      const root = fixture({ ...CLEAN, "flow.canvas.md": FLOW.replace("  - Store", "  - Ledger") });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr)).toEqual([
        expect.objectContaining({
          code: "missing_canvas_member",
          file: "flow.canvas.md",
          details: expect.objectContaining({ canvas: "Request Flow", member: "Ledger" })
        })
      ]);
    });

    it("rejects a cluster listing a title that is not a canvas member", async () => {
      const root = fixture({ ...CLEAN, "flow.canvas.md": FLOW.replace("      - Router", "      - Ledger") });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr)).toEqual([
        expect.objectContaining({ code: "cluster_member_outside_canvas", file: "flow.canvas.md" })
      ]);
    });

    it("separates a member held by two clusters from a member outside the canvas", async () => {
      const root = fixture({
        ...CLEAN,
        "flow.canvas.md": FLOW.replace("clusters:", ["clusters:", "  - name: Core", "    members:", "      - Gateway"].join("\n"))
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr)).toEqual([
        expect.objectContaining({
          code: "member_in_two_clusters",
          file: "flow.canvas.md",
          message: expect.stringContaining("Gateway")
        })
      ]);
    });

    it("reports every violation in one manifest", async () => {
      const root = fixture({
        ...CLEAN,
        "flow.canvas.md": [
          "---",
          "canvas: Request Flow",
          "members:",
          "  - Gateway",
          "  - Gateway",
          "  - Ledger",
          "---",
          "",
          "Two structural violations and a member that matches no Note.",
          ""
        ].join("\n")
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr).map((violation) => violation.code).sort()).toEqual([
        "duplicate_member",
        "missing_canvas_member"
      ]);
    });

    it("checks members even when the manifest has a broken cluster", async () => {
      const root = fixture({
        ...CLEAN,
        "flow.canvas.md": FLOW.replace("  - Store", "  - Ledger").replace("      - Router", "      - Ghost")
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr).map((violation) => violation.code).sort()).toEqual([
        "cluster_member_outside_canvas",
        "missing_canvas_member"
      ]);
    });

    it("resolves wikilinks in a manifest's prose body", async () => {
      const root = fixture({
        ...CLEAN,
        "flow.canvas.md": `${FLOW}\nThe entry point is [[Ghost Service]].\n`
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr)).toEqual([
        expect.objectContaining({
          code: "unresolved_wikilink",
          file: "flow.canvas.md",
          details: expect.objectContaining({ target: "Ghost Service" })
        })
      ]);
    });

    it("rejects a manifest that references a generated outline", async () => {
      const root = fixture({
        ...CLEAN,
        "Request Flow Outline.md": "---\ngenerated: true\n---\n\n- Gateway\n- Router\n",
        "flow.canvas.md": FLOW.replace("  - Store", "  - Request Flow Outline")
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(1);
      expect(violations(result.stderr)).toEqual([
        expect.objectContaining({
          code: "generated_outline_referenced",
          file: "flow.canvas.md",
          details: expect.objectContaining({ member: "Request Flow Outline", outline: "Request Flow Outline.md" })
        })
      ]);
    });

    it("accepts a generated outline that sits beside the manifest unreferenced", async () => {
      const root = fixture({ ...CLEAN, "Request Flow Outline.md": "---\ngenerated: true\n---\n\n- Gateway\n" });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { checked: { notes: 3, outlines: 1 } } });
    });

    it("resolves members by filename stem, the identity layout compiles against", async () => {
      const root = fixture({
        "Gateway.md": ["---", "uuid: uuid-gateway", "title: Ignored Key", "---", "", "The Gateway.", ""].join("\n"),
        "solo.canvas.md": ["---", "canvas: Solo", "members:", "  - Gateway", "---", ""].join("\n")
      });
      const result = await run(["check", root]);
      expect(result.code).toBe(0);
    });
  });

  describe("title collisions", () => {
    it("rejects two Notes sharing a title instead of picking a winner", async () => {
      const root = fixture({
        "Gateway.md": note("Gateway", "The edge Gateway.", "uuid-gateway-edge"),
        "services/Gateway.md": note("Gateway", "The service Gateway.", "uuid-gateway-service")
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

    it("leaves a manifest member alone when one of the colliding Notes is authored", async () => {
      const root = fixture({
        "Gateway.md": note("Gateway", "The Gateway."),
        "outlines/Gateway.md": "---\ngenerated: true\n---\n\n- Gateway\n",
        "solo.canvas.md": ["---", "canvas: Solo", "members:", "  - Gateway", "---", ""].join("\n")
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
      "Copy.md": note("Copy", "A copy.", "uuid-gateway"),
      "flow.canvas.md": ["---", "canvas: Request Flow", "members:", "  - Gateway", "  - Ledger", "---", ""].join("\n")
    });
    const result = await run(["check", root]);
    expect(result.code).toBe(1);
    const codes = violations(result.stderr).map((violation) => violation.code).sort();
    expect(codes).toEqual(["duplicate_uuid", "duplicate_uuid", "missing_canvas_member", "unresolved_wikilink"]);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "check_failed", message: "4 violations in " + root }
    });
  });
});
