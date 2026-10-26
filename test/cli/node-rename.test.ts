import { describe, expect, it, vi } from "vitest";
import { calls, run, setupCliTest } from "../support/cli-harness.js";

setupCliTest();

function body(index: number): unknown {
  return JSON.parse(String(calls[index].init.body));
}

describe("node rename", () => {
  it("posts the new title to the selector's rename route", async () => {
    const result = await run(["node", "rename", "Auth Service", "Identity Service"]);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname + url.search).toBe("/v1/nodes/Auth%20Service/rename?dryRun=false");
    expect(calls[0].init.method).toBe("POST");
    expect(body(0)).toEqual({ title: "Identity Service", dryRun: false });
  });

  it("passes dry-run in the query and the body", async () => {
    const result = await run(["node", "rename", "Auth", "Identity", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(new URL(calls[0].url).search).toBe("?dryRun=true");
    expect(body(0)).toEqual({ title: "Identity", dryRun: true });
  });

  it("passes the app's envelope through unchanged", async () => {
    const data = { from: "Auth", to: "Identity", changed: true, rewrittenWikilinks: 3, updatedCanvases: ["Flow"] };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data });
    });
    const result = await run(["node", "rename", "Auth", "Identity"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, data });
  });

  it.each([
    ["", "blank"],
    ["   ", "whitespace"],
    ["docs/Identity", "slash"],
    ["Identity: v2", "colon"],
    ["Identity?", "question mark"],
    ["Identity#2", "hash"],
    ["Identity.md", "md suffix"],
    ["Identity.MD", "uppercase md suffix"]
  ])("rejects %j (%s) before contacting the app", async (title) => {
    const result = await run(["node", "rename", "Auth", title]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("names an app that predates rename as outdated", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: false, error: { code: "not_found", message: "Bridge route not found", details: { path: "/v1/nodes/Auth/rename" } } });
    });
    const result = await run(["node", "rename", "Auth", "Identity"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "app_outdated",
      details: { path: "/v1/nodes/Auth/rename", hint: "Update the Enso app" }
    });
  });

  it("passes a missing Node's not_found through", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: false, error: { code: "not_found", message: "Node selector did not match any node" } });
    });
    const result = await run(["node", "rename", "Missing", "Identity"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("not_found");
  });
});
