import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeInstanceHeader } from "../../src/bridge-binding.js";
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
          data: { status: "ok", contractVersion: 3, bridgeUrl: "http://127.0.0.1:17650", tokenPath, ...health }
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

  it("discovery speaks the CLI's one contract version", async () => {
    const result = await run(["status"]);

    expect(result.code).toBe(0);
    for (const call of calls.filter(call => new URL(call.url).pathname !== "/v1/health")) {
      expect((call.init.headers as Record<string, string>)[contractHeader]).toBe(String(contractVersion));
    }
  });

  it.each([1, 2])("refuses to link an app on contract %s with an actionable app_outdated error", async appVersion => {
    rmSync(join(tempDir, "config.json"));
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    stubBridge(tokenPath, { contractVersion: appVersion });

    const result = await run(["auth", "link"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "app_outdated", details: { appContractVersion: appVersion, cliContractVersion: 3, hint: expect.stringContaining("Update the Enso app") } }
    });
    expect(readConfig()).toBeNull();
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

describe("discovery with an expected bridge instance", () => {
  const instance = "expected-instance";
  const origin = "http://127.0.0.1:17650";
  const paths = () => calls.map(call => new URL(call.url).pathname);
  const headers = () => calls.map(call => call.init.headers as Record<string, string>);
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { args: ["status"], advertised: "another-instance", code: "bridge_instance_mismatch" },
    { args: ["auth", "link"], advertised: "another-instance", code: "bridge_instance_mismatch" },
    { args: ["status"], advertised: undefined, code: "bridge_instance_unavailable" },
    { args: ["auth", "link"], advertised: undefined, code: "bridge_instance_unavailable" }
  ])("refuses $args with $code before pairing", async ({ args, advertised, code }) => {
    rmSync(join(tempDir, "config.json"));
    vi.stubEnv("ENSO_BRIDGE_INSTANCE_ID", instance);
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    stubBridge(tokenPath, { bridgeInstanceID: advertised });

    const result = await run(args);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe(code);
    expect(paths()).toEqual(["/v1/health"]);
    expect(headers()).toEqual([{ Accept: "application/json", [bridgeInstanceHeader]: instance }]);
    expect(readConfig()).toBeNull();
  });

  it.each([["status"], ["auth", "link"]])("pairs $0 only after verifying its instance", async (...args) => {
    rmSync(join(tempDir, "config.json"));
    vi.stubEnv("ENSO_BRIDGE_INSTANCE_ID", instance);
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    stubBridge(tokenPath, { bridgeInstanceID: instance });

    const result = await run(args);

    expect(result.code).toBe(0);
    expect(paths().slice(0, 2)).toEqual(["/v1/health", "/v1/status"]);
    expect(headers().every(header => header[bridgeInstanceHeader] === instance)).toBe(true);
    expect(headers()[0].Authorization).toBeUndefined();
    expect(headers()[1].Authorization).toBe("Bearer file-token");
    expect(readConfig()?.token).toBe("file-token");
  });

  it("checks an alternate token-file origin before sending credentials there", async () => {
    rmSync(join(tempDir, "config.json"));
    vi.stubEnv("ENSO_BRIDGE_INSTANCE_ID", instance);
    const destination = "http://127.0.0.1:17651";
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token", bridgeUrl: destination }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: { contractVersion: 3, tokenPath,
        bridgeInstanceID: new URL(String(url)).origin === origin ? instance : "another-instance" } });
    }));

    const result = await run(["auth", "link"]);

    expect(JSON.parse(result.stderr).error.code).toBe("bridge_instance_mismatch");
    expect(calls.map(call => call.url)).toEqual([`${origin}/v1/health`, `${destination}/v1/health`]);
    expect(headers().every(header => header.Authorization === undefined && header[bridgeInstanceHeader] === instance)).toBe(true);
    expect(readConfig()).toBeNull();
  });

  it("relinks a stale token on the same verified instance with the pin on every request", async () => {
    vi.stubEnv("ENSO_BRIDGE_INSTANCE_ID", instance);
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    stubBridge(tokenPath, { bridgeInstanceID: instance });

    const result = await run(["status"]);

    expect(result.code).toBe(0);
    expect(paths()).toEqual(["/v1/health", "/v1/status", "/v1/health", "/v1/status", "/v1/status"]);
    expect(headers().every(header => header[bridgeInstanceHeader] === instance)).toBe(true);
    expect(readConfig()?.token).toBe("file-token");
  });

  it("refuses a changed instance during stale-token recovery without replacing stored pairing", async () => {
    vi.stubEnv("ENSO_BRIDGE_INSTANCE_ID", instance);
    const previous = readConfig();
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    let healthReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/v1/health") {
        return Response.json({ ok: true, data: { contractVersion: 3, tokenPath,
          bridgeInstanceID: ++healthReads === 1 ? instance : "another-instance" } });
      }
      return Response.json({ ok: false, error: { code: "invalid_token", message: "Pairing changed" } });
    }));

    const result = await run(["status"]);

    expect(JSON.parse(result.stderr).error.code).toBe("bridge_instance_mismatch");
    expect(paths()).toEqual(["/v1/health", "/v1/status", "/v1/health"]);
    expect(headers().filter(header => header.Authorization).map(header => header.Authorization)).toEqual(["Bearer test-token"]);
    expect(readConfig()).toEqual(previous);
  });

  it("surfaces an instance refusal between discovery health and token verification without pairing", async () => {
    rmSync(join(tempDir, "config.json"));
    vi.stubEnv("ENSO_BRIDGE_INSTANCE_ID", instance);
    const tokenPath = join(tempDir, "bridge-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "file-token" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json(new URL(String(url)).pathname === "/v1/health"
        ? { ok: true, data: { contractVersion: 3, tokenPath, bridgeInstanceID: instance } }
        : { ok: false, error: { code: "bridge_instance_mismatch", message: "App restarted", details: { instanceID: "another-instance" } } });
    }));

    const result = await run(["auth", "link"]);

    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "bridge_instance_mismatch", message: "App restarted", details: { instanceID: "another-instance" } });
    expect(paths()).toEqual(["/v1/health", "/v1/status"]);
    expect(headers().every(header => header[bridgeInstanceHeader] === instance)).toBe(true);
    expect(readConfig()).toBeNull();
  });

  it("auth link does not retry an instance mismatch from the existing pairing", async () => {
    vi.stubEnv("ENSO_BRIDGE_INSTANCE_ID", instance);
    const previous = readConfig();
    stubBridge(join(tempDir, "unused-token.json"), { bridgeInstanceID: "another-instance" });

    const result = await run(["auth", "link"]);

    expect(JSON.parse(result.stderr).error.code).toBe("bridge_instance_mismatch");
    expect(paths()).toEqual(["/v1/health"]);
    expect(readConfig()).toEqual(previous);
  });

  it.each(["bridge_instance_mismatch", "bridge_instance_unavailable"])("auth link stops on an app-side %s after health succeeds", async code => {
    vi.stubEnv("ENSO_BRIDGE_INSTANCE_ID", instance);
    const previous = readConfig();
    const error = { code, message: "The app instance changed", details: { instanceID: "replacement-instance", hint: "Stop here" } };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json(new URL(String(url)).pathname === "/v1/health"
        ? { ok: true, data: { contractVersion: 3, bridgeInstanceID: instance } }
        : { ok: false, error });
    }));

    const result = await run(["auth", "link"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error });
    expect(paths()).toEqual(["/v1/health", "/v1/status"]);
    expect(readConfig()).toEqual(previous);
  });
});
