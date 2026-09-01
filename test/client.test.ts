import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/client.js";
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
});
