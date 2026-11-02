import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { EnsoCliError, type EnsoEnvelope } from "./errors.js";

const targetSchema = z.object({ vaultID: z.string().uuid(), canvasID: z.string().uuid() }).strict();
export type CanvasTarget = Readonly<z.infer<typeof targetSchema>>;
export type TargetOptions = { canvas?: string; vaultId?: string; canvasId?: string };
type Bootstrap = (path: string) => Promise<EnsoEnvelope>;

export function parseTarget(value: unknown): CanvasTarget {
  const parsed = targetSchema.safeParse(value);
  if (!parsed.success) throw new EnsoCliError("invalid_target", "canvasTarget must contain exactly vaultID and canvasID UUID strings");
  return Object.freeze({ vaultID: parsed.data.vaultID.toUpperCase(), canvasID: parsed.data.canvasID.toUpperCase() });
}

export function sameTarget(a: CanvasTarget, b: CanvasTarget): boolean {
  return a.vaultID === b.vaultID && a.canvasID === b.canvasID;
}

function binding(vaultID: string | undefined, canvasID: string | undefined): CanvasTarget | undefined {
  if (vaultID === undefined && canvasID === undefined) return undefined;
  if (vaultID === undefined || canvasID === undefined) {
    throw new EnsoCliError("invalid_target", "An immutable binding requires both --vault-id and --canvas-id (or both ENSO_VAULT_ID and ENSO_CANVAS_ID)");
  }
  return parseTarget({ vaultID, canvasID });
}

export class RequestContext {
  readonly bound?: CanvasTarget;
  connection?: Promise<{ bridgeUrl: string; token?: string }>;
  negotiated?: Promise<void>;
  private target?: Promise<CanvasTarget>;
  resolvedTarget?: CanvasTarget;
  private selectors = new Set<string>();
  private readonly preferredSelector?: string;

  constructor(options: TargetOptions = {}) {
    this.preferredSelector = options.canvas;
    const environment = binding(process.env.ENSO_VAULT_ID, process.env.ENSO_CANVAS_ID);
    const flags = binding(options.vaultId, options.canvasId);
    if (environment && flags && !sameTarget(environment, flags)) this.conflict();
    this.bound = environment ?? flags;
    if (options.canvas !== undefined) {
      if (this.bound) this.conflict();
      this.selectors.add(options.canvas);
    }
  }

  rejectNavigation(): never {
    throw new EnsoCliError("explicit_navigation_required", "This invocation is bound to one vault and canvas; run navigation separately without the binding");
  }

  async resolve(bootstrap: Bootstrap, selector?: string, supplied?: unknown): Promise<CanvasTarget> {
    if (selector && selector !== "current") this.selectors.add(selector);
    const explicit = supplied === undefined ? undefined : parseTarget(supplied);
    if (explicit && this.bound && !sameTarget(explicit, this.bound)) this.conflict();
    if (!this.target) {
      this.target = this.discover(bootstrap, explicit);
    }
    const target = await this.target;
    this.resolvedTarget = target;
    if (explicit && !sameTarget(explicit, target)) this.conflict();
    for (const selected of this.selectors) {
      if (selected === "current" || selected.toUpperCase() === target.canvasID) continue;
      if (this.bound) this.conflict();
      const candidates = await this.canvases(bootstrap);
      const match = selectCanvas(candidates, selected);
      if (!sameTarget(target, identity(match))) this.conflict();
    }
    this.selectors.clear();
    return target;
  }

  private async discover(bootstrap: Bootstrap, supplied?: CanvasTarget): Promise<CanvasTarget> {
    if (this.bound) return this.bound;
    if (supplied) return supplied;
    const selector = this.preferredSelector ?? [...this.selectors].find(value => value !== "current");
    if (selector && selector !== "current") {
      const match = selectCanvas(await this.canvases(bootstrap), selector);
      const target = identity(match);
      this.selectors.delete(selector);
      return target;
    }
    const current = unwrap(await bootstrap("/v1/canvases/current"));
    return identity(current);
  }

  private catalog?: Promise<Record<string, unknown>[]>;
  private canvases(bootstrap: Bootstrap): Promise<Record<string, unknown>[]> {
    return this.catalog ??= bootstrap("/v1/canvases").then(result => {
      const data = unwrap(result);
      if (!Array.isArray(data.canvases)) throw new EnsoCliError("invalid_response", "Enso did not return a canvas discovery list");
      return data.canvases as Record<string, unknown>[];
    });
  }

  private conflict(): never {
    throw new EnsoCliError("target_conflict", "Canvas selectors and explicit targets must agree with the invocation's immutable target", {
      hint: "Use one canvas selector, or supply only the stable --vault-id and --canvas-id pair"
    });
  }
}

function unwrap(result: EnsoEnvelope): Record<string, unknown> {
  if (!result.ok) throw new EnsoCliError(result.error.code, result.error.message, result.error.details);
  if (!result.data || typeof result.data !== "object") throw new EnsoCliError("invalid_response", "Enso returned invalid target discovery data");
  return result.data as Record<string, unknown>;
}

function identity(canvas: Record<string, unknown>): CanvasTarget {
  if (!canvas.canvasTarget) throw new EnsoCliError("target_not_found", "The canvas has no stable identity available", {
    hint: "Update Enso to a build with bridge contract 3, open the intended canvas, then run `enso canvas current`"
  });
  return parseTarget(canvas.canvasTarget);
}

function selectCanvas(canvases: Record<string, unknown>[], selector: string): Record<string, unknown> {
  const matches = canvases.filter(canvas => {
    const exact = [canvas.id, canvas.name, canvas.path, typeof canvas.name === "string" ? `${canvas.name}.json` : undefined];
    return exact.includes(selector) || [canvas.ref, canvas.canvasID].some(value => typeof value === "string" && value.toLowerCase() === selector.toLowerCase());
  });
  if (matches.length !== 1) throw new EnsoCliError(matches.length ? "ambiguous_selector" : "missing_selector", `Expected one canvas matching '${selector}'`, {
    hint: "Run `enso canvas list` and use canvasID", candidates: matches
  });
  return matches[0];
}

const invocation = new AsyncLocalStorage<RequestContext>();
export function currentRequestContext(): RequestContext | undefined { return invocation.getStore(); }
export function withRequestContext<T>(options: TargetOptions, work: () => T): T {
  return invocation.run(new RequestContext(options), work);
}

export type RouteScope = "health" | "pairing" | "discovery" | "vault" | "navigation" | "canvas";
export function routeScope(path: string, method: string): RouteScope {
  if (path === "/v1/health") return "health";
  if (path === "/v1/pair/request") return "pairing";
  if (method === "GET" && ["/v1/status", "/v1/vault/current", "/v1/canvases", "/v1/canvases/current"].includes(path)) return "discovery";
  if (["/v1/vault/tree", "/v1/vault/create"].includes(path) || method === "DELETE" && path.startsWith("/v1/canvases/")) return "vault";
  if (path === "/v1/vault/open" || method === "POST" && (path === "/v1/canvases" || /^\/v1\/canvases\/[^/]+\/open$/.test(path))) return "navigation";
  return "canvas";
}
