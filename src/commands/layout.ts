import { readFileSync } from "node:fs";
import { Command } from "commander";
import { canvasSpecContract, parseCanvasSpec, specError } from "../canvas-spec.js";
import { compileCanvasSpec } from "../layout.js";
import { reconcileLayout } from "../layout-reconcile.js";
import { BridgeClient } from "../client.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";
import { applyCanvasIntent, requestCanvasContext } from "./canvas.js";

export function registerLayout(program: Command): void {
  program
    .command("layout")
    .argument("[spec.canvas.md]", "canvas spec manifest")
    .option("--schema", "print the machine-readable canvas spec contract")
    .option("--apply", "send the compiled patch through the canvas apply pipeline")
    .option("--dry-run", "with --apply, validate without mutating")
    .option("--spacing <factor>", "scale the distance between node centers (node sizes stay fixed), e.g. 1.5 when link labels need room")
    .option("--prune", "with --apply, remove Notes, Links, and regions the spec no longer names (Note files stay)")
    .description("Compile a canvas spec into an apply patch with deterministic geometry")
    .action(async (specPath: string | undefined, options: { schema?: boolean; apply?: boolean; dryRun?: boolean; spacing?: string; prune?: boolean }): Promise<EnsoEnvelope> => {
      if (options.schema) {
        if (specPath || options.apply || options.dryRun || options.spacing || options.prune) {
          throw usageError("--schema prints the contract on its own");
        }
        return { ok: true, data: canvasSpecContract };
      }
      if (!specPath) throw usageError("Canvas layout requires a canvas spec path");
      if (options.dryRun && !options.apply) {
        throw usageError("--dry-run validates the apply pipeline, so it takes --apply");
      }
      if (options.prune && !options.apply) {
        throw usageError("--prune reconciles the live Canvas, so it takes --apply");
      }
      let source: string;
      try {
        source = readFileSync(specPath, "utf8");
      } catch (error) {
        throw specError(`Canvas spec '${specPath}' cannot be read: ${error instanceof Error ? error.message : "unknown error"}`, "spec");
      }
      const spec = parseCanvasSpec(source);
      const compiled = compileCanvasSpec(spec, spacingFactor(options.spacing));
      if (!options.apply) return { ok: true, data: { ...summary(spec.canvas, spec.direction, compiled), patch: compiled } };
      // Compiled geometry is relative to the origin. Applying it reads the target Canvas
      // first and reconciles: members already on the Canvas move in place, anchored on
      // where they are, and everything else lands where the app looks. --dry-run reports
      // the same operations the apply would send.
      const context = await canvasContext(spec.canvas);
      const { patch, summary: reconciled } = reconcileLayout(compiled, context?.ok ? context.data : undefined, { prune: Boolean(options.prune) });
      const applied = await applyCanvasIntent(patch, Boolean(options.dryRun), context);
      if (!applied.ok) return applied;
      return {
        ok: true,
        data: {
          ...summary(spec.canvas, spec.direction, compiled),
          reconciled,
          ...validationSummary(applied.data),
          applied: applied.data
        }
      };
    });
}

/**
 * What the target Canvas holds, or nothing when the bridge cannot say. An unreachable
 * bridge leaves placement on the empty-Canvas home and lets the apply pipeline report the
 * transport failure on its own terms.
 */
async function canvasContext(canvas: string): Promise<EnsoEnvelope | undefined> {
  try {
    return await requestCanvasContext(new BridgeClient(), canvas);
  } catch {
    return undefined;
  }
}

function spacingFactor(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor < 1 || factor > 10) {
    throw new EnsoCliError("invalid_input", `Spacing factor '${raw}' is out of range`, {
      path: "spacing",
      expected: "a number from 1 to 10",
      hint: "1 is the standard grid; 1.5 or 2 opens the gaps between nodes so link labels have room"
    });
  }
  return factor;
}

function usageError(message: string): EnsoCliError {
  return new EnsoCliError("invalid_input", message, {
    path: "usage",
    expected: "enso layout <spec.canvas.md> [--spacing <factor>] [--apply [--dry-run] [--prune]], or enso layout --schema",
    hint: "Run `enso layout --help` for the flag list"
  });
}

/**
 * Name which phases the app validated and which passed local validation alone, so a
 * deferred phase is never mistaken for a bridge-accepted one.
 */
function validationSummary(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const validation = (data as { validation?: unknown }).validation;
  if (!validation || typeof validation !== "object") return {};
  const { bridgeValidated, deferredUntilApply } = validation as { bridgeValidated?: unknown; deferredUntilApply?: unknown };
  if (!Array.isArray(bridgeValidated) || !Array.isArray(deferredUntilApply)) return {};
  return { validation: { bridgeValidated, locallyValidatedOnly: deferredUntilApply } };
}

function summary(canvas: string, direction: string, patch: { nodes: unknown[]; links: unknown[]; primitives: unknown[] }): Record<string, unknown> {
  return {
    canvas,
    direction,
    compiled: { nodes: patch.nodes.length, links: patch.links.length, regions: patch.primitives.length }
  };
}
