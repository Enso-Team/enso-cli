import { z } from "zod";
import { defaultBridgeUrl, readConfig } from "./config.js";
import { contractHeader, contractVersion } from "./contract.js";
import { discoverAndLink } from "./discovery.js";
import { EnsoCliError, type EnsoEnvelope } from "./errors.js";

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional()
});

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown().optional().default({}) }),
  z.object({ ok: z.literal(false), error: errorSchema })
]);

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  auth?: boolean;
  dryRun?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
};

export class BridgeClient {
  constructor(
    private readonly baseUrl = readConfig()?.bridgeUrl ?? defaultBridgeUrl,
    private readonly tokenOverride?: string
  ) {}

  async request(pathname: string, options: RequestOptions = {}): Promise<EnsoEnvelope> {
    const method = options.method ?? "GET";
    const url = new URL(pathname, this.baseUrl);
    assertLoopbackBridge(url);
    const query: Record<string, string | number | boolean> = {};

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) query[key] = value;
    }
    if (options.dryRun !== undefined) {
      query.dryRun = options.dryRun;
    }

    const queryString = Object.entries(query)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    if (queryString) {
      url.search = queryString;
    }

    const headers: Record<string, string> = { Accept: "application/json", [contractHeader]: String(contractVersion) };
    const wantsAuth = options.auth !== false;
    const currentConfig = this.tokenOverride ? null : readConfig();
    let requestUrl = currentConfig?.bridgeUrl
      ? new URL(url.pathname + url.search, currentConfig.bridgeUrl)
      : url;
    assertLoopbackBridge(requestUrl);
    if (wantsAuth) {
      let token = this.tokenOverride ?? currentConfig?.token;
      if (!token) {
        // The app names its token file on /v1/health, so a missing config links
        // itself here instead of sending the user to a separate auth step. The
        // discovered bridge can sit on the debug port, so the request follows it.
        const discovered = await discoverAndLink();
        if (discovered) {
          token = discovered.token;
          requestUrl = new URL(url.pathname + url.search, discovered.bridgeUrl);
          assertLoopbackBridge(requestUrl);
        }
      }
      if (!token) {
        throw new EnsoCliError("auth_required", "Launch the Enso app, then run this command again to link the CLI", {
          hint: "Update Enso so it provisions a token file, or run `enso auth link` to pair through its prompt"
        });
      }
      headers.Authorization = `Bearer ${token}`;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await this.send(requestUrl, method, headers, body);
    // A stored token the bridge no longer accepts is a stale pairing, left by an
    // app reinstall or a token rotation. The app names its token file on
    // /v1/health, so the CLI relinks and resends once instead of surfacing it.
    // Only the configured bridge is a candidate and it links only to itself:
    // moving to another instance is a deliberate `enso auth link`. The config
    // stays until a replacement is written, so a concurrent link is never erased.
    if (wantsAuth && !this.tokenOverride && currentConfig && !response.ok && response.error.code === "invalid_token") {
      const discovered = await discoverAndLink([currentConfig.bridgeUrl], { stay: true });
      if (!discovered) {
        throw new EnsoCliError("invalid_token", "The stored Enso pairing is stale", {
          bridgeUrl: currentConfig.bridgeUrl,
          hint: "The configured app provisions no token file. Update Enso, or run `enso auth link` to pair through its prompt"
        });
      }
      const relinkedUrl = new URL(url.pathname + url.search, discovered.bridgeUrl);
      assertLoopbackBridge(relinkedUrl);
      return this.send(relinkedUrl, method, { ...headers, Authorization: `Bearer ${discovered.token}` }, body);
    }
    return response;
  }

  private async send(requestUrl: URL, method: string, headers: Record<string, string>, body?: string): Promise<EnsoEnvelope> {
    let response: Response;
    try {
      response = await fetch(requestUrl, { method, headers, body });
    } catch {
      throw new EnsoCliError("app_unavailable", "The configured Enso app bridge is not available", {
        bridgeUrl: requestUrl.origin,
        hint: "Run `enso auth link` to relink, or launch the configured Enso app"
      });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new EnsoCliError("invalid_response", "Enso app bridge returned non-JSON output", {
        status: response.status
      });
    }

    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new EnsoCliError("invalid_response", "Enso app bridge returned an invalid envelope", {
        status: response.status
      });
    }

    return parsed.data as EnsoEnvelope;
  }
}

function assertLoopbackBridge(url: URL): void {
  if (isLoopbackBridgeUrl(url)) return;
  throw new EnsoCliError("invalid_bridge_url", "Enso bridge requests are restricted to loopback HTTP hosts", {
    path: "bridgeUrl",
    expected: "http://127.0.0.1, http://[::1], or http://localhost",
    hint: "Set ENSO_BRIDGE_URL to a loopback Enso app bridge"
  });
}

export function isLoopbackBridgeUrl(value: string | URL): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  const hosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  return url.protocol === "http:" && hosts.has(url.hostname.toLowerCase());
}
