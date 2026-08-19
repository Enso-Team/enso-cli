import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { canvasSpecContract, parseCanvasSpec, specError } from "../canvas-spec.js";
import { compileCanvasSpec } from "../layout.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";
import { applyCanvasIntent } from "./canvas.js";

export function registerLayout(program: Command): void {
  program
    .command("layout")
    .argument("[spec.canvas.md]", "canvas spec manifest")
    .option("--schema", "print the machine-readable canvas spec contract")
    .option("--out <path>", "write the compiled apply patch to a file")
    .option("--apply", "send the compiled patch through the canvas apply pipeline")
    .option("--dry-run", "with --apply, validate without mutating")
    .description("Compile a canvas spec into an apply patch with deterministic geometry")
    .action(async (specPath: string | undefined, options: { schema?: boolean; out?: string; apply?: boolean; dryRun?: boolean }): Promise<EnsoEnvelope> => {
      if (options.schema) {
        if (specPath || options.out || options.apply || options.dryRun) {
          throw specError("--schema cannot be combined with a spec path or compilation options", "transport");
        }
        return { ok: true, data: canvasSpecContract };
      }
      if (!specPath) throw specError("Canvas layout requires a canvas spec path", "transport");
      if (options.dryRun && !options.apply) {
        throw specError("--dry-run only applies with --apply; without it nothing reaches the app", "transport");
      }
      let source: string;
      try {
        source = readFileSync(specPath, "utf8");
      } catch (error) {
        throw specError(`Canvas spec '${specPath}' cannot be read: ${error instanceof Error ? error.message : "unknown error"}`, "spec");
      }
      const spec = parseCanvasSpec(source);
      const patch = compileCanvasSpec(spec);
      if (options.out) writeFileSync(options.out, `${JSON.stringify(patch, null, 2)}\n`);
      if (options.apply) {
        let applied: EnsoEnvelope;
        try {
          applied = await applyCanvasIntent(patch, Boolean(options.dryRun));
        } catch (error) {
          throw relayoutError(error) ?? error;
        }
        if (!applied.ok) {
          const relayout = relayoutError(applied.error);
          if (relayout) return { ok: false, error: { ...relayout.body, details: { ...relayout.body.details, ...applied.error.details } } };
          return applied;
        }
        return {
          ok: true,
          data: {
            ...summary(spec.canvas, spec.direction, patch, options.out),
            ...validationSummary(applied.data),
            applied: applied.data
          }
        };
      }
      return { ok: true, data: { ...summary(spec.canvas, spec.direction, patch, options.out), patch } };
    });
}

const RELAYOUT_CODES = new Set(["title_collision", "already_on_canvas"]);

/**
 * Layout compiles a canvas from scratch. When the target Canvas already holds the
 * members, say so in one place instead of leaking a collision from preflight or an
 * already_on_canvas from the middle of the phase loop.
 */
function relayoutError(error: unknown): EnsoCliError | undefined {
  const code = error instanceof EnsoCliError
    ? error.body.code
    : typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  if (code === undefined || !RELAYOUT_CODES.has(code)) return undefined;
  return new EnsoCliError("canvas_already_laid_out", "The target Canvas already contains members of this spec; re-layout is not supported yet", {
    path: "canvas",
    expected: "a Canvas without the spec's members",
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

function summary(canvas: string, direction: string, patch: { nodes: unknown[]; links: unknown[]; primitives: unknown[] }, out?: string): Record<string, unknown> {
  return {
    canvas,
    direction,
    compiled: { nodes: patch.nodes.length, links: patch.links.length, regions: patch.primitives.length },
    ...(out === undefined ? {} : { out })
  };
}
