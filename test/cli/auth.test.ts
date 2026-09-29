import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../../src/config.js";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

describe("auth", () => {
  it("stores credentials with private directory and file permissions", () => {
    expect(statSync(tempDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(tempDir, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("returns alreadyLinked when the stored credentials verify", async () => {
    const result = await run(["auth", "link"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { status: "linked", alreadyLinked: true, bridgeUrl: "http://127.0.0.1:17650" }
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/v1/status");
  });

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

  it("reports configured when credentials exist but the app is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const result = await run(["--pretty", "auth", "status"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { status: "configured", linked: false, bridgeUrl: "http://127.0.0.1:17650" }
    });
  });

  it("reports invalid when the app rejects stored credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: { code: "auth_required", message: "Token rejected" }
    }, { status: 401 })));
    const result = await run(["--pretty", "auth", "status"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { status: "invalid", linked: false }
    });
  });

  it("auth link fails with link_failed when the app provisions no token file", async () => {
    await run(["auth", "unlink"]);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: { status: "ok", contractVersion: 2, bridgeUrl: "http://127.0.0.1:17650" } });
    }));

    const result = await run(["auth", "link"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "link_failed", details: { hint: expect.any(String) } } });
    expect(readConfig()).toBeNull();
  });

  it("auth link relinks a stale token through the token file and says so", async () => {
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "fresh-token", bridgeUrl: "http://127.0.0.1:17650" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/health") {
        return Response.json({ ok: true, data: { status: "ok", contractVersion: 2, bridgeUrl: "http://127.0.0.1:17650", tokenPath } });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth === "Bearer fresh-token") return Response.json({ ok: true, data: { app: "Enso" } });
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    const result = await run(["auth", "link"]);
    const payload = JSON.parse(result.stdout);
    expect(payload.data).toMatchObject({ status: "linked", alreadyLinked: false, linked: true, bridgeUrl: "http://127.0.0.1:17650" });
    expect(readConfig()?.token).toBe("fresh-token");
  });

  it("auth status reports a stale token the app could not replace as invalid and keeps the config", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/health") {
        return Response.json({ ok: true, data: { status: "ok", contractVersion: 2, bridgeUrl: "http://127.0.0.1:17650" } });
      }
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    const result = await run(["--pretty", "auth", "status"]);
    const payload = JSON.parse(result.stdout);
    expect(payload.data).toMatchObject({ status: "invalid", linked: false, bridgeUrl: "http://127.0.0.1:17650" });
    expect(readConfig()?.token).toBe("test-token");
  });

  it("auth status passes access_disabled through instead of calling the app unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/health") {
        return Response.json({ ok: true, data: { status: "ok", contractVersion: 2, bridgeUrl: "http://127.0.0.1:17650", agentAccess: "disabled" } });
      }
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Authorization token is invalid" } });
    }));

    const result = await run(["--pretty", "auth", "status"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "access_disabled" } });
    expect(readConfig()?.token).toBe("test-token");
  });
});
