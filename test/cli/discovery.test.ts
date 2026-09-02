import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../../src/config.js";
import { contractHeader, contractVersion } from "../../src/contract.js";
import { calls, run, setupCliTest, tempDir } from "../support/cli-harness.js";

setupCliTest();

function stubBridge(tokenPath: string, health: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const { pathname } = new URL(String(url));
      if (pathname === "/v1/health") {
        return Response.json({
          ok: true,
          data: { status: "ok", bridgeUrl: "http://127.0.0.1:17650", tokenPath, ...health }
        });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth !== "Bearer file-token") {
        return Response.json({
          ok: false,
          error: { code: "invalid_token", message: "Authorization token is invalid" }
        });
      }
      return Response.json({ ok: true, data: { app: "Enso", bridge: "running" } });
    })
  );
}

describe("file-based link", () => {
  it("auth link reads the token file the app names on /v1/health", async () => {
    rmSync(join(tempDir, "config.json"));
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token", bridgeUrl: "http://127.0.0.1:17650" }));
    stubBridge(tokenPath);

    const result = await run(["auth", "link"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { status: "linked", linked: true, alreadyLinked: false, bridgeUrl: "http://127.0.0.1:17650" }
    });
    expect(readConfig()?.token).toBe("file-token");
  });

  it("an authenticated command links itself when no config exists", async () => {
    rmSync(join(tempDir, "config.json"));
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    stubBridge(tokenPath);

    const result = await run(["status"]);

    expect(result.code).toBe(0);
    expect(readConfig()?.token).toBe("file-token");
    const paths = calls.map((call) => new URL(call.url).pathname);
    expect(paths).toContain("/v1/health");
  });

  it("reports auth_required when no bridge offers a token file", async () => {
    rmSync(join(tempDir, "config.json"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    const result = await run(["status"]);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("auth_required");
  });

  it("links to an app that names the CLI's contract on /v1/health", async () => {
    rmSync(join(tempDir, "config.json"));
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    stubBridge(tokenPath, { contractVersion });

    const result = await run(["status"]);

    expect(result.code).toBe(0);
    expect(readConfig()?.token).toBe("file-token");
  });

  it("refuses an app on a newer contract with cli_outdated and links nothing", async () => {
    rmSync(join(tempDir, "config.json"));
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    stubBridge(tokenPath, { contractVersion: contractVersion + 1 });

    const result = await run(["status"]);

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout || result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "cli_outdated",
        details: { appContractVersion: contractVersion + 1, cliContractVersion: contractVersion }
      }
    });
    expect(readConfig()).toBeNull();
  });

  it("every request carries the CLI's contract version header", async () => {
    const result = await run(["status"]);

    expect(result.code).toBe(0);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[contractHeader]).toBe(String(contractVersion));
  });

  it("a token file whose token the app rejects does not link", async () => {
    rmSync(join(tempDir, "config.json"));
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "revoked-token" }));
    stubBridge(tokenPath);

    const result = await run(["status"]);

    expect(result.code).not.toBe(0);
    expect(readConfig()).toBeNull();
  });
});
