import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { defaultBridgeUrl, readConfig, removeConfig, writeConfig } from "../config.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";

type PairingResult = {
  token: string;
  bridgeUrl?: string;
};

function formatAuthStatus(data: { linked: boolean; bridgeUrl: string; linkedAt?: string }): string {
  if (!data.linked) return "Enso CLI is not linked to the Enso app.";

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
  const bridgeUrls = Array.from(new Set([defaultBridgeUrl, "http://127.0.0.1:17650", "http://127.0.0.1:17651"]));
  for (const bridgeUrl of bridgeUrls) {
    try {
      const endpoint = new URL("/v1/pair/request", bridgeUrl);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback, nonce })
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as EnsoEnvelope;
      if (payload.ok === true) return true;
    } catch {
      // Try the next local bridge candidate before falling back to the URL scheme.
    }
  }
  return false;
}

async function waitForPairing(): Promise<PairingResult> {
  const nonce = randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new EnsoCliError("pairing_failed", "Timed out waiting for Enso pairing approval"));
    }, 120_000);

    const server = createServer((request, response) => {
      if (request.method !== "POST" || !request.url?.startsWith("/callback")) {
        response.writeHead(404).end();
        return;
      }

      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const payload = JSON.parse(body) as PairingResult & { nonce?: string };
          if (payload.nonce !== nonce) {
            throw new EnsoCliError("pairing_failed", "Pairing nonce did not match");
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
          clearTimeout(timeout);
          server.close();
          reject(error);
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
    const result = await waitForPairing();
    const config = {
      bridgeUrl: result.bridgeUrl ?? defaultBridgeUrl,
      token: result.token,
      linkedAt: new Date().toISOString()
    };
    writeConfig(config);
    return {
      ok: true,
      text: [
        "Enso CLI linked successfully.",
        "",
        `Bridge: ${config.bridgeUrl}`,
        `Linked at: ${config.linkedAt}`
      ].join("\n"),
      data: {
        status: "linked",
        message: "Enso CLI is linked to the Enso app",
        linked: true,
        bridgeUrl: config.bridgeUrl,
        linkedAt: config.linkedAt
      }
    };
  });

  auth.command("status").action(async (): Promise<EnsoEnvelope> => {
    const config = readConfig();
    const linked = Boolean(config?.token);
    const data = {
      status: linked ? "linked" : "unlinked",
      linked,
      bridgeUrl: config?.bridgeUrl ?? defaultBridgeUrl,
      linkedAt: config?.linkedAt
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
