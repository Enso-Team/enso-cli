import { Command } from "commander";
import { readFileSync } from "node:fs";
import { canvasIntentSchema, compileCanvasApply } from "../canvas-intent.js";
import { BridgeClient } from "../client.js";
import { type EnsoEnvelope } from "../errors.js";

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
    .argument("<file.json>", "canvas mutation spec: nodes, links, regions, dividers, lines")
    .option("--dry-run", "validate and return the compiled plan without mutating")
    .description("Apply a canvas mutation in one batch: nodes/portals, then links, then DiagramPrimitives")
    .action(async (intentPath: string, options: { dryRun?: boolean }): Promise<EnsoEnvelope> => {
      const intent = canvasIntentSchema.parse(JSON.parse(readFileSync(intentPath, "utf8")));
      const client = new BridgeClient();
      // depth: 1 matches the `context` command default. depth controls node-graph neighbor traversal, not
      // which elements the canvas returns — dedup reads the canvas's own flat nodes/links/primitives arrays.
      const context = await client.request("/v1/context", { method: "POST", body: { canvas: intent.canvas ?? "current", depth: 1 } });
      if (!context.ok) return context;

      // The bridge returns the canvas elements as flat arrays on data (data.nodes/links/diagramPrimitives);
      // data.canvas.* holds integer counts, not the arrays. compileCanvasApply reads the flat arrays.
      const compiled = compileCanvasApply(intent, context.data);
      const dryRun = Boolean(options.dryRun);

      // /v1/apply targets whatever canvas is open. When the intent names a specific canvas, open it
      // first on a real apply so operations don't silently land on the wrong canvas. (Dry-run mutates
      // nothing, so it stays side-effect-free.)
      if (!dryRun && intent.canvas && intent.canvas !== "current") {
        const opened = await client.request(`/v1/canvases/${encodeURIComponent(intent.canvas)}/open`, { method: "POST", body: { dryRun: false }, dryRun: false });
        if (!opened.ok) return opened;
      }

      const patches = [
        { name: "nodes", key: "nodeOps", operations: compiled.nodeOps },
        { name: "links", key: "linkOps", operations: compiled.linkOps },
        { name: "primitives", key: "primitiveOps", operations: compiled.primitiveOps }
      ].filter((patch) => patch.operations.length > 0);

      if (patches.length === 0) {
        return {
          ok: true,
          data: dryRun
            ? { dryRun: true, valid: true, validatedBatches: [], unvalidatedBatches: [], planned: { nodeOps: 0, linkOps: 0, primitiveOps: 0 }, placements: compiled.placements, patches: [] }
            : { applied: { nodeOps: 0, linkOps: 0, primitiveOps: 0 }, placements: compiled.placements }
        };
      }

      const first = patches[0];
      const firstResult = await client.request("/v1/apply", {
        method: "POST",
        body: { operations: first.operations, dryRun },
        dryRun
      });
      if (!firstResult.ok) return firstResult;

      if (dryRun) {
        // Only the first batch is bridge-validated; later batches reference node IDs that don't exist yet.
        // Forward the bridge's own verdict so a semantic rejection (valid: false) isn't masked.
        const firstValid = (firstResult.data as { valid?: boolean } | undefined)?.valid ?? true;
        return {
          ok: true,
          data: {
            dryRun: true,
            valid: firstValid,
            validatedBatches: [first.name],
            unvalidatedBatches: patches.slice(1).map((patch) => patch.name),
            planned: {
              nodeOps: compiled.nodeOps.length,
              linkOps: compiled.linkOps.length,
              primitiveOps: compiled.primitiveOps.length
            },
            placements: compiled.placements,
            patches: patches.map((patch) => ({ name: patch.name, operations: patch.operations }))
          }
        };
      }

      // Batches are not transactional: a later failure leaves earlier batches committed, so track
      // what landed (keyed like the success envelope) to report the partial state on error.
      const applied: Record<string, number> = { nodeOps: 0, linkOps: 0, primitiveOps: 0 };
      applied[first.key] = first.operations.length;
      for (const patch of patches.slice(1)) {
        const result = await client.request("/v1/apply", {
          method: "POST",
          body: { operations: patch.operations, dryRun: false },
          dryRun: false
        });
        if (!result.ok) {
          return {
            ...result,
            error: {
              ...result.error,
              details: { ...result.error.details, partialApply: { failedBatch: patch.name, applied } }
            }
          };
        }
        applied[patch.key] = patch.operations.length;
      }

      return {
        ok: true,
        data: {
          applied: {
            nodeOps: compiled.nodeOps.length,
            linkOps: compiled.linkOps.length,
            primitiveOps: compiled.primitiveOps.length
          },
          placements: compiled.placements
        }
      };
    });
}
