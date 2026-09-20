import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canvasApplyContract, compileCanvasApply, parseCanvasIntent, verifyCanvasIntent, type CanvasIntent } from "../canvas-intent.js";
import { CANVAS_WORLD_HOME, centeringOffset, existingContent, isPureCreation, patchBounds, translatePatch } from "../layout-centering.js";
import { BridgeClient } from "../client.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";

export function registerCanvas(program: Command): void {
  const canvas = program.command("canvas").description("Manage Enso canvases");

  canvas.command("list").action(async () => new BridgeClient().request("/v1/canvases"));
  canvas.command("current").action(async () => new BridgeClient().request("/v1/canvases/current"));
  canvas
    .command("create")
    .argument("<name>")
    .option("--dry-run", "validate without mutating")
    .action(async (name: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request("/v1/canvases", {
        method: "POST",
        body: { name, dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
  canvas
    .command("open")
    .argument("<selector>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/canvases/${encodeURIComponent(selector)}/open`, {
        method: "POST",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
  canvas
    .command("inspect")
    .argument("<selector>")
    .action(async (selector: string) =>
      new BridgeClient().request(`/v1/canvases/${encodeURIComponent(selector)}/inspect`)
    );
  canvas
    .command("outline")
    .description("Print the markdown outline Enso keeps for a Canvas under Canvases/ in the Vault")
    .argument("<selector>", "Canvas name, id, or ref")
    .action(async (selector: string): Promise<EnsoEnvelope> => {
      const client = new BridgeClient();
      const canvases = await client.request("/v1/canvases");
      if (!canvases.ok) return canvases;
      const listed = readArray<{ id?: string; name?: string; ref?: string }>(canvases.data, "canvases");
      const found = listed.filter((item) => [item.id, item.name, item.ref].includes(selector));
      if (found.length !== 1) {
        throw new EnsoCliError(found.length === 0 ? "missing_selector" : "ambiguous_selector",
          found.length === 0 ? `No Canvas matches '${selector}'` : `Multiple Canvases match '${selector}'`,
          { path: "canvas", expected: "one Canvas name, id, or ref", hint: "Run `enso canvas list` and copy one exactly" });
      }
      const vault = await client.request("/v1/vault/current");
      if (!vault.ok) return vault;
      const root = (vault.data as { path?: string } | undefined)?.path;
      const ref = found[0].ref ?? `${found[0].name}.json`;
      if (!root) throw new EnsoCliError("vault_unavailable", "The app reported no Vault path", { path: "vault", expected: "a Vault folder", hint: "Open a Vault in Enso" });
      const file = join(root, "Canvases", ref.replace(/\.json$/i, "") + ".md");
      let markdown: string;
      try {
        markdown = readFileSync(file, "utf8");
      } catch {
        throw new EnsoCliError("outline_missing", `No outline at ${file}`, { path: "outline", expected: "the outline Enso writes on Canvas save", hint: "Open the Canvas in Enso once so it writes its outline" });
      }
      return { ok: true, data: { canvas: found[0].name ?? selector, file, markdown } };
    });
  canvas
    .command("delete")
    .argument("<selector>")
    .option("--dry-run", "validate without mutating")
    .action(async (selector: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/canvases/${encodeURIComponent(selector)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );

  canvas
    .command("apply")
    .argument("[file.json]", "canvas mutation spec")
    .option("--json <json>", "JSON literal, or - to read JSON from stdin")
    .option("--schema", "print the machine-readable canvas apply contract")
    .option("--dry-run", "validate and return the compiled plan without mutating")
    .description("Apply a canvas mutation in dependency-aware, per-phase atomic batches")
    .action(async (intentPath: string | undefined, options: { dryRun?: boolean; json?: string; schema?: boolean }): Promise<EnsoEnvelope> => {
      if (options.schema) {
        if (intentPath || options.json !== undefined) {
          throw transportError("--schema cannot be combined with a JSON input transport");
        }
        return { ok: true, data: canvasApplyContract };
      }
      if (intentPath && options.json !== undefined) {
        throw transportError("Use exactly one canvas apply JSON transport");
      }
      if (!intentPath && options.json === undefined) {
        throw transportError("Canvas apply requires a file path, --json literal, or --json -");
      }
      const source = intentPath
        ? readFileSync(intentPath, "utf8")
        : options.json === "-"
          ? readFileSync(0, "utf8")
          : options.json!;
      let decoded: unknown;
      try {
        decoded = JSON.parse(source);
      } catch (error) {
        throw new EnsoCliError("invalid_input", "Canvas apply input is not valid JSON", {
          path: "transport",
          expected: "a JSON object",
          hint: error instanceof Error ? error.message : "Check the JSON syntax"
        });
      }
      const intent = parseCanvasIntent(decoded);
      const client = new BridgeClient();
      const context = await requestCanvasContext(client, intent.canvas);
      if (!context.ok) return context;
      // A pure-creation intent on an empty Canvas lands on the app's empty-Canvas home
      // point, where the first load focuses, instead of wherever the author's coordinates
      // happen to sit. Existing content or any update means the author placed
      // against inspected geometry, so the coordinates pass through untouched.
      const { patch, placement } = placeIntentOnCanvas(intent, context.data);
      return applyCanvasIntent(patch, Boolean(options.dryRun), context, placement);
    });
}

/** Read what a Canvas currently holds: the app's context for `current`, inspect for a named one. */
export function requestCanvasContext(client: BridgeClient, canvas: string): Promise<EnsoEnvelope> {
  return canvas === "current"
    ? client.request("/v1/context", { method: "POST", body: { depth: 1, includeContent: false } })
    : client.request(`/v1/canvases/${encodeURIComponent(canvas)}/inspect`);
}

type PlacementReport = {
  recentered: boolean;
  dx: number;
  dy: number;
  home?: typeof CANVAS_WORLD_HOME;
};

function placeIntentOnCanvas(intent: CanvasIntent, context: unknown): { patch: CanvasIntent; placement: PlacementReport } {
  if (!(isPureCreation(intent) && existingContent(context) === undefined)) {
    return { patch: intent, placement: { recentered: false, dx: 0, dy: 0 } };
  }
  const offset = centeringOffset(patchBounds(intent), undefined);
  const recentered = offset.dx !== 0 || offset.dy !== 0;
  return {
    patch: translatePatch(intent, offset),
    placement: recentered
      ? { recentered: true, dx: offset.dx, dy: offset.dy, home: CANVAS_WORLD_HOME }
      : { recentered: false, dx: 0, dy: 0 }
  };
}

/**
 * Run a validated canvas intent through the dependency-aware apply pipeline. A caller that
 * already read the target Canvas passes that context in so the preflight reads it once.
 */
export async function applyCanvasIntent(
  intent: CanvasIntent,
  dryRun: boolean,
  preflightContext?: EnsoEnvelope,
  placement: PlacementReport = { recentered: false, dx: 0, dy: 0 }
): Promise<EnsoEnvelope> {
  const client = new BridgeClient();
  const inspect = () => requestCanvasContext(client, intent.canvas);
  const context = preflightContext ?? await inspect();
  if (!context.ok) return context;
  const availableNotes: string[] = [];
  const vaultQueries = new Set(intent.nodes.flatMap((node) => node.kind === "note" && node.mode === "place" ? [node.note] : []));
  // Vault lookups are independent, so they run together; results accumulate in query
  // order to keep availableNotes deterministic, and the first failure in that order wins.
  const searches = await Promise.all([...vaultQueries].map((query) => client.request("/v1/search", { query: { q: query } })));
  for (const search of searches) {
    if (!search.ok) return search;
    availableNotes.push(...noteNames(search.data));
  }
  const contextData = context.data && typeof context.data === "object"
    ? { ...(context.data as Record<string, unknown>), availableNotes: [...new Set(availableNotes)] }
    : { availableNotes: [...new Set(availableNotes)] };
  const compiled = compileCanvasApply(intent, contextData);
  if (dryRun) {
    const first = compiled.phases[0];
    const bridgePhase = intent.canvas === "current" ? first : undefined;
    if (bridgePhase) {
      const bridgeResult = await client.request("/v1/apply", { method: "POST", body: { operations: first.operations, dryRun: true }, dryRun: true });
      if (!bridgeResult.ok) return bridgeResult;
    }
    return {
      ok: true,
      data: {
        dryRun: true,
        preflightPassed: true,
        placement,
        validation: {
          local: "complete",
          bridgeValidated: bridgePhase ? [bridgePhase.name] : [],
          deferredUntilApply: compiled.phases.slice(bridgePhase ? 1 : 0).map((phase) => phase.name)
        },
        planned: Object.fromEntries(compiled.phases.map((phase) => [phase.name, phase.operations.length])),
        phases: compiled.phases.map((phase) => ({ name: phase.name, operations: phase.operations }))
      }
    };
  }

  if (compiled.phases.length === 0) {
    return {
      ok: true,
      data: {
        applied: true,
        appliedBatches: [],
        results: [],
        placement,
        verification: { status: "verified", target: intent.canvas, requested: compiled.verification, source: "preflight" }
      }
    };
  }

  if (intent.canvas !== "current") {
    const opened = await client.request(`/v1/canvases/${encodeURIComponent(intent.canvas)}/open`, { method: "POST", body: { dryRun: false }, dryRun: false });
    if (!opened.ok) return opened;
  }
  const appliedBatches: Array<{ name: string; count: number }> = [];
  const results: Record<string, unknown>[] = [];
  for (const phase of compiled.phases) {
    const result = await client.request("/v1/apply", {
      method: "POST",
      body: { operations: phase.operations, dryRun: false },
      dryRun: false
    });
    if (!result.ok) {
      return {
        ok: false,
        error: {
          ...result.error,
          details: {
            ...result.error.details,
            appliedBatches,
            failedBatch: phase.name,
            returnedIds: results.flatMap((item) => typeof item.id === "string" ? [item.id] : []),
            retrySections: phase.retrySections
          }
        }
      };
    }
    appliedBatches.push({ name: phase.name, count: phase.operations.length });
    results.push(...projectResults(result.data));
  }
  const verification = await inspect();
  const verificationResult = verification.ok ? verifyCanvasIntent(intent, verification.data) : { ok: false, mismatches: ["target unavailable"] };
  if (!verification.ok || !verificationResult.ok) {
    return {
      ok: false,
      error: {
        code: "verification_failed",
        message: "Canvas mutations succeeded, but targeted verification failed",
        details: {
          appliedBatches,
          returnedIds: results.flatMap((item) => typeof item.id === "string" ? [item.id] : []),
          mismatches: verificationResult.mismatches,
          retrySections: []
        }
      }
    };
  }
  return {
    ok: true,
    data: {
      applied: true,
      appliedBatches,
      results,
      placement,
      verification: { status: "verified", target: intent.canvas, requested: compiled.verification }
    }
  };
}

function transportError(message: string): EnsoCliError {
  return new EnsoCliError("invalid_input", message, {
    path: "transport",
    expected: "exactly one of file, --json <literal>, or --json -",
    hint: "Run `enso canvas apply --schema` for transport details"
  });
}

function projectResults(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const values = (data as { results?: unknown }).results;
  if (!Array.isArray(values)) return [];
  const keys = new Set(["type", "id", "status", "binding", "bindingStatus", "relationProsePreserved", "fromNote"]);
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const projected = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => keys.has(key)));
    return Object.keys(projected).length > 0 ? [projected] : [];
  });
}

function noteNames(data: unknown): string[] {
  if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) return [];
  const names: string[] = [];
  for (const result of (data as { results: unknown[] }).results) {
    if (!result || typeof result !== "object") continue;
    const item = result as { path?: unknown; node?: unknown };
    if (typeof item.path === "string") {
      names.push(item.path);
      const filename = item.path.split("/").pop();
      if (filename) names.push(filename.replace(/\.md$/i, ""));
    }
    if (item.node && typeof item.node === "object") {
      const node = item.node as { title?: unknown; displayTitle?: unknown; ref?: unknown };
      for (const value of [node.title, node.displayTitle, node.ref]) if (typeof value === "string") names.push(value);
    }
  }
  return names;
}

function readArray<T>(value: unknown, key: string): T[] {
  if (!value || typeof value !== "object") return [];
  const items = (value as Record<string, unknown>)[key];
  return Array.isArray(items) ? items as T[] : [];
}
