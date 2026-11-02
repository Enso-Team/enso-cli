import { z } from "zod";
import { defaultBridgeUrl, readConfig } from "./config.js";
import { assertTargetingContract, contractHeader, contractVersion, oldestSupportedContractVersion } from "./contract.js";
import { discoverAndLink } from "./discovery.js";
import { EnsoCliError, type EnsoEnvelope } from "./errors.js";

import { currentRequestContext, RequestContext, parseTarget, routeScope, sameTarget, type CanvasTarget } from "./targeting.js";

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
  private readonly context: RequestContext;
  private readonly joiningConnection: boolean;
  constructor(
    private readonly baseUrl?: string,
    private readonly tokenOverride?: string
  ) {
    this.context = currentRequestContext() ?? new RequestContext();
    this.joiningConnection = this.context.connection !== undefined;
  }

  async resolveTarget(selector?: string): Promise<CanvasTarget> {
    await this.negotiate();
    return this.context.resolve(path => this.bootstrap(path), selector);
  }

  async request(pathname: string, options: RequestOptions = {}): Promise<EnsoEnvelope> {
    const method = options.method ?? "GET";
    const health = new URL(pathname, this.baseUrl ?? defaultBridgeUrl).pathname === "/v1/health";
    const connection = await this.connect(!health);
    const url = new URL(pathname, connection.bridgeUrl);
    assertLoopbackBridge(url);
    if (url.origin !== new URL(connection.bridgeUrl).origin) {
      throw new EnsoCliError("target_conflict", "A request cannot override the invocation's bridge instance");
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (options.dryRun !== undefined) url.searchParams.set("dryRun", String(options.dryRun));
    let body = options.body;
    if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body))) {
      throw new EnsoCliError("invalid_input", "Bridge request bodies must be JSON objects");
    }
    const object = { ...body as Record<string, unknown> | undefined };
    const scope = routeScope(url.pathname, method);
    if (this.context.bound && (scope === "pairing" || scope === "navigation" || scope === "vault" && method !== "GET" || /\/subcanvas\/open$/.test(url.pathname))) {
      this.context.rejectNavigation();
    }
    const rawQueryTarget = url.searchParams.get("canvasTarget");
    let queryTarget: CanvasTarget | undefined;
    if (rawQueryTarget !== null) {
      try { queryTarget = parseTarget(JSON.parse(rawQueryTarget)); }
      catch { throw new EnsoCliError("invalid_target", "The canvasTarget query parameter must be a JSON object with vaultID and canvasID UUIDs"); }
    }
    const bodyTarget = object.canvasTarget === undefined ? undefined : parseTarget(object.canvasTarget);
    if (queryTarget && bodyTarget && !sameTarget(queryTarget, bodyTarget)) {
      throw new EnsoCliError("target_conflict", "The body and query targets must match");
    }
    if (scope !== "canvas" && (queryTarget || bodyTarget)) {
      throw new EnsoCliError("target_not_allowed", "Omit canvasTarget on discovery, vault and navigation routes");
    }
    if (scope === "canvas") {
      await this.negotiate();
      const pathSelector = /^\/v1\/canvases\/([^/]+)\/(inspect|fit)$/.exec(url.pathname);
      const selectors = [pathSelector && decodeURIComponent(pathSelector[1]), url.searchParams.get("canvas"), object.canvas];
      for (const selector of selectors) {
        if (selector !== undefined && selector !== null && selector !== false && typeof selector !== "string") {
          throw new EnsoCliError("invalid_input", "Canvas selectors must be strings");
        }
      }
      const target = await this.context.resolve(path => this.bootstrap(path), selectors.find(value => typeof value === "string") as string | undefined, bodyTarget ?? queryTarget);
      for (const selector of selectors) {
        if (typeof selector === "string") await this.context.resolve(path => this.bootstrap(path), selector);
      }
      if (pathSelector) url.pathname = `/v1/canvases/${target.canvasID}/${pathSelector[2]}`;
      if (url.searchParams.has("canvas")) url.searchParams.set("canvas", target.canvasID);
      if (object.canvas !== undefined) object.canvas = target.canvasID;
      if (Array.isArray(object.operations)) {
        for (const operation of object.operations) {
          if (!operation || typeof operation !== "object") throw new EnsoCliError("invalid_input", "Batch operations must be objects");
          const op = operation as Record<string, unknown>;
          if (["canvas.open", "canvas.create", "portal.open"].includes(String(op.type))) {
            throw new EnsoCliError("explicit_navigation_required", "Perform navigation separately from a targeted batch");
          }
          if (op.canvasTarget !== undefined && !sameTarget(parseTarget(op.canvasTarget), target)) {
            throw new EnsoCliError("target_conflict", "Every batch operation must share the invocation's canvasTarget");
          }
          if (op.canvas !== undefined) {
            if (typeof op.canvas !== "string") throw new EnsoCliError("invalid_input", "Canvas selectors must be strings");
            await this.context.resolve(path => this.bootstrap(path), op.canvas);
          }
        }
      }
      url.searchParams.delete("canvasTarget");
      delete object.canvasTarget;
      if (method === "GET") url.searchParams.set("canvasTarget", JSON.stringify(target));
      else object.canvasTarget = target;
      if (method === "GET" && Object.keys(object).some(key => key !== "canvas")) {
        throw new EnsoCliError("invalid_input", "GET request fields belong in the query; only canvasTarget and canvas selectors can be normalized from a body");
      }
      body = method === "GET" ? undefined : object;
    }
    const expectedVault = this.context.bound ?? this.context.resolvedTarget;
    if (scope === "vault" && method === "GET" && expectedVault) await this.assertVault();
    const result = await this.transmit(url, method, body, options.auth !== false && scope !== "health", scope === "canvas" ? contractVersion : oldestSupportedContractVersion);
    if (result.ok && url.pathname === "/v1/vault/current" && expectedVault) this.checkVault(result);
    if (result.ok && scope === "vault" && method === "GET" && expectedVault) await this.assertVault();
    return result;
  }

  private async assertVault(): Promise<void> {
    const result = await this.bootstrap("/v1/vault/current");
    this.checkVault(result);
  }

  private checkVault(result: EnsoEnvelope): void {
    if (!result.ok) throw new EnsoCliError(result.error.code, result.error.message, result.error.details);
    const activeVaultID = (result.data as { vaultID?: string })?.vaultID;
    const target = this.context.bound ?? this.context.resolvedTarget;
    if (activeVaultID?.toUpperCase() !== target?.vaultID) {
      throw new EnsoCliError("wrong_vault", "The invocation's vault is not active; open it explicitly in Enso", { activeVaultID, target });
    }
  }

  private async negotiate(): Promise<void> {
    return this.context.negotiated ??= (async () => {
      const result = await this.bootstrap("/v1/health", false);
      if (!result.ok) throw new EnsoCliError(result.error.code, result.error.message, result.error.details);
      const connection = await this.connect();
      assertTargetingContract((result.data as { contractVersion?: unknown })?.contractVersion, connection.bridgeUrl);
    })();
  }

  private async bootstrap(path: string, auth = true): Promise<EnsoEnvelope> {
    const connection = await this.connect();
    return this.transmit(new URL(path, connection.bridgeUrl), "GET", undefined, auth, oldestSupportedContractVersion);
  }

  private async connect(discover = true): Promise<{ bridgeUrl: string; token?: string }> {
    if (!discover && !this.context.connection) {
      const config = readConfig();
      const bridgeUrl = this.baseUrl ?? config?.bridgeUrl ?? defaultBridgeUrl;
      assertLoopbackBridge(new URL(bridgeUrl));
      return { bridgeUrl, token: this.tokenOverride ?? config?.token };
    }
    if (!this.context.connection) {
      this.context.connection = (async () => {
        const config = readConfig();
        const bridgeUrl = this.baseUrl ?? config?.bridgeUrl ?? defaultBridgeUrl;
        assertLoopbackBridge(new URL(bridgeUrl));
        const token = this.tokenOverride ?? config?.token;
        if (!token) {
          const discovered = this.context.bound
            ? await discoverAndLink([bridgeUrl], { stay: true })
            : await discoverAndLink();
          if (discovered) return discovered;
        }
        return { bridgeUrl, token };
      })();
    }
    const connection = await this.context.connection;
    if (this.joiningConnection && this.baseUrl && new URL(this.baseUrl).origin !== new URL(connection.bridgeUrl).origin) {
      throw new EnsoCliError("target_conflict", "A client cannot override the invocation's bridge instance");
    }
    return connection;
  }

  private async transmit(url: URL, method: string, body: unknown, auth: boolean, version: number): Promise<EnsoEnvelope> {
    const connection = await this.connect(auth);
    if (auth && !connection.token) throw new EnsoCliError("auth_required", "Launch the Enso app, then run this command again to link the CLI", {
      hint: "Update Enso so it provisions a token file, or run `enso auth link` to pair through its prompt"
    });
    const headers: Record<string, string> = { Accept: "application/json", [contractHeader]: String(version) };
    if (auth) headers.Authorization = `Bearer ${connection.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const result = await this.send(url, method, headers, serialized);
    // Only an explicit authentication rejection is safe to resend. Targeted work is never replayed.
    if (auth && !this.tokenOverride && !this.context.bound && version < contractVersion && !result.ok && result.error.code === "invalid_token") {
      const discovered = await discoverAndLink([connection.bridgeUrl], { stay: true });
      if (!discovered) throw new EnsoCliError("invalid_token", "The stored Enso pairing is stale", {
        bridgeUrl: connection.bridgeUrl,
        hint: "Open Enso, turn Local agent access off and on in Settings, then run `enso auth link`"
      });
      this.context.connection = Promise.resolve(discovered);
      return this.send(url, method, { ...headers, Authorization: `Bearer ${discovered.token}` }, serialized);
    }
    return result;
  }

  private async send(requestUrl: URL, method: string, headers: Record<string, string>, body?: string): Promise<EnsoEnvelope> {
    let response: Response;
    try {
      response = await fetch(requestUrl, { method, headers, body });
    } catch {
      throw new EnsoCliError("app_unavailable", "The configured Enso app bridge is not available", {
        bridgeUrl: requestUrl.origin,
        hint: method === "GET" ? "Run `enso auth link` to relink, or launch the configured Enso app" :
          "The request may have partially completed. Inspect the original target before deciding whether to retry; the CLI has not replayed it",
        ...(method === "GET" ? {} : { outcome: "unknown" })
      });
    }

    const uncertain = method === "GET" ? {} : { outcome: "unknown", hint: "Inspect the original target for partial effects before deciding whether to retry; the CLI has not replayed the request" };
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new EnsoCliError("invalid_response", "Enso app bridge returned non-JSON output", {
        status: response.status, ...uncertain
      });
    }

    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new EnsoCliError("invalid_response", "Enso app bridge returned an invalid envelope", {
        status: response.status, ...uncertain
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
