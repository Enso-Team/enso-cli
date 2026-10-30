import { readFileSync } from "node:fs";
import { Command } from "commander";
import { canvasSpecContract, parseCanvasSpec, specError } from "../canvas-spec.js";
import { compileCanvasSpec, computeCanvasLayout, layoutGeometry, linkCrossings, plannedExcerpts, regionWarnings } from "../layout.js";
import { checkExcerptSource } from "../excerpt-model.js";
import { markWorldBox } from "../mark-model.js";
import { centeringOffset, contextObject, patchBounds, existingContent, readArray, translatePatch } from "../layout-centering.js";
import { noteMatches } from "../note-identity.js";
import type { CanvasIntent } from "../canvas-intent.js";
import { BridgeClient } from "../client.js";
import { EnsoCliError, errorEnvelope, type EnsoEnvelope } from "../errors.js";
import { applyCanvasIntent, placementReport, requestCanvasContext } from "./canvas.js";
import { moveExcerpt, placeNoteExcerpt } from "./excerpt.js";

export function registerLayout(program: Command): void {
  program
    .command("layout")
    .argument("[graph.json]", "graph JSON: members, edges, clusters, direction")
    .option("--schema", "print the machine-readable canvas spec contract")
    .option("--apply", "send the compiled patch through the canvas apply pipeline")
    .option("--dry-run", "with --apply, validate without mutating")
    .option("--spacing <factor>", "scale the distance between node centers (node sizes stay fixed), e.g. 1.5 when link labels need room")
    .description("Compile graph JSON into an apply patch with deterministic geometry")
    .action(async (specPath: string | undefined, options: { schema?: boolean; apply?: boolean; dryRun?: boolean; spacing?: string }): Promise<EnsoEnvelope> => {
      if (options.schema) {
        if (specPath || options.apply || options.dryRun || options.spacing) {
          throw usageError("--schema prints the contract on its own");
        }
        return { ok: true, data: canvasSpecContract };
      }
      if (!specPath) throw usageError("Canvas layout requires a graph JSON path");
      if (options.dryRun && !options.apply) {
        throw usageError("--dry-run validates the apply pipeline, so it takes --apply");
      }
      let source: string;
      try {
        source = readFileSync(specPath, "utf8");
      } catch (error) {
        throw specError(`Graph JSON '${specPath}' cannot be read: ${error instanceof Error ? error.message : "unknown error"}`, "spec");
      }
      const spec = parseCanvasSpec(source);
      const spacing = spacingFactor(options.spacing);
      const compiled = compileCanvasSpec(spec, spacing);
      const layout = computeCanvasLayout(spec, spacing);
      const warnings = regionWarnings(spec, layout);
      const crossings = linkCrossings(spec, layout);
      const planned = plannedExcerpts(layout);
      // Compiled geometry is relative to the origin. Applying it reads the target Canvas
      // first and moves the whole cluster to where the app looks; --dry-run reports the
      // same translated coordinates the apply would write.
      const context = options.apply ? await canvasContext(spec.canvas) : undefined;
      // A rerun moves the Excerpts and Marks an earlier layout placed instead of adding copies.
      const onCanvas = annotationsOnCanvas(context?.ok ? context.data : undefined);
      const reusedExcerpts = planned.map((excerpt) => onCanvas.excerptId(excerpt.note, excerpt.text));
      // Excerpts quote their Notes' files. A passage the file lacks fails before anything lands.
      if (options.apply && reusedExcerpts.some((id) => id === undefined)) {
        const vault = await vaultPath();
        planned.forEach((excerpt, index) => { if (reusedExcerpts[index] === undefined) checkExcerptSource(vault, excerpt.note, excerpt.text); });
      }
      const existing = existingContent(context?.ok ? context.data : undefined);
      const offset = options.apply ? centeringOffset(patchBounds(compiled, layoutGeometry(spec), planned.map(markWorldBox)), existing) : { dx: 0, dy: 0 };
      const excerpts = planned.map((excerpt, index) => ({
        ...excerpt,
        x: excerpt.x + offset.dx,
        y: excerpt.y + offset.dy,
        ...(reusedExcerpts[index] === undefined ? {} : { id: reusedExcerpts[index] })
      }));
      const placement = placementReport(offset, existing === undefined);
      const { intent: reusing, markIds } = reuseMarks(compiled, onCanvas);
      const reused = markIds.length + reusedExcerpts.filter((id) => id !== undefined).length > 0
        ? { reused: { excerpts: reusedExcerpts.filter((id) => id !== undefined), marks: markIds } }
        : {};
      const patch = translatePatch(reusing, offset);
      if (options.apply) {
        let applied: EnsoEnvelope;
        try {
          applied = await applyCanvasIntent(patch, Boolean(options.dryRun), context, placement);
        } catch (error) {
          throw relayoutError(error, placement) ?? error;
        }
        if (!applied.ok) {
          const relayout = relayoutError(applied.error, placement);
          if (relayout) return { ok: false, error: { ...relayout.body, details: { ...applied.error.details, ...relayout.body.details } } };
          return applied;
        }
        const landed = {
          ...summary(spec.canvas, spec.direction, patch),
          warnings,
          crossings,
          placement,
          ...validationSummary(applied.data),
          applied: applied.data
        };
        if (options.dryRun) return { ok: true, data: { ...landed, ...reused, excerpts: excerpts.map((excerpt) => ({ ...excerpt, validated: "locally" })) } };
        const placed: Array<Omit<typeof excerpts[number], "id"> & { id: unknown }> = [];
        for (const excerpt of excerpts) {
          const result = await ("id" in excerpt
            ? moveExcerpt(String(excerpt.id), { x: excerpt.x, y: excerpt.y, width: excerpt.width })
            : placeNoteExcerpt({ ...excerpt, dryRun: false })).catch(errorEnvelope);
          if (!result.ok) {
            const created = typeof result.error.details?.excerptId === "string";
            return { ok: false, error: { ...result.error, details: {
              ...result.error.details,
              note: excerpt.note,
              layout: landed,
              excerpts: placed,
              hint: created
                ? `${String(result.error.details?.hint)}. The layout landed. Place the remaining Excerpts with \`enso excerpt create --note\``
                : "The layout landed. Place this and the remaining Excerpts with `enso excerpt create --note`"
            } } };
          }
          placed.push({ ...excerpt, id: (result.data as { excerpt?: { id?: unknown } } | undefined)?.excerpt?.id });
        }
        return { ok: true, data: { ...landed, ...reused, excerpts: placed } };
      }
      return { ok: true, data: { ...summary(spec.canvas, spec.direction, patch), warnings, crossings, patch, excerpts } };
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

type OnCanvas = {
  excerptId: (note: string, text: string) => string | undefined;
  markId: (text: string, note: string | undefined) => string | undefined;
};

/**
 * The Excerpts and typed Marks a target Canvas holds, matched by text. A member's Excerpt
 * also matches the member's Node, a member's Mark its connection to that Node, and a
 * canvas Mark a Mark connected to nothing.
 */
function annotationsOnCanvas(context: unknown): OnCanvas {
  const data = contextObject(context);
  const nodes = data ? readArray(data, "nodes") : [];
  const excerpts = data ? readArray(data, "excerpts") : [];
  const marks = data ? readArray(data, "marks").filter((mark) => mark.kind !== "strokes") : [];
  const nodeId = (note: string): string | undefined => {
    const node = nodes.find((item) => noteMatches({ id: item.id as string, title: item.title as string, ref: (item.ref as string | undefined) ?? undefined }, note));
    return typeof node?.id === "string" ? node.id : undefined;
  };
  const same = (a: unknown, b: string): boolean => typeof a === "string" && a.trim() === b.trim();
  const connected = (item: Record<string, unknown>): string[] => Array.isArray(item.connectedNodeIDs) ? item.connectedNodeIDs.map(String) : [];
  return {
    excerptId(note, text) {
      const node = nodeId(note);
      const match = node === undefined ? undefined : excerpts.find((item) => same(item.text, text) && item.linkedNodeID === node);
      return typeof match?.id === "string" ? match.id : undefined;
    },
    markId(text, note) {
      const node = note === undefined ? undefined : nodeId(note);
      if (note !== undefined && node === undefined) return undefined;
      const match = marks.find((item) => same(item.text, text) && (node === undefined ? connected(item).length === 0 : connected(item).includes(node)));
      return typeof match?.id === "string" ? match.id : undefined;
    }
  };
}

/** Mark creates the Canvas already answers become position updates of those Marks. */
function reuseMarks(intent: CanvasIntent, onCanvas: OnCanvas): { intent: CanvasIntent; markIds: string[] } {
  const markIds: string[] = [];
  const marks = intent.marks.map((mark) => {
    if (mark.mode !== "create") return mark;
    const id = onCanvas.markId(mark.text, mark.connect?.[0]);
    if (id === undefined) return mark;
    markIds.push(id);
    return { mode: "update" as const, id, x: mark.x, y: mark.y, ...(mark.width === undefined ? {} : { width: mark.width }) };
  });
  return { intent: { ...intent, marks }, markIds };
}

async function vaultPath(): Promise<string> {
  const vault = await new BridgeClient().request("/v1/vault/current");
  if (!vault.ok) throw new EnsoCliError(vault.error.code, vault.error.message, vault.error.details ?? {});
  return (vault.data as { path: string }).path;
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
    expected: "enso layout <graph.json> [--apply [--dry-run]], or enso layout --schema",
    hint: "Run `enso layout --help` for the flag list"
  });
}

const RELAYOUT_CODES = new Set(["title_collision", "already_on_canvas"]);

/**
 * Layout compiles a Canvas once. This folds the preflight title collision and the app's
 * already_on_canvas into one error that names the re-layout ticket.
 */
function relayoutError(error: unknown, placement: ReturnType<typeof placementReport>): EnsoCliError | undefined {
  const code = error instanceof EnsoCliError
    ? error.body.code
    : typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  if (code === undefined || !RELAYOUT_CODES.has(code)) return undefined;
  return new EnsoCliError("canvas_already_laid_out", "The target Canvas already contains members of this spec", {
    path: "canvas",
    placement,
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

function summary(canvas: string, direction: string, patch: { nodes: unknown[]; links: unknown[]; primitives: unknown[]; marks: unknown[] }): Record<string, unknown> {
  return {
    canvas,
    direction,
    compiled: { nodes: patch.nodes.length, links: patch.links.length, regions: patch.primitives.length, ...(patch.marks.length > 0 ? { marks: patch.marks.length } : {}) }
  };
}
