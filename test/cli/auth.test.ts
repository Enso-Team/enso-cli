import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquirePairingLock, writeConfig } from "../../src/config.js";
import { calls, nativeFetch, run, setupCliTest, sleep, tempDir } from "../support/cli-harness.js";

setupCliTest();

async function readPairingUrl(urlFile: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return readFileSync(urlFile, "utf8");
    } catch {
      await sleep(10);
    }
  }
  throw new Error("pairing url was never written");
}

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

  it("links through the localhost callback flow", async () => {
    await run(["auth", "unlink"]);
    calls.length = 0;
    const urlFile = join(tempDir, "pairing-url.txt");
    process.env.ENSO_CLI_PAIRING_URL_FILE = urlFile;

    const pending = run(["auth", "link"]);
    let settled = false;
    const pendingResult = pending.finally(() => {
      settled = true;
    });
    let pairingUrl = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        pairingUrl = readFileSync(urlFile, "utf8");
        break;
      } catch {
        await sleep(10);
      }
    }

    const parsed = new URL(pairingUrl);
    const callback = parsed.searchParams.get("callback");
    const nonce = parsed.searchParams.get("nonce");
    expect(callback).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(new URL(request.url).pathname).toBe("/v1/pair/request");
    expect(JSON.parse(String(request.init.body))).toMatchObject({ callback, nonce });

    await sleep(20);
    expect(settled).toBe(false);

    await nativeFetch(callback!, {
      method: "POST",
      body: JSON.stringify({ token: "paired-token", bridgeUrl: "http://127.0.0.1:17651", nonce })
    });

    const result = await pendingResult;
    const output = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({ ok: true, data: { status: "pairing_pending" } });
    expect(output[1]).toMatchObject({
      ok: true,
      data: { status: "linked", alreadyLinked: false, bridgeUrl: "http://127.0.0.1:17651" }
    });
    expect(calls.some((call) =>
      new URL(call.url).origin === "http://127.0.0.1:17651"
      && new URL(call.url).pathname === "/v1/status"
      && (call.init.headers as Record<string, string>).Authorization === "Bearer paired-token"
    )).toBe(true);
    expect(JSON.parse(readFileSync(join(tempDir, "config.json"), "utf8"))).toMatchObject({
      token: "paired-token"
    });
  });

  it("relinks from an unavailable debug bridge without unlinking first", async () => {
    writeConfig({ bridgeUrl: "http://127.0.0.1:17651", token: "stale-debug-token" });
    const urlFile = join(tempDir, "pairing-url.txt");
    process.env.ENSO_CLI_PAIRING_URL_FILE = urlFile;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).origin === "http://127.0.0.1:17651") throw new Error("ECONNREFUSED");
      return Response.json({ ok: true, data: {} });
    }));

    const pending = run(["auth", "link"]);
    let pairingUrl = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        pairingUrl = readFileSync(urlFile, "utf8");
        break;
      } catch {
        await sleep(10);
      }
    }

    const parsed = new URL(pairingUrl);
    await nativeFetch(parsed.searchParams.get("callback")!, {
      method: "POST",
      body: JSON.stringify({
        token: "release-token",
        bridgeUrl: "http://127.0.0.1:17650",
        nonce: parsed.searchParams.get("nonce")
      })
    });

    const result = await pending;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"status":"linked"');
    expect(JSON.parse(readFileSync(join(tempDir, "config.json"), "utf8"))).toMatchObject({
      bridgeUrl: "http://127.0.0.1:17650",
      token: "release-token"
    });
  });

  it("rejects a concurrent pairing attempt with pairing_in_progress", async () => {
    await run(["auth", "unlink"]);
    calls.length = 0;
    const urlFile = join(tempDir, "pairing-url.txt");
    process.env.ENSO_CLI_PAIRING_URL_FILE = urlFile;

    const first = run(["auth", "link"]);
    let pairingUrl = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        pairingUrl = readFileSync(urlFile, "utf8");
        break;
      } catch {
        await sleep(10);
      }
    }

    const second = await run(["auth", "link"]);
    expect(second.code).toBe(1);
    expect(JSON.parse(second.stderr)).toMatchObject({
      ok: false,
      error: { code: "pairing_in_progress", details: { hint: expect.any(String) } }
    });
    expect(statSync(join(tempDir, "pairing")).mode & 0o777).toBe(0o600);
    expect(statSync(join(tempDir, "pairing.lock")).isDirectory()).toBe(true);

    const parsed = new URL(pairingUrl);
    await nativeFetch(parsed.searchParams.get("callback")!, {
      method: "POST",
      body: JSON.stringify({
        token: "paired-token",
        bridgeUrl: "http://127.0.0.1:17650",
        nonce: parsed.searchParams.get("nonce")
      })
    });
    await first;
  });

  it("recovers a lock whose holder stopped heartbeating", async () => {
    await run(["auth", "unlink"]);
    const lockDir = join(tempDir, "pairing.lock");
    writeFileSync(join(tempDir, "pairing"), "", "utf8");
    mkdirSync(lockDir);
    const abandoned = new Date(Date.now() - 5 * 60 * 1000);
    utimesSync(lockDir, abandoned, abandoned);
    const urlFile = join(tempDir, "pairing-url.txt");
    process.env.ENSO_CLI_PAIRING_URL_FILE = urlFile;

    const pending = run(["auth", "link"]);
    const parsed = new URL(await readPairingUrl(urlFile));
    expect(statSync(lockDir).mtimeMs).toBeGreaterThan(abandoned.getTime());

    await nativeFetch(parsed.searchParams.get("callback")!, {
      method: "POST",
      body: JSON.stringify({ token: "paired-token", nonce: parsed.searchParams.get("nonce") })
    });
    expect((await pending).code).toBe(0);
  });

  it("keeps rejecting while the lock is being heartbeated", async () => {
    await run(["auth", "unlink"]);
    writeFileSync(join(tempDir, "pairing"), "", "utf8");
    mkdirSync(join(tempDir, "pairing.lock"));

    const result = await run(["auth", "link"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "pairing_in_progress" }
    });
    expect(statSync(join(tempDir, "pairing.lock")).isDirectory()).toBe(true);
  });

  it("releases the lock once pairing succeeds", async () => {
    await run(["auth", "unlink"]);
    const urlFile = join(tempDir, "pairing-url.txt");
    process.env.ENSO_CLI_PAIRING_URL_FILE = urlFile;

    const pending = run(["auth", "link"]);
    const parsed = new URL(await readPairingUrl(urlFile));
    expect(existsSync(join(tempDir, "pairing.lock"))).toBe(true);

    await nativeFetch(parsed.searchParams.get("callback")!, {
      method: "POST",
      body: JSON.stringify({ token: "paired-token", nonce: parsed.searchParams.get("nonce") })
    });
    expect((await pending).code).toBe(0);
    expect(existsSync(join(tempDir, "pairing.lock"))).toBe(false);
  });

  it("heartbeats the held lock on an unref'd timer", async () => {
    process.env.ENSO_CLI_PAIRING_LOCK_STALE_MS = "2000";
    const lockDir = join(tempDir, "pairing.lock");
    const refTimersBefore = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    const release = acquirePairingLock(() => {});
    try {
      const firstMtime = statSync(lockDir).mtimeMs;
      // The heartbeat runs on an unref'd timer, so it refreshes the lock without holding the CLI open.
      expect(process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length).toBe(refTimersBefore);
      await sleep(1500);
      expect(statSync(lockDir).mtimeMs).toBeGreaterThan(firstMtime);
    } finally {
      release();
    }
    expect(existsSync(lockDir)).toBe(false);
  }, 15_000);

  it("rejects a second attempt against a live lock held past the stale window", async () => {
    await run(["auth", "unlink"]);
    process.env.ENSO_CLI_PAIRING_LOCK_STALE_MS = "2000";
    const release = acquirePairingLock(() => {});
    try {
      await sleep(2600);
      const result = await run(["auth", "link"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { code: "pairing_in_progress" }
      });
    } finally {
      release();
    }
  }, 15_000);

  it("aborts the pairing wait when the lock is compromised", async () => {
    await run(["auth", "unlink"]);
    const urlFile = join(tempDir, "pairing-url.txt");
    process.env.ENSO_CLI_PAIRING_URL_FILE = urlFile;
    process.env.ENSO_CLI_PAIRING_LOCK_STALE_MS = "2000";

    const pending = run(["auth", "link"]);
    await readPairingUrl(urlFile);
    // Another process reclaimed the lock directory, so the heartbeat finds an mtime that is not ours.
    rmSync(join(tempDir, "pairing.lock"), { recursive: true, force: true });

    const result = await pending;
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr.trim().split("\n").pop()!)).toMatchObject({
      ok: false,
      error: { code: "pairing_lock_lost", details: { hint: expect.any(String) } }
    });
    expect(existsSync(join(tempDir, "config.json"))).toBe(false);
  });

  it("continues waiting after a wrong-nonce callback", async () => {
    await run(["auth", "unlink"]);
    calls.length = 0;
    const urlFile = join(tempDir, "pairing-url.txt");
    process.env.ENSO_CLI_PAIRING_URL_FILE = urlFile;
    const pending = run(["auth", "link"]);

    let pairingUrl = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        pairingUrl = readFileSync(urlFile, "utf8");
        break;
      } catch {
        await sleep(10);
      }
    }
    const parsed = new URL(pairingUrl);
    const callback = parsed.searchParams.get("callback")!;
    const rejected = await nativeFetch(callback, {
      method: "POST",
      body: JSON.stringify({ token: "attacker-token", nonce: "wrong" })
    });
    expect(rejected.status).toBe(400);

    const approved = await nativeFetch(callback, {
      method: "POST",
      body: JSON.stringify({ token: "paired-token", nonce: parsed.searchParams.get("nonce") })
    });
    expect(approved.status).toBe(200);
    expect((await pending).code).toBe(0);
  });
});
