import { Command } from "commander";
import { readFileSync } from "node:fs";
import { canvasApplyContract, compileCanvasApply, parseCanvasIntent, verifyCanvasIntent } from "../canvas-intent.js";
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
      const inspect = () => intent.canvas === "current"
        ? client.request("/v1/context", { method: "POST", body: { depth: 1, includeContent: false } })
        : client.request(`/v1/canvases/${encodeURIComponent(intent.canvas)}/inspect`);
      const context = await inspect();
      if (!context.ok) return context;
      const availableNotes: string[] = [];
      const vaultQueries = new Set(intent.nodes.flatMap((node) => {
        if (node.kind !== "note") return [];
        if (node.mode === "reuse") return [node.selector];
        if (node.mode === "create") return [node.title];
        return [];
      }));
      for (const query of vaultQueries) {
        const search = await client.request("/v1/search", { query: { q: query } });
        if (!search.ok) return search;
        availableNotes.push(...noteNames(search.data));
      }
      const contextData = context.data && typeof context.data === "object"
        ? { ...(context.data as Record<string, unknown>), availableNotes: [...new Set(availableNotes)] }
        : { availableNotes: [...new Set(availableNotes)] };
      const compiled = compileCanvasApply(intent, contextData);
      const dryRun = Boolean(options.dryRun);
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
            validation: {
              local: "complete",
              bridgeValidated: bridgePhase ? [bridgePhase.name] : [],
              deferredUntilApply: compiled.phases.slice(bridgePhase ? 1 : 0).map((phase) => phase.name)
            },
            planned: Object.fromEntries(compiled.phases.map((phase) => [phase.name, phase.operations.length])),
            sharedNoteWrites: intent.nodes.flatMap((node) =>
              node.kind === "note" && node.mode === "update" && node.content !== undefined ? [node.selector] : []),
            phases: compiled.phases.map((phase) => ({ name: phase.name, operations: phase.operations }))
          }
        };
      }

      if (compiled.phases.length === 0) {
        return {
          ok: true,
          data: {
            appliedBatches: [],
            results: [],
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
          appliedBatches,
          results,
          verification: { status: "verified", target: intent.canvas, requested: compiled.verification }
        }
      };
    });
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
