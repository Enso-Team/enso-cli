import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { acquirePairingLock, defaultBridgeUrl, readConfig, removeConfig, writeConfig } from "../config.js";
import { BridgeClient, isLoopbackBridgeUrl } from "../client.js";
import { discoverAndLink } from "../discovery.js";
import { EnsoCliError, printEnvelope, type EnsoEnvelope } from "../errors.js";

type PairingResult = {
  token: string;
  bridgeUrl?: string;
};

function formatAuthStatus(data: { status: string; linked: boolean; bridgeUrl: string; linkedAt?: string }): string {
  if (data.status === "unlinked") return "Enso CLI is not linked to the Enso app.";
  if (data.status === "configured") return "Enso CLI credentials are configured, but the Enso app is unavailable.";
  if (data.status === "invalid") return "Enso CLI credentials are invalid.";

  const lines = [
    "Enso CLI is linked to the Enso app.",
    "",
    `Bridge: ${data.bridgeUrl}`
  ];
  if (data.linkedAt) lines.push(`Linked at: ${data.linkedAt}`);
  return lines.join("\n");
}

function openPairingUrl(url: string): Promise<void> {
  if (process.env.ENSO_CLI_OPEN === "0") return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile("open", [url], (error) => (error ? reject(error) : resolve()));
  });
}

async function requestPairingOverBridge(callback: string, nonce: string): Promise<boolean> {
  type Attempt = "prompted" | "present" | "absent";
  const attempt = async (bridgeUrl: string): Promise<Attempt> => {
    if (!isLoopbackBridgeUrl(bridgeUrl)) return "absent";
    try {
      const endpoint = new URL("/v1/pair/request", bridgeUrl);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback, nonce })
      });
      if (!response.ok) return "present";
      const payload = (await response.json()) as EnsoEnvelope;
      return payload.ok === true ? "prompted" : "present";
    } catch {
      return "absent";
    }
  };

  const explicit = process.env.ENSO_BRIDGE_URL;
  if (explicit && isLoopbackBridgeUrl(explicit)) {
    const result = await attempt(explicit);
    if (result === "prompted") return true;
  }
  const release = "http://127.0.0.1:17650";
  if (explicit !== release) {
    const result = await attempt(release);
    if (result === "prompted") return true;
    if (result === "present") return false;
  }
  const debug = "http://127.0.0.1:17651";
  if (explicit === debug) return false;
  return await attempt(debug) === "prompted";
}

async function waitForPairing(aborted: Promise<never>): Promise<PairingResult> {
  const nonce = randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new EnsoCliError("pairing_failed", "Timed out waiting for Enso pairing approval"));
    }, 120_000);

    aborted.catch((error: unknown) => {
      clearTimeout(timeout);
      server.close();
      reject(error);
    });

    const server = createServer((request, response) => {
      if (request.method !== "POST" || !request.url?.startsWith("/callback")) {
        response.writeHead(404).end();
        return;
      }

      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          response.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false }));
          request.destroy();
        }
      });
      request.on("end", () => {
        if (response.writableEnded) return;
        try {
          const payload = JSON.parse(body) as PairingResult & { nonce?: string; status?: string };
          if (payload.nonce !== nonce) {
            throw new EnsoCliError("pairing_failed", "Pairing nonce did not match");
          }
          if (payload.status === "rejected") {
            response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
            clearTimeout(timeout);
            server.close();
            reject(new EnsoCliError("pairing_failed", "Enso pairing was rejected"));
            return;
          }
          if (!payload.token) {
            throw new EnsoCliError("pairing_failed", "Pairing response did not include a token");
          }
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
          clearTimeout(timeout);
          server.close();
          resolve({ token: payload.token, bridgeUrl: payload.bridgeUrl });
        } catch (error) {
          response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false }));
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timeout);
        server.close();
        reject(new EnsoCliError("pairing_failed", "Could not start pairing callback server"));
        return;
      }
      const callback = `http://127.0.0.1:${address.port}/callback`;
      const url = `enso://agent-pair?callback=${encodeURIComponent(callback)}&nonce=${encodeURIComponent(nonce)}`;
      printEnvelope({ ok: true, data: { status: "pairing_pending" } });
      if (process.env.ENSO_CLI_PAIRING_URL_FILE) {
        writeFileSync(process.env.ENSO_CLI_PAIRING_URL_FILE, url, "utf8");
      }
      requestPairingOverBridge(callback, nonce)
        .then((prompted) => {
          if (prompted) return undefined;
          return openPairingUrl(url);
        })
        .catch((error) => {
          clearTimeout(timeout);
          server.close();
          reject(new EnsoCliError("pairing_failed", "Could not request Enso pairing", { cause: String(error) }));
        });
    });
  });
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Pair this CLI with the Enso app");

  auth.command("link").action(async (): Promise<EnsoEnvelope> => {
    const existing = readConfig();
    if (existing) {
      try {
        const status = await new BridgeClient(existing.bridgeUrl).request("/v1/status");
        if (status.ok) {
          return {
            ok: true,
            data: {
              status: "linked",
              alreadyLinked: true,
              linked: true,
              bridgeUrl: existing.bridgeUrl,
              linkedAt: existing.linkedAt
            }
          };
        }
      } catch {
        // An unavailable or invalid existing configuration does not block a fresh pairing attempt.
      }
    }
    // The app provisions a token file and names it on /v1/health. Reading it is
    // the whole link. The prompt-and-callback dance below is the fallback for
    // app versions that provision no file.
    const discovered = await discoverAndLink();
    if (discovered) {
      return {
        ok: true,
        data: {
          status: "linked",
          message: "Enso CLI is linked to the Enso app",
          alreadyLinked: false,
          linked: true,
          bridgeUrl: discovered.bridgeUrl,
          linkedAt: discovered.linkedAt
        }
      };
    }
    // The lock heartbeat can find the lock directory taken over by another process, which means this
    // attempt no longer owns pairing and has to abandon the callback server it is waiting on.
    let abort: (error: EnsoCliError) => void = () => {};
    const lockLost = { reason: null as EnsoCliError | null };
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = reject;
    });
    aborted.catch(() => {
      // The rejection is delivered through waitForPairing; this keeps it from surfacing unhandled.
    });
    let releaseLock: () => void;
    try {
      releaseLock = acquirePairingLock((error) => {
        lockLost.reason = new EnsoCliError("pairing_lock_lost", "The Enso pairing lock was taken over by another process", {
          hint: "Run enso auth link again",
          cause: error.message
        });
        abort(lockLost.reason);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "pairing_in_progress") {
        throw new EnsoCliError("pairing_in_progress", "Another Enso pairing attempt is already active", {
          hint: "Wait for the active attempt to finish or time out"
        });
      }
      throw error;
    }
    try {
      return await completePairing(aborted, lockLost);
    } finally {
      releaseLock();
    }
  });

  async function completePairing(
    aborted: Promise<never>,
    lockLost: { reason: EnsoCliError | null }
  ): Promise<EnsoEnvelope> {
    const result = await waitForPairing(aborted);
    const candidateBridgeUrl = result.bridgeUrl ?? defaultBridgeUrl;
    let verified: EnsoEnvelope;
    try {
      verified = await new BridgeClient(candidateBridgeUrl, result.token).request("/v1/status");
    } catch (error) {
      throw new EnsoCliError("pairing_failed", "The paired token could not be verified", {
        hint: "Keep the Enso app open and approve pairing again",
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    if (!verified.ok) {
      throw new EnsoCliError("pairing_failed", "The Enso app rejected the paired token", {
        bridgeError: verified.error,
        hint: "Approve pairing again to receive a fresh token"
      });
    }
    // A lock lost while the approval was in flight means another pairing owns the credentials now,
    // so this attempt reports the loss rather than overwriting them.
    if (lockLost.reason) throw lockLost.reason;
    const config = {
      bridgeUrl: candidateBridgeUrl,
      token: result.token,
      linkedAt: new Date().toISOString()
    };
    writeConfig(config);
    return {
      ok: true,
      data: {
        status: "linked",
        message: "Enso CLI is linked to the Enso app",
        alreadyLinked: false,
        linked: true,
        bridgeUrl: config.bridgeUrl,
        linkedAt: config.linkedAt
      }
    };
  }

  auth.command("status").action(async (): Promise<EnsoEnvelope> => {
    const config = readConfig();
    if (!config) {
      const data = { status: "unlinked", linked: false, bridgeUrl: defaultBridgeUrl };
      return { ok: true, text: formatAuthStatus(data), data };
    }
    let status: "linked" | "configured" | "invalid";
    try {
      const response = await new BridgeClient(config.bridgeUrl).request("/v1/status");
      status = response.ok ? "linked" : "invalid";
    } catch {
      status = "configured";
    }
    const data = {
      status,
      linked: status === "linked",
      bridgeUrl: config.bridgeUrl,
      linkedAt: config.linkedAt
    };
    return {
      ok: true,
      text: formatAuthStatus(data),
      data
    };
  });

  auth.command("unlink").action(async (): Promise<EnsoEnvelope> => {
    removeConfig();
    return {
      ok: true,
      text: "Enso CLI is no longer linked to the Enso app.",
      data: {
        status: "unlinked",
        message: "Enso CLI is no longer linked to the Enso app",
        linked: false
      }
    };
  });
}
