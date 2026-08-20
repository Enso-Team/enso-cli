import { readFileSync } from "node:fs";
import { Command } from "commander";
import { type CanvasSpec, canvasSpecContract, parseCanvasSpec, specError } from "../canvas-spec.js";
import { compileCanvasSpec } from "../layout.js";
import { centerPatchOnCanvas } from "../layout-centering.js";
import { BridgeClient } from "../client.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";
import { mermaidContract, mermaidError, parseMermaid } from "../mermaid.js";
import { resolveAgainstVault } from "../vault-notes.js";
import { applyCanvasIntent, requestCanvasContext } from "./canvas.js";

type LayoutOptions = {
  schema?: boolean;
  apply?: boolean;
  dryRun?: boolean;
  spacing?: string;
  fromMermaid?: string;
  canvas?: string;
};

export function registerLayout(program: Command): void {
  program
    .command("layout")
    .argument("[spec.canvas.md]", "canvas spec manifest")
    .option("--schema", "print the machine-readable canvas spec contract")
    .option("--from-mermaid <graph.mmd>", "compile a mermaid flowchart or state diagram instead of a canvas spec")
    .option("--canvas <name>", "target Canvas for a mermaid diagram")
    .option("--apply", "send the compiled patch through the canvas apply pipeline")
    .option("--dry-run", "with --apply, validate without mutating")
    .option("--spacing <factor>", "scale the distance between node centers (node sizes stay fixed), e.g. 1.5 when link labels need room")
    .description("Compile a canvas spec or mermaid diagram into an apply patch with deterministic geometry")
    .action(async (specPath: string | undefined, options: LayoutOptions): Promise<EnsoEnvelope> => {
      if (options.schema) {
        if (specPath || options.apply || options.dryRun || options.spacing || options.fromMermaid || options.canvas) {
          throw usageError("--schema prints the contract on its own");
        }
        return { ok: true, data: { ...canvasSpecContract, mermaid: mermaidContract } };
      }
      if (specPath && options.fromMermaid) {
        throw usageError("Layout compiles one graph: a canvas spec path, or --from-mermaid");
      }
      if (!specPath && !options.fromMermaid) throw usageError("Canvas layout requires a canvas spec path or --from-mermaid");
      if (options.canvas && !options.fromMermaid) {
        throw usageError("A canvas spec names its own target Canvas, so --canvas takes --from-mermaid");
      }
      if (options.dryRun && !options.apply) {
        throw usageError("--dry-run validates the apply pipeline, so it takes --apply");
      }
      let spec: CanvasSpec;
      let resolution: Record<string, unknown> = {};
      if (options.fromMermaid) {
        const parsed = parseMermaid(readInput(options.fromMermaid, "mermaid", mermaidError), options.canvas);
        const resolved = await resolveAgainstVault(parsed);
        if ("envelope" in resolved) return resolved.envelope;
        spec = { ...parsed, members: resolved.members };
        resolution = { source: "mermaid", notes: { reused: resolved.reused, stubs: resolved.stubs } };
      } else {
        spec = parseCanvasSpec(readInput(specPath!, "spec", specError));
      }
      const compiled = compileCanvasSpec(spec, spacingFactor(options.spacing));
      // Compiled geometry is relative to the origin. Applying it reads the target Canvas
      // first and moves the whole cluster to where the app looks; --dry-run reports the
      // same translated coordinates the apply would write.
      const context = options.apply ? await canvasContext(spec.canvas) : undefined;
      const patch = options.apply ? centerPatchOnCanvas(compiled, context?.ok ? context.data : undefined) : compiled;
      if (options.apply) {
        let applied: EnsoEnvelope;
        try {
          applied = await applyCanvasIntent(patch, Boolean(options.dryRun), context);
        } catch (error) {
          throw relayoutError(error) ?? error;
        }
        if (!applied.ok) {
          const relayout = relayoutError(applied.error);
          if (relayout) return { ok: false, error: { ...relayout.body, details: { ...applied.error.details, ...relayout.body.details } } };
          return applied;
        }
        return {
          ok: true,
          data: {
            ...summary(spec.canvas, spec.direction, patch),
            ...resolution,
            ...validationSummary(applied.data),
            applied: applied.data
          }
        };
      }
      return { ok: true, data: { ...summary(spec.canvas, spec.direction, patch), ...resolution, patch } };
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

function readInput(path: string, errorPath: string, fail: (message: string, path: string) => EnsoCliError): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw fail(`Layout input '${path}' cannot be read: ${error instanceof Error ? error.message : "unknown error"}`, errorPath);
  }
}

function usageError(message: string): EnsoCliError {
  return new EnsoCliError("invalid_input", message, {
    path: "usage",
    expected: "enso layout <spec.canvas.md> or enso layout --from-mermaid <graph.mmd> [--canvas <name>], each taking [--spacing <factor>] and [--apply [--dry-run]], or enso layout --schema",
    hint: "Run `enso layout --help` for the flag list"
  });
}

const RELAYOUT_CODES = new Set(["title_collision", "already_on_canvas"]);

/**
 * Layout compiles a Canvas once. This folds the preflight title collision and the app's
 * already_on_canvas into one error that names the re-layout ticket.
 */
function relayoutError(error: unknown): EnsoCliError | undefined {
  const code = error instanceof EnsoCliError
    ? error.body.code
    : typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  if (code === undefined || !RELAYOUT_CODES.has(code)) return undefined;
  return new EnsoCliError("canvas_already_laid_out", "The target Canvas already contains members of this spec", {
    path: "canvas",
    expected: "a target Canvas free of the spec's members",
    hint: "Compile onto an empty Canvas, or remove the existing elements first. Re-layout and update mode are tracked in issue #25.",
    cause: error instanceof EnsoCliError ? error.body : error
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
