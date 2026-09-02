import { describe, expect, it } from "vitest";
import { calls, run, setupCliTest } from "../support/cli-harness.js";

setupCliTest();

function traceLines(stderr: string): Array<Record<string, unknown>> {
  return stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("ENSO_CLI_TRACE", () => {
  it("prints each bridge request to stderr and leaves the stdout envelope untouched", async () => {
    process.env.ENSO_CLI_TRACE = "1";
    const result = await run(["link", "create", "A", "B", "--label", "uses"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
    expect(traceLines(result.stderr)).toEqual([
      { trace: "bridge", method: "POST", path: "/v1/links?dryRun=false", body: { source: "A", target: "B", label: "uses", dryRun: false } }
    ]);
  });

  it("omits the body on a GET and never carries the token", async () => {
    process.env.ENSO_CLI_TRACE = "1";
    const result = await run(["canvas", "list"]);
    const [line] = traceLines(result.stderr);
    expect(line).toEqual({ trace: "bridge", method: "GET", path: "/v1/canvases" });
    expect(result.stderr).not.toContain("test-token");
    expect(String(calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization)).toContain("test-token");
  });

  it("traces every request of a multi-step command in order", async () => {
    process.env.ENSO_CLI_TRACE = "1";
    const result = await run(["canvas", "apply", "--json", JSON.stringify({ canvas: "current", nodes: [{ kind: "note", mode: "create", title: "A", x: 0, y: 0 }], links: [], primitives: [] }), "--dry-run"]);
    const lines = traceLines(result.stderr);
    expect(lines.map((line) => `${line.method} ${String(line.path).split("?")[0]}`)).toEqual(["POST /v1/context", "GET /v1/search", "POST /v1/apply"]);
    expect(lines[2].body).toMatchObject({ dryRun: true, operations: [expect.objectContaining({ type: "node.create", title: "A" })] });
  });

  it.each(["", "0", "false"])("stays silent when ENSO_CLI_TRACE is %j", async (value) => {
    process.env.ENSO_CLI_TRACE = value;
    const result = await run(["canvas", "list"]);
    expect(result.stderr).toBe("");
  });
});
