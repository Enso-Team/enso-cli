import { z } from "zod";
import { EnsoCliError } from "./errors.js";
import { VISUAL_COLOR_GRAMMAR, linkDirectionSchema, validateLinkEndpointMove, visualColorSchema, worldPointSchema } from "./link-model.js";

const finite = z.number().finite();
const positiveFinite = finite.positive();
const safeString = z.string().min(1).superRefine((value, ctx) => {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "control characters are not allowed" });
  }
});
export const safeTitle = safeString.superRefine((value, ctx) => {
  if (/[/:?#]/.test(value) || /%[0-9a-fA-F]{2}/.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "titles cannot contain /, :, ?, #, or pre-encoded path fragments" });
  }
});
const selector = safeString;
const coordinates = { x: finite, y: finite };
const optionalCoordinates = { x: finite.optional(), y: finite.optional() };

function pairedCoordinates(value: { x?: number; y?: number }, ctx: z.RefinementCtx): void {
  if ((value.x === undefined) !== (value.y === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [value.x === undefined ? "x" : "y"], message: "x and y must be supplied together" });
  }
}

const noteCreate = z.object({ kind: z.literal("note"), mode: z.literal("create"), title: safeTitle, content: z.string().optional(), ...coordinates }).strict();
const noteReuse = z.object({ kind: z.literal("note"), mode: z.literal("reuse"), selector, ...coordinates }).strict();
const noteUpdate = z.object({ kind: z.literal("note"), mode: z.literal("update"), selector, content: z.string().optional(), ...optionalCoordinates }).strict().superRefine((value, ctx) => {
  pairedCoordinates(value, ctx);
  if (value.content === undefined && value.x === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "note update requires content or x and y" });
});
const noteRemove = z.object({ kind: z.literal("note"), mode: z.literal("remove"), selector }).strict();
const portalCreate = z.object({ kind: z.literal("portal"), mode: z.literal("create"), title: safeTitle, subcanvasRef: safeString, ...coordinates }).strict();
const portalUpdate = z.object({ kind: z.literal("portal"), mode: z.literal("update"), selector, subcanvasRef: safeString.optional(), ...optionalCoordinates }).strict().superRefine((value, ctx) => {
  pairedCoordinates(value, ctx);
  if (value.subcanvasRef === undefined && value.x === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "portal update requires subcanvasRef or x and y" });
});
const portalRemove = z.object({ kind: z.literal("portal"), mode: z.literal("remove"), selector }).strict();
const intentNode = z.union([noteCreate, noteReuse, noteUpdate, noteRemove, portalCreate, portalUpdate, portalRemove]);

const linkVisual = { label: z.string().nullable().optional(), color: visualColorSchema.nullable().optional(), direction: linkDirectionSchema.optional() };
const linkCreate = z.object({ mode: z.literal("create"), source: selector, target: selector, ...linkVisual }).strict();
const linkUpdate = z.object({ mode: z.literal("update"), id: z.string().uuid(), ...linkVisual, boundLine: z.string().optional(), syncProse: z.boolean().optional(), source: selector.optional(), target: selector.nullable().optional(), targetPosition: worldPointSchema.optional() }).strict().superRefine((value, ctx) => {
  try {
    validateLinkEndpointMove(value);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "invalid link endpoint move" });
  }
});
const linkRemove = z.object({ mode: z.literal("remove"), id: z.string().uuid(), fromNote: z.boolean().optional() }).strict();
const intentLink = z.union([linkCreate, linkUpdate, linkRemove]);

const primitiveVisual = { title: z.string().nullable().optional(), color: visualColorSchema.nullable().optional(), lineStyle: z.enum(["solid", "dashed", "dotted"]).optional(), strokeWidth: positiveFinite.optional() };
const primitiveKinds = ["region", "line"] as const;
const primitiveKindSchema = z.enum(primitiveKinds);
const regionCreate = z.object({ kind: z.literal("region"), mode: z.literal("create"), ...coordinates, width: positiveFinite, height: positiveFinite, fillOpacity: finite.min(0).max(0.18).optional(), ...primitiveVisual }).strict();
const lineCreate = z.object({ kind: z.literal("line"), mode: z.literal("create"), x1: finite, y1: finite, x2: finite, y2: finite, ...primitiveVisual }).strict();
const primitiveUpdate = z.object({ kind: primitiveKindSchema, mode: z.literal("update"), id: z.string().uuid(), ...optionalCoordinates, x1: finite.optional(), y1: finite.optional(), x2: finite.optional(), y2: finite.optional(), width: positiveFinite.optional(), height: positiveFinite.optional(), fillOpacity: finite.min(0).max(0.18).optional(), ...primitiveVisual }).strict();
const primitiveRemove = z.object({ kind: primitiveKindSchema, mode: z.literal("remove"), id: z.string().uuid() }).strict();
const intentPrimitive = z.union([regionCreate, lineCreate, primitiveUpdate, primitiveRemove]);

export const canvasIntentSchema = z.object({
  canvas: safeString,
  nodes: z.array(intentNode).default([]),
  links: z.array(intentLink).default([]),
  primitives: z.array(intentPrimitive).default([])
}).strict().superRefine((intent, ctx) => {
  const declaredTitles = intent.nodes.flatMap((node) => "title" in node && typeof node.title === "string" ? [node.title] : []);
  addDuplicates(ctx, "nodes", declaredTitles);
  const linkPairs = intent.links.flatMap((link) => link.mode === "create"
    ? [[link.source, link.target].sort((a, b) => a.localeCompare(b)).join("\u0000")]
    : []);
  addDuplicates(ctx, "links", linkPairs);
  addDuplicates(ctx, "links", intent.links.flatMap((link) => link.mode !== "create" ? [link.id] : []));
  addDuplicates(ctx, "primitives", intent.primitives.flatMap((primitive) => primitive.mode !== "create" ? [primitive.id] : []));
  const nodeTargets = intent.nodes.flatMap((node) => "selector" in node ? [node.selector] : []);
  addDuplicates(ctx, "nodes", nodeTargets);
});

function addDuplicates(ctx: z.RefinementCtx, path: string, values: string[]): void {
  const seen = new Set<string>();
  const duplicate = values.find((value) => seen.has(value) || !seen.add(value));
  if (duplicate !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `Conflicting ${path} declarations target ${duplicate.replace("\u0000", " ↔ ")}` });
}

export type CanvasIntent = z.infer<typeof canvasIntentSchema>;
export type CanvasPhaseName = "linkRemovals" | "nodePortalRemovals" | "nodePortalWrites" | "linkWrites" | "primitives";
export type CanvasPhase = { name: CanvasPhaseName; operations: Record<string, unknown>[]; retrySections: string[] };
export type CompiledCanvasApply = { phases: CanvasPhase[]; verification: { nodes: string[]; links: string[]; primitives: string[] } };

type ContextNode = { id?: string; kind?: string; title?: string; displayTitle?: string; ref?: string; content?: string; position?: { x?: number; y?: number } };
type ContextLink = { id?: string; sourceNodeID?: string; targetNodeID?: string; label?: string | null; color?: string | null; direction?: string };
type ContextPrimitive = { id?: string; kind?: string };

export function compileCanvasApply(intent: CanvasIntent, context: unknown): CompiledCanvasApply {
  const nodes = readArray<ContextNode>(context, "nodes");
  const links = readArray<ContextLink>(context, "links");
  const primitives = readArray<ContextPrimitive>(context, "diagramPrimitives");
  const availableNotes = readArray<string>(context, "availableNotes");
  const declaredTitles = intent.nodes.flatMap((node) => "title" in node && typeof node.title === "string" ? [node.title] : []);

  // Reuse places a vault Note in the node phase, ahead of the link phase, so its selector
  // is a valid Link endpoint even though the Canvas does not hold it yet.
  const placedByReuse: string[] = [];

  for (const node of intent.nodes) {
    if (node.mode === "reuse") {
      const canvasMatches = matches(nodes, node.selector);
      const vaultMatches = availableNotes.filter((candidate) => candidate === node.selector);
      if (canvasMatches.length + vaultMatches.length === 0) fail("missing_selector", `No Note matches '${node.selector}'`, `nodes.${node.selector}`, "Use the exact Note name or ref");
      if (canvasMatches.length > 1 || vaultMatches.length > 1) fail("ambiguous_selector", `Multiple Notes match '${node.selector}'`, `nodes.${node.selector}`, "Use the exact unique Note name or ref");
      if (canvasMatches.length === 0) placedByReuse.push(node.selector);
    } else if ("selector" in node) {
      resolveOne(nodes, node.selector, "node");
    }
    if (node.mode === "create" && matches(nodes, node.title).length > 0) {
      const existing = resolveOne(nodes, node.title, "node");
      const identicalNote = node.kind === "note" && existing.kind !== "portal" && existing.content === (node.content ?? "")
        && existing.position?.x === node.x && existing.position?.y === node.y;
      if (!identicalNote) fail("title_collision", `A Canvas element already uses the title '${node.title}'`, `nodes.${node.title}`, "Choose a distinct title or use update/reuse explicitly");
    } else if (node.mode === "create" && node.kind === "note" && availableNotes.includes(node.title)) {
      throw new EnsoCliError("note_exists", `Note '${node.title}' already exists in the vault`, {
        path: `nodes.${node.title}`,
        expected: "a Note title that is new to the vault",
        hint: 'Use mode "reuse" with the existing Note selector, or choose a unique title'
      });
    }
  }
  const declaredEndpoints = [...declaredTitles, ...placedByReuse];
  for (const link of intent.links) {
    if (link.mode === "create") {
      resolveEndpoint(link.source, nodes, declaredEndpoints);
      resolveEndpoint(link.target, nodes, declaredEndpoints);
      const source = matches(nodes, link.source)[0]?.id;
      const target = matches(nodes, link.target)[0]?.id;
      const existing = source && target ? links.find((candidate) => unorderedPair(candidate.sourceNodeID, candidate.targetNodeID) === unorderedPair(source, target)) : undefined;
      if (existing) {
        const same = existing.label === (link.label ?? existing.label) && existing.color === (link.color ?? existing.color) && existing.direction === (link.direction ?? existing.direction);
        if (!same) fail("link_conflict", "A Link already exists for this unordered endpoint pair with different state", "links", "Update the existing Link by id");
      }
    } else {
      resolveId(links, link.id, "Link");
      // A moved endpoint lands on a Node that exists or is created in this intent.
      if (link.mode === "update") {
        if (link.source !== undefined) resolveEndpoint(link.source, nodes, declaredTitles);
        if (typeof link.target === "string") resolveEndpoint(link.target, nodes, declaredTitles);
      }
    }
  }
  for (const primitive of intent.primitives) if (primitive.mode !== "create") resolveId(primitives, primitive.id, "DiagramPrimitive");

  const linkRemovals = intent.links.flatMap((link) => link.mode === "remove" ? [{ type: "link.delete", id: link.id, fromNote: link.fromNote ?? false }] : []);
  const nodePortalRemovals = intent.nodes.flatMap((node) => node.mode === "remove" ? [{ type: "node.delete", selector: node.selector }] : []);
  const nodePortalWrites = intent.nodes.flatMap((node) => nodeWriteOperations(node, nodes));
  const linkWrites: Record<string, unknown>[] = [];
  for (const link of intent.links) {
    if (link.mode === "create" && !matchingExistingLink(link, nodes, links)) {
      linkWrites.push({ type: "link.create", source: link.source, target: link.target, ...defined(linkVisualValues(link)) });
    }
    if (link.mode === "update") linkWrites.push({ type: "link.update", id: link.id, ...defined(linkVisualValues(link)), ...defined({ boundLine: link.boundLine, syncProse: link.syncProse, source: link.source, target: link.target, targetPosition: link.targetPosition }) });
  }
  const primitiveOps = intent.primitives.map((primitive) => primitiveOperation(primitive));
  const phases: CanvasPhase[] = [
    { name: "linkRemovals", operations: linkRemovals, retrySections: ["links.remove"] },
    { name: "nodePortalRemovals", operations: nodePortalRemovals, retrySections: ["nodes.remove"] },
    { name: "nodePortalWrites", operations: nodePortalWrites, retrySections: ["nodes.create", "nodes.reuse", "nodes.update"] },
    { name: "linkWrites", operations: linkWrites, retrySections: ["links.create", "links.update"] },
    { name: "primitives", operations: primitiveOps, retrySections: ["primitives"] }
  ].filter((phase) => phase.operations.length > 0) as CanvasPhase[];
  return {
    phases,
    verification: {
      nodes: intent.nodes.map(nodeTarget),
      links: intent.links.map((link) => link.mode === "create" ? `${link.source}↔${link.target}` : link.id),
      primitives: intent.primitives.flatMap((primitive) => primitive.mode === "create" ? [] : [primitive.id])
    }
  };
}

function matchingExistingLink(
  link: Extract<CanvasIntent["links"][number], { mode: "create" }>,
  nodes: ContextNode[],
  links: ContextLink[]
): ContextLink | undefined {
  const source = matches(nodes, link.source)[0]?.id;
  const target = matches(nodes, link.target)[0]?.id;
  return source && target
    ? links.find((candidate) => unorderedPair(candidate.sourceNodeID, candidate.targetNodeID) === unorderedPair(source, target))
    : undefined;
}

export function verifyCanvasIntent(intent: CanvasIntent, context: unknown): { ok: boolean; mismatches: string[] } {
  const nodes = readArray<ContextNode>(context, "nodes");
  const links = readArray<ContextLink>(context, "links");
  const primitives = readArray<ContextPrimitive>(context, "diagramPrimitives");
  const mismatches: string[] = [];
  for (const node of intent.nodes) {
    const target = nodeTarget(node);
    const exists = matches(nodes, target).length === 1;
    if (node.mode === "remove" ? exists : !exists) mismatches.push(`nodes:${target}`);
  }
  for (const link of intent.links) {
    if (link.mode === "create") {
      const source = matches(nodes, link.source)[0]?.id;
      const target = matches(nodes, link.target)[0]?.id;
      if (!source || !target || !links.some((item) => unorderedPair(item.sourceNodeID, item.targetNodeID) === unorderedPair(source, target))) {
        mismatches.push(`links:${link.source}↔${link.target}`);
      }
    } else {
      const exists = links.some((item) => item.id === link.id);
      if (link.mode === "remove" ? exists : !exists) mismatches.push(`links:${link.id}`);
    }
  }
  for (const primitive of intent.primitives) {
    if (primitive.mode === "create") continue;
    const exists = primitives.some((item) => item.id === primitive.id);
    if (primitive.mode === "remove" ? exists : !exists) mismatches.push(`primitives:${primitive.id}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

function nodeTarget(node: CanvasIntent["nodes"][number]): string {
  if (node.mode === "create") return node.title;
  if (node.mode === "reuse" || node.mode === "remove" || node.mode === "update") return node.selector;
  return "";
}

function nodeWriteOperations(node: CanvasIntent["nodes"][number], nodes: ContextNode[]): Record<string, unknown>[] {
  if (node.mode === "remove") return [];
  if (node.mode === "create") {
    if (matches(nodes, node.title).length > 0) return [];
    return node.kind === "note"
      ? [{ type: "node.create", title: node.title, content: node.content ?? "", x: node.x, y: node.y }]
      : [{ type: "portal.create", title: node.title, subcanvasRef: node.subcanvasRef, x: node.x, y: node.y }];
  }
  if (node.mode === "reuse") return [{ type: "node.create", title: node.selector, placeExisting: true, x: node.x, y: node.y }];
  const operations: Record<string, unknown>[] = [];
  if (node.kind === "note" && node.content !== undefined) operations.push({ type: "node.write", selector: node.selector, content: node.content });
  if (node.kind === "portal" && node.subcanvasRef !== undefined) operations.push({ type: "portal.changeSubcanvas", selector: node.selector, subcanvasRef: node.subcanvasRef });
  if (node.x !== undefined && node.y !== undefined) {
    const existing = matches(nodes, node.selector)[0];
    if (existing?.position?.x !== node.x || existing.position.y !== node.y) {
      operations.push({ type: "node.move", selector: node.selector, x: node.x, y: node.y });
    }
  }
  return operations;
}

function primitiveOperation(primitive: CanvasIntent["primitives"][number]): Record<string, unknown> {
  if (primitive.mode === "remove") return { type: "diagramPrimitive.delete", id: primitive.id };
  if (primitive.mode === "update") {
    const { kind: _kind, mode: _mode, id, ...fields } = primitive;
    return { type: "diagramPrimitive.update", id, ...defined(fields) };
  }
  const type = primitive.kind === "region" ? "group.create" : "line.create";
  const { kind: _kind, mode: _mode, ...fields } = primitive;
  return { type, ...defined(fields) };
}

function linkVisualValues(link: { label?: string | null; color?: string | null; direction?: string }): Record<string, unknown> {
  return { label: link.label, color: link.color, direction: link.direction };
}
function readArray<T>(context: unknown, key: string): T[] {
  if (!context || typeof context !== "object") return [];
  const value = (context as Record<string, unknown>)[key];
  return Array.isArray(value) ? value as T[] : [];
}
function matches(nodes: ContextNode[], value: string): ContextNode[] {
  return nodes.filter((node) => [node.id, node.title, node.displayTitle, node.ref].includes(value));
}
function resolveOne(nodes: ContextNode[], value: string, noun: string): ContextNode {
  const found = matches(nodes, value);
  if (found.length === 0) fail("missing_selector", `No ${noun} matches '${value}'`, value, "Use an exact title, ref, or app UUID");
  if (found.length > 1) fail("ambiguous_selector", `Multiple ${noun}s match '${value}'`, value, "Use an app UUID or a unique selector");
  return found[0];
}
function resolveEndpoint(value: string, nodes: ContextNode[], declared: string[]): void {
  const count = matches(nodes, value).length + declared.filter((title) => title === value).length;
  if (count === 0) fail("missing_selector", `No Link endpoint matches '${value}'`, "links", "Declare the endpoint or use an exact existing selector");
  if (count > 1) fail("ambiguous_selector", `Link endpoint '${value}' is ambiguous`, "links", "Choose a distinct title or app UUID");
}
function resolveId(items: Array<{ id?: string }>, id: string, noun: string): void {
  if (!items.some((item) => item.id === id)) fail("missing_selector", `${noun} id '${id}' does not exist on the target Canvas`, id, "Inspect the target Canvas and use its app UUID");
}
function unorderedPair(a?: string, b?: string): string { return [a ?? "", b ?? ""].sort().join("\u0000"); }
function defined<T extends Record<string, unknown>>(value: T): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function fail(code: string, message: string, path: string, hint: string): never { throw new EnsoCliError(code, message, { path, expected: "one unambiguous declaration", hint }); }

export const canvasApplyContract = {
  transports: ["file", "--json <literal>", "--json -"],
  input: {
    type: "object",
    required: ["canvas"],
    canvas: "Canvas name or current",
    unknownFields: "rejected",
    color: VISUAL_COLOR_GRAMMAR,
    nodes: {
      note: {
        create: { identity: "title", required: ["kind", "mode", "title", "x", "y"], optional: ["content"] },
        reuse: { identity: "selector", required: ["kind", "mode", "selector", "x", "y"], forbidden: ["content"] },
        update: { identity: "selector", required: ["kind", "mode", "selector"], optional: ["content", "x", "y"] },
        remove: { identity: "selector", required: ["kind", "mode", "selector"] }
      },
      portal: {
        create: { identity: "title", required: ["kind", "mode", "title", "subcanvasRef", "x", "y"] },
        update: { identity: "selector", required: ["kind", "mode", "selector"], optional: ["subcanvasRef", "x", "y"] },
        remove: { identity: "selector", required: ["kind", "mode", "selector"] }
      }
    },
    links: {
      direction: ["directed", "undirected", "bidirectional"],
      create: { identity: "unordered source/target pair", required: ["mode", "source", "target"], optional: ["label", "color", "direction"] },
      update: { identity: "app Link UUID", required: ["mode", "id"], optional: ["label", "color", "direction", "boundLine", "syncProse"] },
      remove: { identity: "app Link UUID", required: ["mode", "id"], preservesRelationProse: true }
    },
    primitives: {
      kinds: primitiveKinds,
      create: {
        identity: "app-returned UUID",
        commonOptional: ["title", "color", "lineStyle", "strokeWidth"],
        geometry: {
          region: { required: ["x", "y", "width", "height"], optional: ["fillOpacity"] },
          line: { required: ["x1", "y1", "x2", "y2"] }
        }
      },
      update: { identity: "app DiagramPrimitive UUID", required: ["kind", "mode", "id"] },
      remove: { identity: "app DiagramPrimitive UUID", required: ["kind", "mode", "id"] }
    }
  },
  validation: { local: "complete", vaultNoteTitles: "create-mode Note titles are resolved against vault search and rejected as note_exists when taken", bridgeValidated: "first nonempty phase for current-Canvas dry-run", deferredUntilApply: "later phases, or every phase for a named-Canvas dry-run" },
  partialApplication: { atomicity: "per-phase", rollback: false, phases: ["linkRemovals", "nodePortalRemovals", "nodePortalWrites", "linkWrites", "primitives"] },
  success: { ok: true, data: { appliedBatches: [], results: [], verification: "targeted" } },
  error: { ok: false, error: { code: "string", message: "string", details: {} } },
  example: { canvas: "current", nodes: [{ kind: "note", mode: "create", title: "Service", content: "# Service", x: 0, y: 0 }] }
} as const;

export function parseCanvasIntent(input: unknown): CanvasIntent {
  const parsed = canvasIntentSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new EnsoCliError("invalid_input", issue?.message ?? "Canvas intent is invalid", {
    path: issue?.path.join(".") || "intent",
    expected: issue?.code === "unrecognized_keys" ? "only documented fields" : "canvas apply schema",
    hint: "Run `enso canvas apply --schema` for the machine-readable contract"
  });
}
