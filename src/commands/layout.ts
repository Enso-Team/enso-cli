import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { canvasSpecContract, parseCanvasSpec, specError } from "../canvas-spec.js";
import { compileCanvasSpec } from "../layout.js";
import { type EnsoEnvelope } from "../errors.js";
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
        const applied = await applyCanvasIntent(patch, Boolean(options.dryRun));
        if (!applied.ok) return applied;
        return { ok: true, data: { ...summary(spec.canvas, spec.direction, patch, options.out), applied: applied.data } };
      }
      return { ok: true, data: { ...summary(spec.canvas, spec.direction, patch, options.out), patch } };
    });
}

function summary(canvas: string, direction: string, patch: { nodes: unknown[]; links: unknown[]; primitives: unknown[] }, out?: string): Record<string, unknown> {
  return {
    canvas,
    direction,
    compiled: { nodes: patch.nodes.length, links: patch.links.length, regions: patch.primitives.length },
    ...(out === undefined ? {} : { out })
  };
}
