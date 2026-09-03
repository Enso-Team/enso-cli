import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/client.js";
import { readConfig, writeConfig } from "../src/config.js";
import { calls, setupCliTest, tempDir } from "./support/cli-harness.js";

setupCliTest();

describe("BridgeClient", () => {
  it("reuses the linked bridge URL for later requests on the same client instance", async () => {
    rmSync(join(tempDir, "config.json"), { force: true });
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token", bridgeUrl: "http://127.0.0.1:17650" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/health") {
        return Response.json({
          ok: true,
          data: { status: "ok", bridgeUrl: "http://127.0.0.1:17650", tokenPath }
        });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (parsed.origin === "http://127.0.0.1:17650" && typeof auth === "string" && auth.length > 0) {
        return Response.json({ ok: true, data: {} });
      }
      throw new Error("ECONNREFUSED");
    }));

    const client = new BridgeClient("http://127.0.0.1:17651");
    expect((await client.request("/v1/status")).ok).toBe(true);
    expect((await client.request("/v1/context")).ok).toBe(true);

    const contextCalls = calls.filter((call) => new URL(call.url).pathname === "/v1/context");
    expect(contextCalls).toHaveLength(1);
    expect(new URL(contextCalls[0].url).origin).toBe("http://127.0.0.1:17650");
  });

  it("relinks through the token file when the stored token is stale", async () => {
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "fresh-token", bridgeUrl: "http://127.0.0.1:17650" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/health") {
        return Response.json({ ok: true, data: { status: "ok", bridgeUrl: "http://127.0.0.1:17650", tokenPath } });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth === "Bearer fresh-token") return Response.json({ ok: true, data: { app: "Enso" } });
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    const result = await new BridgeClient().request("/v1/context");
    expect(result.ok).toBe(true);
    expect(readConfig()?.token).toBe("fresh-token");
    const contextCalls = calls.filter((call) => new URL(call.url).pathname === "/v1/context");
    expect(contextCalls.map((call) => (call.init.headers as Record<string, string>).Authorization)).toEqual([
      "Bearer test-token",
      "Bearer fresh-token"
    ]);
  });

  it("keeps the stale config and reports invalid_token when the configured app provisions no file", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/health") {
        return Response.json({ ok: true, data: { status: "ok", bridgeUrl: "http://127.0.0.1:17650" } });
      }
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    await expect(new BridgeClient().request("/v1/context")).rejects.toMatchObject({
      body: { code: "invalid_token", details: { bridgeUrl: "http://127.0.0.1:17650" } }
    });
    expect(readConfig()?.token).toBe("test-token");
  });

  it("never relinks to a different app instance on its own", async () => {
    writeConfig({ bridgeUrl: "http://127.0.0.1:17651", token: "debug-stale" });
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "release-token", bridgeUrl: "http://127.0.0.1:17650" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.origin === "http://127.0.0.1:17650") {
        if (parsed.pathname === "/v1/health") {
          return Response.json({ ok: true, data: { status: "ok", bridgeUrl: "http://127.0.0.1:17650", tokenPath } });
        }
        return Response.json({ ok: true, data: {} });
      }
      if (parsed.pathname === "/v1/health") {
        return Response.json({ ok: true, data: { status: "ok", bridgeUrl: "http://127.0.0.1:17651" } });
      }
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    await expect(new BridgeClient().request("/v1/canvases", { method: "POST", body: { title: "x" } })).rejects.toMatchObject({
      body: { code: "invalid_token" }
    });
    expect(calls.every((call) => new URL(call.url).origin === "http://127.0.0.1:17651")).toBe(true);
    expect(readConfig()?.bridgeUrl).toBe("http://127.0.0.1:17651");
  });

  it("does not follow a token file that names a different origin while healing", async () => {
    writeConfig({ bridgeUrl: "http://127.0.0.1:17651", token: "debug-stale" });
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "other-token", bridgeUrl: "http://127.0.0.1:17650" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/health") {
        return Response.json({ ok: true, data: { status: "ok", bridgeUrl: "http://127.0.0.1:17651", tokenPath } });
      }
      if (parsed.origin === "http://127.0.0.1:17650") return Response.json({ ok: true, data: {} });
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    await expect(new BridgeClient().request("/v1/canvases", { method: "POST", body: { title: "x" } })).rejects.toMatchObject({
      body: { code: "invalid_token" }
    });
    expect(calls.every((call) => new URL(call.url).origin === "http://127.0.0.1:17651")).toBe(true);
    expect(readConfig()).toMatchObject({ bridgeUrl: "http://127.0.0.1:17651", token: "debug-stale" });
  });

  it("resends a mutation with its method and body after relinking", async () => {
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "fresh-token", bridgeUrl: "http://127.0.0.1:17650" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/health") {
        return Response.json({ ok: true, data: { status: "ok", bridgeUrl: "http://127.0.0.1:17650", tokenPath } });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth === "Bearer fresh-token") return Response.json({ ok: true, data: {} });
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    await new BridgeClient().request("/v1/canvases", { method: "POST", body: { title: "Plan" } });
    const posts = calls.filter((call) => new URL(call.url).pathname === "/v1/canvases");
    expect(posts).toHaveLength(2);
    expect(posts.map((call) => [call.init.method, call.init.body])).toEqual([
      ["POST", JSON.stringify({ title: "Plan" })],
      ["POST", JSON.stringify({ title: "Plan" })]
    ]);
  });

  it("does not relink when the token was supplied by the caller", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    const result = await new BridgeClient(undefined, "caller-token").request("/v1/context");
    expect(result.ok).toBe(false);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/context"]);
    expect(readConfig()?.token).toBe("test-token");
  });

  it("names the bridge that refused the connection", async () => {
    writeConfig({ bridgeUrl: "http://127.0.0.1:17651", token: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));

    await expect(new BridgeClient("http://127.0.0.1:17650").request("/v1/context")).rejects.toMatchObject({
      body: { code: "app_unavailable", details: { bridgeUrl: "http://127.0.0.1:17651" } }
    });
  });
});
