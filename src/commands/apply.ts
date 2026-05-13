import { readFileSync } from "node:fs";
import { Command } from "commander";
import { z } from "zod";
import { BridgeClient } from "../client.js";

const linkDirectionSchema = z.enum(["directed", "undirected", "bidirectional"]);
const lineStyleSchema = z.enum(["solid", "dashed", "dotted"]);
const dividerOrientationSchema = z.enum(["horizontal", "vertical"]);

const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("node.create"), title: z.string(), content: z.string().optional(), canvas: z.string().optional() }),
  z.object({ type: z.literal("node.write"), selector: z.string(), content: z.string() }),
  z.object({ type: z.literal("node.move"), selector: z.string(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("node.delete"), selector: z.string() }),
  z.object({ type: z.literal("portal.create"), title: z.string(), subcanvasRef: z.string(), canvas: z.string().optional() }),
  z.object({ type: z.literal("portal.open"), selector: z.string() }),
  z.object({ type: z.literal("portal.changeSubcanvas"), selector: z.string(), subcanvasRef: z.string() }),
  z.object({ type: z.literal("portal.delete"), selector: z.string() }),
  z.object({ type: z.literal("canvas.create"), name: z.string() }),
  z.object({ type: z.literal("canvas.open"), selector: z.string() }),
  z.object({
    type: z.literal("link.create"),
    source: z.string(),
    target: z.string(),
    label: z.string().optional(),
    color: z.string().optional(),
    direction: linkDirectionSchema.optional()
  }),
  z.object({
    type: z.literal("link.update"),
    id: z.string(),
    label: z.string().optional(),
    color: z.string().optional(),
    direction: linkDirectionSchema.optional()
  }),
  z.object({ type: z.literal("link.delete"), id: z.string() }),
  z.object({
    type: z.literal("line.create"),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    title: z.string().optional(),
    color: z.string().optional(),
    lineStyle: lineStyleSchema.optional(),
    strokeWidth: z.number().positive().optional()
  }),
  z.object({
    type: z.literal("divider.create"),
    orientation: dividerOrientationSchema,
    x: z.number(),
    y: z.number(),
    length: z.number().positive(),
    title: z.string().optional(),
    color: z.string().optional(),
    lineStyle: lineStyleSchema.optional(),
    strokeWidth: z.number().positive().optional()
  }),
  z.object({
    type: z.literal("group.create"),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    title: z.string().optional(),
    color: z.string().optional(),
    lineStyle: lineStyleSchema.optional(),
    strokeWidth: z.number().positive().optional(),
    fillOpacity: z.number().min(0).max(0.18).optional()
  }),
  z.object({
    type: z.literal("diagramPrimitive.update"),
    id: z.string(),
    title: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    x1: z.number().optional(),
    y1: z.number().optional(),
    x2: z.number().optional(),
    y2: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    length: z.number().positive().optional(),
    orientation: dividerOrientationSchema.optional(),
    lineStyle: lineStyleSchema.optional(),
    strokeWidth: z.number().positive().optional(),
    fillOpacity: z.number().min(0).max(0.18).optional()
  }),
  z.object({ type: z.literal("diagramPrimitive.delete"), id: z.string() }),
  z.object({ type: z.literal("diagramPrimitive.attachSubcanvas"), id: z.string(), subcanvasRef: z.string() }),
  z.object({ type: z.literal("diagramPrimitive.detachSubcanvas"), id: z.string() }),
  z.object({ type: z.literal("diagramPrimitive.createSubcanvas"), id: z.string(), name: z.string() }),
  z.object({ type: z.literal("diagramPrimitive.openSubcanvas"), id: z.string() })
]);

const patchSchema = z.object({
  operations: z.array(operationSchema).min(1)
});

export function registerApply(program: Command): void {
  program
    .command("apply")
    .argument("<patch.json>")
    .option("--dry-run", "validate without mutating")
    .description("Apply a multi-operation Enso patch")
    .action(async (patchPath: string, options: { dryRun?: boolean }) => {
      const patch = patchSchema.parse(JSON.parse(readFileSync(patchPath, "utf8")));
      return new BridgeClient().request("/v1/apply", {
        method: "POST",
        body: { ...patch, dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      });
    });
}
