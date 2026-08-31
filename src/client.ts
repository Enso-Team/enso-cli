import { z } from "zod";
import { defaultBridgeUrl, readConfig } from "./config.js";
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

    const headers: Record<string, string> = { Accept: "application/json" };
    const wantsAuth = options.auth !== false;
    let requestUrl = url;
    if (wantsAuth) {
      let token = this.tokenOverride ?? readConfig()?.token;
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
        throw new EnsoCliError("auth_required", "Launch the Enso app, then run this command again to link the CLI");
      }
      headers.Authorization = `Bearer ${token}`;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(requestUrl, { method, headers, body });
    } catch {
      throw new EnsoCliError("app_unavailable", "The configured Enso app bridge is not available", {
        bridgeUrl: this.baseUrl,
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
