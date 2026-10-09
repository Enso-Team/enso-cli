import { z } from "zod";
import { nodeAppearanceSchema, nodeGlyphSizeSchema, nodeFontSizeSchema, nodeTitleGapSchema } from "./node-appearance.js";
import { EnsoCliError } from "./errors.js";
import { VISUAL_COLOR_GRAMMAR, labelFontSizeSchema, lineStyleSchema, linkDirectionSchema, validateLinkEndpointMove, visualColorSchema, worldPointSchema } from "./link-model.js";
import { markStyleSchema, markTextRunSchema, markTextSchema, runsOutsideText, type MarkTextRun } from "./mark-model.js";
import { nodeSelector, noteMatches, placementSelector } from "./note-identity.js";

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

// How a Note or Portal Node looks. Every Node schema takes the same fields.
const nodeVisual = { appearance: nodeAppearanceSchema.optional(), glyphSize: nodeGlyphSizeSchema.optional(), fontSize: nodeFontSizeSchema.optional(), titleGap: nodeTitleGapSchema.optional(), isResizeLocked: z.boolean().optional() };
const setsNodeVisual = (value: Record<string, unknown>): boolean => Object.keys(nodeVisual).some((key) => value[key] !== undefined);

// A Node is a placement of a Note. The Note is a markdown file the agent already wrote into
// the Vault, named by its title or its Vault-relative path. The intent carries no content.
const notePlace = z.object({ ...nodeVisual, kind: z.literal("note"), mode: z.literal("place"), note: safeString, ...coordinates }).strict();
const noteUpdate = z.object({ ...nodeVisual, kind: z.literal("note"), mode: z.literal("update"), selector, ...optionalCoordinates }).strict().superRefine((value, ctx) => {
  pairedCoordinates(value, ctx);
  if (!setsNodeVisual(value) && value.x === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "note update requires appearance, glyphSize, fontSize, titleGap, isResizeLocked, or x and y" });
});
const noteRemove = z.object({ kind: z.literal("note"), mode: z.literal("remove"), selector }).strict();
const portalCreate = z.object({ ...nodeVisual, kind: z.literal("portal"), mode: z.literal("create"), title: safeTitle, subcanvasRef: safeString, ...coordinates }).strict();
const portalUpdate = z.object({ ...nodeVisual, kind: z.literal("portal"), mode: z.literal("update"), selector, subcanvasRef: safeString.optional(), ...optionalCoordinates }).strict().superRefine((value, ctx) => {
  pairedCoordinates(value, ctx);
  if (!setsNodeVisual(value) && value.subcanvasRef === undefined && value.x === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "portal update requires appearance, glyphSize, fontSize, titleGap, isResizeLocked, subcanvasRef, or x and y" });
});
const portalRemove = z.object({ kind: z.literal("portal"), mode: z.literal("remove"), selector }).strict();
const intentNode = z.union([notePlace, noteUpdate, noteRemove, portalCreate, portalUpdate, portalRemove]);

const linkVisual = { label: z.string().nullable().optional(), color: visualColorSchema.nullable().optional(), direction: linkDirectionSchema.optional(), lineStyle: lineStyleSchema.optional(), labelFontSize: labelFontSizeSchema.optional() };
const linkCreate = z.object({ mode: z.literal("create"), source: selector, target: selector, ...linkVisual }).strict();
const linkUpdate = z.object({ mode: z.literal("update"), id: z.string().uuid(), ...linkVisual, source: selector.optional(), target: selector.nullable().optional(), targetPosition: worldPointSchema.optional() }).strict().superRefine((value, ctx) => {
  try {
    validateLinkEndpointMove(value);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "invalid link endpoint move" });
  }
});
const linkRemove = z.object({ mode: z.literal("remove"), id: z.string().uuid(), fromNote: z.boolean().optional() }).strict();
const intentLink = z.union([linkCreate, linkUpdate, linkRemove]);

const primitiveVisual = { title: z.string().nullable().optional(), color: visualColorSchema.nullable().optional(), lineStyle: lineStyleSchema.optional(), strokeWidth: positiveFinite.optional() };
const primitiveKinds = ["region", "line"] as const;
const primitiveKindSchema = z.enum(primitiveKinds);
const regionCreate = z.object({ kind: z.literal("region"), mode: z.literal("create"), ...coordinates, width: positiveFinite, height: positiveFinite, fillOpacity: finite.min(0).max(0.18).optional(), ...primitiveVisual }).strict();
const lineCreate = z.object({ kind: z.literal("line"), mode: z.literal("create"), x1: finite, y1: finite, x2: finite, y2: finite, ...primitiveVisual }).strict();
const primitiveUpdate = z.object({ kind: primitiveKindSchema, mode: z.literal("update"), id: z.string().uuid(), ...optionalCoordinates, x1: finite.optional(), y1: finite.optional(), x2: finite.optional(), y2: finite.optional(), width: positiveFinite.optional(), height: positiveFinite.optional(), fillOpacity: finite.min(0).max(0.18).optional(), ...primitiveVisual }).strict();
const primitiveRemove = z.object({ kind: primitiveKindSchema, mode: z.literal("remove"), id: z.string().uuid() }).strict();
const intentPrimitive = z.union([regionCreate, lineCreate, primitiveUpdate, primitiveRemove]);

// A Mark is typed canvas text with a top-left origin. `connect` draws a connection from each
// named Node to the Mark, so the Mark comments on those Nodes.
const markFields = { width: positiveFinite.optional(), textRuns: z.array(markTextRunSchema).optional(), connect: z.array(selector).optional() };
const markCreate = z.object({ mode: z.literal("create"), text: markTextSchema, ...coordinates, ...markFields }).strict().superRefine((value, ctx) => {
  if (value.textRuns && runsOutsideText(value.text, value.textRuns)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["textRuns"], message: "formatting ranges must lie inside the text" });
});
const markUpdate = z.object({ mode: z.literal("update"), id: z.string().uuid(), text: markTextSchema.optional(), ...optionalCoordinates, ...markFields }).strict().superRefine((value, ctx) => {
  pairedCoordinates(value, ctx);
  if (value.text === undefined && value.x === undefined && value.width === undefined && value.textRuns === undefined && !value.connect?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mark update requires text, x and y, width, textRuns, or connect" });
  }
  if (value.text !== undefined && value.textRuns && runsOutsideText(value.text, value.textRuns)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["textRuns"], message: "formatting ranges must lie inside the text" });
});
const markRemove = z.object({ mode: z.literal("remove"), id: z.string().uuid() }).strict();
const intentMark = z.union([markCreate, markUpdate, markRemove]);

export const canvasIntentSchema = z.object({
  canvas: safeString,
  nodes: z.array(intentNode).default([]),
  links: z.array(intentLink).default([]),
  primitives: z.array(intentPrimitive).default([]),
  marks: z.array(intentMark).default([])
}).strict().superRefine((intent, ctx) => {
  addDuplicates(ctx, "nodes", intent.nodes.flatMap((node) => node.mode === "place" ? [node.note] : "title" in node ? [node.title] : []));
  const linkPairs = intent.links.flatMap((link) => link.mode === "create"
    ? [[link.source, link.target].sort((a, b) => a.localeCompare(b)).join("\u0000")]
    : []);
  addDuplicates(ctx, "links", linkPairs);
  addDuplicates(ctx, "links", intent.links.flatMap((link) => link.mode !== "create" ? [link.id] : []));
  addDuplicates(ctx, "primitives", intent.primitives.flatMap((primitive) => primitive.mode !== "create" ? [primitive.id] : []));
  const nodeTargets = intent.nodes.flatMap((node) => "selector" in node ? [node.selector] : []);
  addDuplicates(ctx, "nodes", nodeTargets);
  addDuplicates(ctx, "marks", intent.marks.flatMap((mark) => mark.mode !== "create" ? [mark.id] : []));
});

function addDuplicates(ctx: z.RefinementCtx, path: string, values: string[]): void {
  const seen = new Set<string>();
  const duplicate = values.find((value) => seen.has(value) || !seen.add(value));
  if (duplicate !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `Conflicting ${path} declarations target ${duplicate.replace("\u0000", " ↔ ")}` });
}

export type CanvasIntent = z.infer<typeof canvasIntentSchema>;
export type CanvasPhaseName = "linkRemovals" | "nodePortalRemovals" | "nodePortalWrites" | "linkWrites" | "primitives" | "marks" | "markConnections";
export type CanvasPhase = { name: CanvasPhaseName; operations: Record<string, unknown>[]; retrySections: string[] };
export type CompiledCanvasApply = { phases: CanvasPhase[]; sharedNoteWrites: string[]; verification: { nodes: string[]; links: string[]; primitives: string[]; marks: string[] } };

/**
 * A connection to a Mark this intent creates names it by creation order until the app returns
 * its id. The apply loop binds the placeholder before sending the connection phase.
 */
export const CREATED_MARK_PREFIX = "created:";

type ContextNode = { titleGap?: number; isResizeLocked?: boolean; glyphSize?: number | null; fontSize?: number; appearance?: string; id?: string; kind?: string; title?: string; displayTitle?: string; ref?: string; position?: { x?: number; y?: number } } & Record<string, unknown>;
type ContextLink = { labelFontSize?: number; id?: string; sourceNodeID?: string; targetNodeID?: string | null; label?: string | null; color?: string | null; direction?: string; lineStyle?: string } & Record<string, unknown>;
type ContextMark = { id?: string; kind?: string; text?: string; position?: { x?: number; y?: number }; width?: number; textRuns?: MarkTextRun[]; connectedNodeIDs?: string[] } & Record<string, unknown>;
type ContextPrimitive = { id?: string; kind?: string; position?: { x?: number; y?: number }; bounds?: { x?: number; y?: number; width?: number; height?: number }; start?: { x?: number; y?: number }; end?: { x?: number; y?: number } } & Record<string, unknown>;

export function compileCanvasApply(intent: CanvasIntent, context: unknown): CompiledCanvasApply {
  const nodes = readArray<ContextNode>(context, "nodes");
  const links = readArray<ContextLink>(context, "links");
  const primitives = readArray<ContextPrimitive>(context, "diagramPrimitives");
  const availableNotes = readArray<string>(context, "availableNotes");
  const declaredTitles = intent.nodes.flatMap((node) => node.kind === "portal" && node.mode === "create" ? [node.title] : []);

  // A placed Note is a valid Link endpoint in the same intent even though the Canvas does
  // not hold it yet. The bridge resolves the file from disk, so a Note written a moment ago
  // places without a search round trip; preflight only refuses what it can see is wrong.
  const placed: string[] = [];

  for (const node of intent.nodes) {
    if (node.mode === "place") {
      const canvasMatches = matches(nodes, node.note);
      const vaultMatches = availableNotes.filter(candidate => noteMatches({ ref: candidate }, node.note));
      if (canvasMatches.length > 1 || vaultMatches.length > 1) fail("ambiguous_selector", `Multiple Notes match '${node.note}'`, `nodes.${node.note}`, "Name the Note by its Vault-relative path");
      if (canvasMatches.length === 0) placed.push(node.note);
    } else if ("selector" in node) {
      resolveOne(nodes, node.selector, "node");
    }
    if (node.kind === "portal" && node.mode === "create" && matches(nodes, node.title).length > 0) {
      fail("title_collision", `A Canvas element already uses the title '${node.title}'`, `nodes.${node.title}`, "Choose a distinct title or use update explicitly");
    }
  }
  const declaredEndpoints = [...declaredTitles, ...placed];
  for (const link of intent.links) {
    if (link.mode === "create") {
      resolveEndpoint(link.source, nodes, declaredEndpoints);
      resolveEndpoint(link.target, nodes, declaredEndpoints);
      const source = matches(nodes, link.source)[0]?.id;
      const target = matches(nodes, link.target)[0]?.id;
      const existing = matchingLinks(link, nodes, links)[0];
      if (existing) {
        const mismatches: string[] = [];
        compareRequestedFields(link, existing, Object.keys(linkVisual), "links", mismatches);
        if (!sameId(existing.sourceNodeID, source) || !sameId(existing.targetNodeID, target) || mismatches.length > 0) {
          fail("link_conflict", "A Link already exists for this unordered endpoint pair with different state", "links", "Update the existing Link by id");
        }
      }
    } else {
      if (link.mode === "update" || link.fromNote === true) resolveId(links, link.id, "Link");
      // A moved endpoint lands on a Node that exists or is created in this intent.
      if (link.mode === "update") {
        if (link.source !== undefined) resolveEndpoint(link.source, nodes, declaredEndpoints);
        if (typeof link.target === "string") resolveEndpoint(link.target, nodes, declaredEndpoints);
      }
    }
  }
  for (const primitive of intent.primitives) if (primitive.mode !== "create") resolveId(primitives, primitive.id, "DiagramPrimitive");
  const marks = readArray<ContextMark>(context, "marks");
  const removedNodeIds = intent.nodes.flatMap((node) => node.mode === "remove" ? [resolveOne(nodes, node.selector, "node").id] : []);
  for (const mark of intent.marks) {
    if (mark.mode !== "create") resolveId(marks, mark.id, "Mark");
    if (mark.mode === "update") {
      const existing = marks.find(item => sameId(item.id, mark.id));
      if (existing?.kind === "strokes") {
        fail("invalid_input", `Mark '${mark.id}' is handwriting`, mark.id, "Update typed Marks only. Handwriting belongs to the person who drew it");
      }
      if (mark.text === undefined && mark.textRuns && runsOutsideText(existing?.text ?? "", mark.textRuns)) {
        fail("invalid_input", `Formatting for Mark '${mark.id}' lies outside its text`, mark.id, "Inspect the Mark's text and keep each range inside it");
      }
    }
    for (const node of mark.mode === "remove" ? [] : mark.connect ?? []) {
      resolveEndpoint(node, nodes, declaredEndpoints);
      if (removedNodeIds.some((id) => sameId(id, matches(nodes, node)[0]?.id))) {
        fail("missing_selector", `Mark connection '${node}' targets a Node this intent removes`, "marks", "Connect the Mark to a Node that stays on the Canvas");
      }
    }
  }

  const linkRemovals = intent.links.flatMap((link) => link.mode === "remove" && links.some(existing => sameId(existing.id, link.id)) ? [{ type: "link.delete", id: link.id, fromNote: link.fromNote ?? false }] : []);
  const nodePortalRemovals = intent.nodes.flatMap((node) => node.mode === "remove" ? [{ type: "node.delete", selector: nodeSelector(resolveOne(nodes, node.selector, "node"), node.selector) }] : []);
  const nodePortalWrites = intent.nodes.flatMap((node) => nodeWriteOperations(node, nodes));
  const linkWrites: Record<string, unknown>[] = [];
  for (const link of intent.links) {
    if (link.mode === "create" && matchingLinks(link, nodes, links).length === 0) {
      linkWrites.push({ type: "link.create", source: endpointSelector(link.source, nodes, intent), target: endpointSelector(link.target, nodes, intent), ...defined(linkVisualValues(link)) });
    }
    if (link.mode === "update") linkWrites.push({ type: "link.update", id: link.id, ...defined(linkVisualValues(link)), ...defined({ source: link.source === undefined ? undefined : endpointSelector(link.source, nodes, intent), target: typeof link.target === "string" ? endpointSelector(link.target, nodes, intent) : link.target, targetPosition: link.targetPosition }) });
  }
  const primitiveOps = intent.primitives.map((primitive) => primitiveOperation(primitive));
  const markOps = [
    ...intent.marks.flatMap((mark) => mark.mode === "remove" ? [{ type: "mark.delete", id: mark.id }] : []),
    ...intent.marks.flatMap((mark) => mark.mode === "remove" ? [] : [markWriteOperation(mark)].filter((operation) => operation !== undefined))
  ];
  let created = 0;
  const markConnections = intent.marks.flatMap((mark) => {
    if (mark.mode === "remove") return [];
    const id = mark.mode === "create" ? CREATED_MARK_PREFIX + created++ : mark.id;
    const connected = mark.mode === "update" ? marks.find(item => sameId(item.id, mark.id))?.connectedNodeIDs ?? [] : [];
    return (mark.connect ?? [])
      .filter((node) => !connected.some((nodeId) => sameId(nodeId, matches(nodes, node)[0]?.id)))
      .map((node) => ({ type: "mark.connect", id, node: endpointSelector(node, nodes, intent) }));
  });
  const phases: CanvasPhase[] = [
    { name: "linkRemovals", operations: linkRemovals, retrySections: ["links.remove"] },
    { name: "nodePortalRemovals", operations: nodePortalRemovals, retrySections: ["nodes.remove"] },
    { name: "nodePortalWrites", operations: nodePortalWrites, retrySections: ["nodes.place", "nodes.create", "nodes.update"] },
    { name: "linkWrites", operations: linkWrites, retrySections: ["links.create", "links.update"] },
    { name: "primitives", operations: primitiveOps, retrySections: ["primitives"] },
    { name: "marks", operations: markOps, retrySections: ["marks"] },
    { name: "markConnections", operations: markConnections, retrySections: ["marks.connect"] }
  ].filter((phase) => phase.operations.length > 0) as CanvasPhase[];
  return {
    phases,
    sharedNoteWrites: sharedNoteWriteCandidates(phases, nodes, links),
    verification: {
      nodes: intent.nodes.map(nodeTarget),
      links: intent.links.map((link) => link.mode === "create" ? `${link.source}↔${link.target}` : link.id),
      primitives: intent.primitives.map((primitive, index) => primitive.mode === "create" ? `create:${index}` : primitive.id),
      marks: intent.marks.map((mark, index) => mark.mode === "create" ? `create:${index}` : mark.id)
    }
  };
}

/** Existing Notes whose content may be written by the compiled bridge operations. */
function sharedNoteWriteCandidates(phases: CanvasPhase[], nodes: ContextNode[], links: ContextLink[]): string[] {
  const writes = new Set<string>();
  const add = (selector: unknown): void => {
    const node = typeof selector === "string" ? matches(nodes, selector)[0] : undefined;
    if (node?.kind === "note") writes.add(node.displayTitle ?? node.title ?? node.ref ?? String(selector));
  };
  for (const operation of phases.flatMap(phase => phase.operations)) {
    const link = links.find(candidate => typeof operation.id === "string" && sameId(candidate.id, operation.id));
    // Deleting from the Note removes the mentioning sentence from the source.
    if (operation.type === "link.delete" && operation.fromNote === true) add(link?.sourceNodeID);
    // Moving an endpoint rewrites the mention, and the app saves every Note on either end,
    // before and after.
    const movesEndpoint = operation.source !== undefined || operation.target !== undefined || operation.targetPosition !== undefined;
    if (operation.type === "link.update" && movesEndpoint) {
      for (const endpoint of [link?.sourceNodeID, link?.targetNodeID, operation.source, operation.target]) add(endpoint);
    }
  }
  return [...writes];
}

function matchingLinks(
  link: Extract<CanvasIntent["links"][number], { mode: "create" }>,
  nodes: ContextNode[],
  links: ContextLink[]
): ContextLink[] {
  const source = matches(nodes, link.source);
  const target = matches(nodes, link.target);
  if (source.length !== 1 || target.length !== 1 || !source[0].id || !target[0].id) return [];
  return links.filter(candidate => unorderedPair(candidate.sourceNodeID, candidate.targetNodeID) === unorderedPair(source[0].id, target[0].id));
}

/**
 * Check the inspected Canvas against the intent. The bridge serializes every visual field on
 * every Node and Link, so a requested field that comes back absent means the app did not
 * apply it, and it counts as a mismatch.
 */
export function verifyCanvasIntent(intent: CanvasIntent, context: unknown, results: Record<string, unknown>[] = []): { ok: boolean; mismatches: string[] } {
  const nodes = readArray<ContextNode>(context, "nodes");
  const links = readArray<ContextLink>(context, "links");
  const primitives = readArray<ContextPrimitive>(context, "diagramPrimitives");
  const mismatches: string[] = [];
  for (const node of intent.nodes) {
    const target = nodeTarget(node);
    const found = matches(nodes, target);
    const prefix = "nodes:" + target;
    if (node.mode === "remove") {
      if (found.length > 0) mismatches.push(prefix);
      continue;
    }
    if (found.length !== 1) { mismatches.push(prefix); continue; }
    const actual = found[0];
    compareRequestedFields(node, { ...actual, x: actual.position?.x, y: actual.position?.y },
      ["glyphSize", "titleGap", "isResizeLocked", "fontSize", "appearance", "x", "y", "subcanvasRef"], prefix, mismatches);
  }
  for (const link of intent.links) {
    const prefix = "links:" + (link.mode === "create" ? link.source + "↔" + link.target : link.id);
    const found = link.mode === "create"
      ? matchingLinks(link, nodes, links)
      : links.filter(item => sameId(item.id, link.id));
    if (link.mode === "remove") {
      if (found.length > 0) mismatches.push(prefix);
      continue;
    }
    if (found.length !== 1) { mismatches.push(prefix); continue; }
    const actual = found[0];
    compareRequestedFields(link, actual, Object.keys(linkVisual), prefix, mismatches);
    for (const end of ["source", "target"] as const) {
      const selector = link[end];
      if (selector === undefined) continue;
      const actualId = actual[end === "source" ? "sourceNodeID" : "targetNodeID"];
      if (selector === null) {
        if (actualId !== null) mismatches.push(prefix + ":" + end);
      } else {
        const endpoint = matches(nodes, selector);
        if (endpoint.length !== 1 || !sameId(actualId, endpoint[0].id)) mismatches.push(prefix + ":" + end);
      }
    }
    if (link.mode === "update" && link.targetPosition !== undefined) {
      compareRequestedFields(link.targetPosition, actual.targetPosition as Record<string, unknown> | undefined,
        ["x", "y"], prefix + ":targetPosition", mismatches);
    }
  }
  const createdResults = results.filter(result => result.type === "group.create" || result.type === "line.create");
  let creation = 0;
  for (const [index, primitive] of intent.primitives.entries()) {
    const createdId = primitive.mode === "create" ? createdResults[creation++]?.id : undefined;
    const id = primitive.mode === "create" ? createdId : primitive.id;
    const prefix = "primitives:" + (primitive.mode === "create" ? "create:" + index : primitive.id);
    const found = primitives.filter(item => typeof id === "string" && sameId(item.id, id));
    if (primitive.mode === "remove") {
      if (found.length > 0) mismatches.push(prefix);
      continue;
    }
    if (found.length !== 1) { mismatches.push(prefix); continue; }
    const actual = found[0];
    if (actual.kind !== (primitive.kind === "region" ? "group" : "line")) mismatches.push(prefix + ":kind");
    compareRequestedFields(primitive, {
      ...actual, x: actual.position?.x, y: actual.position?.y,
      width: actual.bounds?.width, height: actual.bounds?.height,
      x1: actual.start?.x, y1: actual.start?.y, x2: actual.end?.x, y2: actual.end?.y
    }, ["x", "y", "width", "height", "x1", "y1", "x2", "y2", ...Object.keys(primitiveVisual), "fillOpacity"], prefix, mismatches);
  }
  verifyMarks(intent, nodes, readArray<ContextMark>(context, "marks"), results, mismatches);
  return { ok: mismatches.length === 0, mismatches };
}

function verifyMarks(intent: CanvasIntent, nodes: ContextNode[], marks: ContextMark[], results: Record<string, unknown>[], mismatches: string[]): void {
  const createdIds = createdMarkIds(results);
  let creation = 0;
  for (const [index, mark] of intent.marks.entries()) {
    const id = mark.mode === "create" ? createdIds[creation++] : mark.id;
    const prefix = "marks:" + (mark.mode === "create" ? "create:" + index : mark.id);
    const found = marks.filter(item => typeof id === "string" && sameId(item.id, id));
    if (mark.mode === "remove") {
      if (found.length > 0) mismatches.push(prefix);
      continue;
    }
    if (found.length !== 1) { mismatches.push(prefix); continue; }
    const actual = found[0];
    compareRequestedFields(mark, { ...actual, x: actual.position?.x, y: actual.position?.y }, ["text", "x", "y", "width"], prefix, mismatches);
    if (mark.textRuns !== undefined && textRunsKey(mark.textRuns) !== textRunsKey(actual.textRuns ?? [])) mismatches.push(prefix + ":textRuns");
    for (const node of mark.connect ?? []) {
      const endpoint = matches(nodes, node);
      if (endpoint.length !== 1 || !(actual.connectedNodeIDs ?? []).some((nodeId) => sameId(nodeId, endpoint[0].id))) mismatches.push(prefix + ":connect:" + node);
    }
  }
}

function textRunsKey(runs: MarkTextRun[]): string {
  return JSON.stringify(runs.map((run) => [run.location, run.length, [...run.styles].sort()]));
}

/**
 * Ids of the Marks an apply created, one slot per creation in the order the intent declared
 * them. A creation the app returned no id for keeps an empty slot.
 */
export function createdMarkIds(results: Record<string, unknown>[]): Array<string | undefined> {
  return results.flatMap((result) => result.type === "mark.create" ? [typeof result.id === "string" ? result.id : undefined] : []);
}

/** Replace created-Mark placeholders with the ids the app returned. */
export function bindCreatedMarks(operations: Record<string, unknown>[], createdIds: Array<string | undefined>): Record<string, unknown>[] {
  return operations.map((operation) => {
    const id = operation.id;
    if (typeof id !== "string" || !id.startsWith(CREATED_MARK_PREFIX)) return operation;
    const bound = createdIds[Number(id.slice(CREATED_MARK_PREFIX.length))];
    if (bound === undefined) fail("operation_failed", "The app returned no id for a created Mark", id, "Inspect the Canvas and connect the Mark by its id");
    return { ...operation, id: bound };
  });
}

function compareRequestedFields(
  requested: Record<string, unknown>,
  actual: Record<string, unknown> | undefined,
  fields: string[],
  prefix: string,
  mismatches: string[]
): void {
  for (const field of fields) {
    const expected = requested[field];
    if (expected === undefined) continue;
    const observed = actual?.[field];
    const equal = typeof expected === "number" && typeof observed === "number"
      ? Math.abs(expected - observed) <= 0.000001
      : field === "color" && typeof expected === "string" && typeof observed === "string"
        ? expected.trim().toLowerCase() === observed.trim().toLowerCase()
        : expected === observed;
    if (!equal) mismatches.push(prefix + ":" + field);
  }
}

function nodeTarget(node: CanvasIntent["nodes"][number]): string {
  if (node.mode === "place") return node.note;
  if (node.mode === "create") return node.title;
  return node.selector;
}

function nodeWriteOperations(node: CanvasIntent["nodes"][number], nodes: ContextNode[]): Record<string, unknown>[] {
  if (node.mode === "remove") return [];
  const appearance = defined({ appearance: node.appearance, glyphSize: node.glyphSize, fontSize: node.fontSize, titleGap: node.titleGap, isResizeLocked: node.isResizeLocked });
  if (node.mode === "create") {
    if (matches(nodes, node.title).length > 0) return [];
    return [{ type: "portal.create", ...appearance, title: node.title, subcanvasRef: node.subcanvasRef, x: node.x, y: node.y }];
  }
  if (node.mode === "place") {
    const existing = matches(nodes, node.note)[0];
    if (!existing) return [{ type: "node.create", ...appearance, title: placementSelector(node.note), placeExisting: true, x: node.x, y: node.y }];
    const selector = nodeSelector(existing, node.note);
    return [
      ...moveIfDisplaced(existing, selector, node.x, node.y),
      ...(Object.keys(appearance).length > 0 ? [{ type: "node.update", selector, ...appearance }] : [])
    ];
  }
  const operations: Record<string, unknown>[] = [];
  const existing = resolveOne(nodes, node.selector, "node");
  const selector = nodeSelector(existing, node.selector);
  if (Object.keys(appearance).length > 0) operations.push({ type: "node.update", selector, ...appearance });
  if (node.kind === "portal" && node.subcanvasRef !== undefined) operations.push({ type: "portal.changeSubcanvas", selector, subcanvasRef: node.subcanvasRef });
  if (node.x !== undefined && node.y !== undefined) operations.push(...moveIfDisplaced(existing, selector, node.x, node.y));
  return operations;
}

function moveIfDisplaced(existing: ContextNode | undefined, selector: string, x: number, y: number): Record<string, unknown>[] {
  if (existing?.position?.x === x && existing.position.y === y) return [];
  return [{ type: "node.move", selector, x, y }];
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

function markWriteOperation(mark: Exclude<CanvasIntent["marks"][number], { mode: "remove" }>): Record<string, unknown> | undefined {
  const fields = defined({ text: mark.text, x: mark.x, y: mark.y, width: mark.width, textRuns: mark.textRuns });
  if (mark.mode === "create") return { type: "mark.create", ...fields };
  return Object.keys(fields).length > 0 ? { type: "mark.update", id: mark.id, ...fields } : undefined;
}

function linkVisualValues(link: { label?: string | null; color?: string | null; direction?: string; lineStyle?: string; labelFontSize?: number }): Record<string, unknown> {
  return { label: link.label, color: link.color, direction: link.direction, lineStyle: link.lineStyle, labelFontSize: link.labelFontSize };
}
function readArray<T>(context: unknown, key: string): T[] {
  if (!context || typeof context !== "object") return [];
  const value = (context as Record<string, unknown>)[key];
  return Array.isArray(value) ? value as T[] : [];
}
function matches(nodes: ContextNode[], value: string): ContextNode[] {
  return nodes.filter(node => noteMatches(node, value));
}
function endpointSelector(value: string, nodes: ContextNode[], intent: CanvasIntent): string {
  const existing = matches(nodes, value);
  if (existing.length === 1) return nodeSelector(existing[0], value);
  const placed = intent.nodes.find(node => node.mode === "place" && noteMatches({ ref: node.note }, value));
  return placed?.mode === "place" ? placementSelector(placed.note) : value;
}
function resolveOne(nodes: ContextNode[], value: string, noun: string): ContextNode {
  const found = matches(nodes, value);
  if (found.length === 0) fail("missing_selector", `No ${noun} matches '${value}'`, value, "Use an exact title, ref, or app UUID");
  if (found.length > 1) fail("ambiguous_selector", `Multiple ${noun}s match '${value}'`, value, "Use an app UUID or a unique selector");
  return found[0];
}
function resolveEndpoint(value: string, nodes: ContextNode[], declared: string[]): void {
  const count = matches(nodes, value).length + declared.filter(title => noteMatches({ ref: title }, value)).length;
  if (count === 0) fail("missing_selector", `No Link endpoint matches '${value}'`, "links", "Declare the endpoint or use an exact existing selector");
  if (count > 1) fail("ambiguous_selector", `Link endpoint '${value}' is ambiguous`, "links", "Choose a distinct title or app UUID");
}
function resolveId(items: Array<{ id?: string }>, id: string, noun: string): void {
  if (!items.some((item) => sameId(item.id, id))) fail("missing_selector", `${noun} id '${id}' does not exist on the target Canvas`, id, "Inspect the target Canvas and use its app UUID");
}
function sameId(a?: string | null, b?: string | null): boolean { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
function unorderedPair(a?: string | null, b?: string | null): string { return [a?.toLowerCase() ?? "", b?.toLowerCase() ?? ""].sort().join("\u0000"); }
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
      appearance: nodeAppearanceSchema.options,
      glyphSize: { minimum: 24, maximum: 160, null: "derive from title font size" },
      fontSize: { minimum: 8, maximum: 96 },
      titleGap: { exclusiveMinimum: 0, default: 8 },
      isResizeLocked: { type: "boolean", default: false },
      note: {
        place: { identity: "note", required: ["kind", "mode", "note", "x", "y"], optional: ["titleGap", "isResizeLocked", "appearance", "glyphSize", "fontSize"], note: "the Note's title or Vault-relative path; the markdown file already exists in the Vault" },
        update: { identity: "selector", required: ["kind", "mode", "selector"], optional: ["titleGap", "isResizeLocked", "glyphSize", "fontSize", "appearance", "x", "y"] },
        remove: { identity: "selector", required: ["kind", "mode", "selector"] }
      },
      portal: {
        create: { identity: "title", required: ["kind", "mode", "title", "subcanvasRef", "x", "y"], optional: ["titleGap", "isResizeLocked", "appearance", "glyphSize", "fontSize"] },
        update: { identity: "selector", required: ["kind", "mode", "selector"], optional: ["titleGap", "isResizeLocked", "glyphSize", "fontSize", "subcanvasRef", "appearance", "x", "y"] },
        remove: { identity: "selector", required: ["kind", "mode", "selector"] }
      }
    },
    links: {
      direction: ["directed", "undirected", "bidirectional"],
      lineStyle: lineStyleSchema.options,
      create: { identity: "unordered source/target pair", required: ["mode", "source", "target"], optional: ["label", "color", "direction", "lineStyle", "labelFontSize"] },
      update: { identity: "app Link UUID", required: ["mode", "id"], optional: ["label", "color", "direction", "lineStyle", "labelFontSize", "source", "target", "targetPosition"] },
      remove: { identity: "app Link UUID", required: ["mode", "id"], preservesRelationProse: true }
    },
    primitives: {
      kinds: primitiveKinds,
      create: {
        identity: "app-returned UUID",
        commonOptional: ["title", "color", "lineStyle", "strokeWidth"],
        geometry: {
          region: { required: ["x", "y", "width", "height"], optional: ["fillOpacity"], x: "world-space centre", y: "world-space centre" },
          line: { required: ["x1", "y1", "x2", "y2"] }
        }
      },
      update: { identity: "app DiagramPrimitive UUID", required: ["kind", "mode", "id"] },
      remove: { identity: "app DiagramPrimitive UUID", required: ["kind", "mode", "id"] }
    },
    marks: {
      purpose: "typed canvas text that labels, decorates, or comments without becoming a Note: headings, legends, callouts, questions to the reader",
      position: "x and y are the World-space top-left of the text block, unlike Node centres",
      textRuns: { location: "UTF-16 offset", length: "positive UTF-16 length", styles: markStyleSchema.options },
      connect: "Node selectors; each draws a connection from that Node to the Mark",
      create: { identity: "app-returned UUID", required: ["mode", "text", "x", "y"], optional: ["width", "textRuns", "connect"] },
      update: { identity: "app Mark UUID of a typed Mark", required: ["mode", "id"], optional: ["text", "x", "y", "width", "textRuns", "connect"] },
      remove: { identity: "app Mark UUID", required: ["mode", "id"] }
    }
  },
  content: "never in an intent; a Note is a markdown file the agent writes into the Vault before placing it",
  sharedNoteWrites: "Existing Notes the app may rewrite: the source of a fromNote Link removal, and every Note on either end of a Link endpoint move, before and after.",
  validation: { local: "complete", placedNotes: "resolved by the bridge from disk at apply; preflight rejects an ambiguous title", bridgeValidated: "first nonempty phase for current-Canvas dry-run", deferredUntilApply: "later phases, or every phase for a named-Canvas dry-run" },
  partialApplication: { atomicity: "per-phase", rollback: false, phases: ["linkRemovals", "nodePortalRemovals", "nodePortalWrites", "linkWrites", "primitives", "marks", "markConnections"] },
  success: { ok: true, data: { applied: true, appliedBatches: [], results: [], verification: "targeted" } },
  error: { ok: false, error: { code: "string", message: "string", details: {} } },
  example: { canvas: "current", nodes: [{ kind: "note", mode: "place", note: "docs/Service.md", x: 0, y: 0 }] }
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
