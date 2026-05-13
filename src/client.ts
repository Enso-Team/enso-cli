import { z } from "zod";
import { defaultBridgeUrl, readConfig } from "./config.js";
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
  constructor(private readonly baseUrl = readConfig()?.bridgeUrl ?? defaultBridgeUrl) {}

  async request(pathname: string, options: RequestOptions = {}): Promise<EnsoEnvelope> {
    const method = options.method ?? "GET";
    const url = new URL(pathname, this.baseUrl);
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
    if (wantsAuth) {
      const config = readConfig();
      if (!config?.token) {
        throw new EnsoCliError("auth_required", "Run `enso auth link` before using the Enso bridge");
      }
      headers.Authorization = `Bearer ${config.token}`;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, { method, headers, body });
    } catch {
      throw new EnsoCliError("app_unavailable", "Enso app bridge is not available");
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
