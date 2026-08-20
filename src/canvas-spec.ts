import { z } from "zod";
import { safeTitle } from "./canvas-intent.js";
import { EnsoCliError } from "./errors.js";
import { VISUAL_COLOR_GRAMMAR, linkDirectionSchema, visualColorSchema } from "./link-model.js";

// A canvas spec is one markdown manifest per canvas: frontmatter declares the graph,
// the body is the canvas's own descriptive prose and is never compiled.

const nonEmpty = z.string().min(1);

const directionHintSchema = z.preprocess(
  (value) => typeof value === "string" ? { "top-bottom": "TB", "left-right": "LR", tb: "TB", lr: "LR" }[value.toLowerCase()] ?? value : value,
  z.enum(["TB", "LR"])
);

const memberSchema = z.union([
  safeTitle.transform((title) => ({ title, mode: "create" as const })),
  z.object({ title: safeTitle, mode: z.enum(["create", "reuse"]).default("create") }).strict()
]);

const edgeSchema = z.object({
  from: nonEmpty,
  to: nonEmpty,
  label: nonEmpty.optional(),
  direction: linkDirectionSchema.optional(),
  color: visualColorSchema.optional()
}).strict();

const clusterSchema = z.object({
  name: nonEmpty,
  color: visualColorSchema.optional(),
  members: z.array(nonEmpty).min(1)
}).strict();

export const canvasSpecSchema = z.object({
  canvas: nonEmpty,
  direction: directionHintSchema.default("TB"),
  members: z.array(memberSchema).min(1),
  edges: z.array(edgeSchema).default([]),
  clusters: z.array(clusterSchema).default([])
}).strict();

export type CanvasSpec = z.infer<typeof canvasSpecSchema>;

export function parseCanvasSpec(source: string): CanvasSpec {
  const frontmatter = readFrontmatter(source);
  const parsed = canvasSpecSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "frontmatter";
    throw specError(
      issue?.message ?? "Canvas spec frontmatter is invalid",
      path,
      path.endsWith("color") ? VISUAL_COLOR_GRAMMAR : undefined
    );
  }
  const spec = parsed.data;
  const titles = spec.members.map((member) => member.title);
  const seen = new Set<string>();
  for (const title of titles) {
    if (seen.has(title)) throw specError(`Member '${title}' is declared more than once`, "members");
    seen.add(title);
  }
  const pairs = new Set<string>();
  for (const edge of spec.edges) {
    if (!seen.has(edge.from)) throw specError(`Edge endpoint '${edge.from}' is not a canvas member`, "edges.from");
    if (!seen.has(edge.to)) throw specError(`Edge endpoint '${edge.to}' is not a canvas member`, "edges.to");
    if (edge.from === edge.to) throw specError(`Edge '${edge.from}' points at itself`, "edges");
    const pair = [edge.from, edge.to].sort(compareStrings).join("\u0000");
    if (pairs.has(pair)) throw specError(`Edge '${edge.from}' ↔ '${edge.to}' is declared more than once`, "edges");
    pairs.add(pair);
  }
  const clusterNames = new Set<string>();
  const grouped = new Map<string, string>();
  for (const cluster of spec.clusters) {
    if (clusterNames.has(cluster.name)) throw specError(`Cluster '${cluster.name}' is declared more than once`, "clusters");
    clusterNames.add(cluster.name);
    for (const member of cluster.members) {
      if (!seen.has(member)) throw specError(`Cluster '${cluster.name}' lists '${member}', which is not a canvas member`, "clusters.members");
      const owner = grouped.get(member);
      if (owner !== undefined) throw specError(`Member '${member}' belongs to both '${owner}' and '${cluster.name}'`, "clusters.members");
      grouped.set(member, cluster.name);
    }
  }
  return spec;
}

export function specError(message: string, path: string, expected?: string): EnsoCliError {
  return new EnsoCliError("invalid_input", message, {
    path,
    expected: expected ?? "a canvas spec with canvas, members, and optional edges, clusters, and direction",
    hint: "Run `enso layout --schema` for the machine-readable canvas spec contract"
  });
}

export const canvasSpecContract = {
  file: "one markdown manifest per canvas, YAML-subset frontmatter plus descriptive prose body",
  frontmatter: {
    canvas: "target Canvas name, or current",
    direction: { values: ["TB", "LR"], aliases: { "top-bottom": "TB", "left-right": "LR" }, default: "TB" },
    members: "sequence of Note titles, or { title, mode: create | reuse } mappings",
    edges: "sequence of { from, to } with optional label, direction, color",
    clusters: "sequence of { name, members } with optional semantic color"
  },
  color: VISUAL_COLOR_GRAMMAR,
  body: "descriptive prose, never compiled",
  output: "a canvas apply patch; see `enso canvas apply --schema`",
  determinism: "identical spec input yields byte-identical geometry",
  example: [
    "---",
    "canvas: Request Flow",
    "direction: LR",
    "members:",
    "  - Gateway",
    "  - Router",
    "edges:",
    "  - from: Gateway",
    "    to: Router",
    "    label: routes",
    "clusters:",
    "  - name: Edge",
    "    color: \"#6B7280\"",
    "    members:",
    "      - Gateway",
    "---",
    "",
    "How a request reaches the router."
  ].join("\n")
} as const;

type SpecLine = { indent: number; text: string; line: number };

function readFrontmatter(source: string): unknown {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    throw specError("Canvas spec must open with a `---` frontmatter fence", "frontmatter");
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) throw specError("Canvas spec frontmatter is never closed with `---`", "frontmatter");
  const block = toSpecLines(lines.slice(1, closing), 2);
  if (block.length === 0) throw specError("Canvas spec frontmatter is empty", "frontmatter");
  return parseBlock(block);
}

function toSpecLines(raw: string[], firstLineNumber: number): SpecLine[] {
  const lines: SpecLine[] = [];
  raw.forEach((value, index) => {
    const line = index + firstLineNumber;
    if (value.includes("\t")) throw lineError("Tabs are not allowed in canvas spec frontmatter", line);
    const text = value.trim();
    if (text === "" || text.startsWith("#")) return;
    lines.push({ indent: value.length - value.trimStart().length, text, line });
  });
  return lines;
}

function parseBlock(lines: SpecLine[]): unknown {
  return isSequenceItem(lines[0].text) ? parseSequence(lines) : parseMapping(lines);
}

function parseMapping(lines: SpecLine[]): Record<string, unknown> {
  const result = new Map<string, unknown>();
  const indent = lines[0].indent;
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) throw lineError("Inconsistent indentation", line.line);
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line.text);
    if (!match) throw lineError("Expected a `key: value` entry", line.line);
    const key = match[1];
    if (result.has(key)) throw lineError(`Duplicate key '${key}'`, line.line);
    const inline = (match[2] ?? "").trim();
    const children: SpecLine[] = [];
    cursor += 1;
    while (cursor < lines.length && lines[cursor].indent > indent) {
      children.push(lines[cursor]);
      cursor += 1;
    }
    if (inline === "") {
      if (children.length === 0) throw lineError(`Key '${key}' has no value; indent its block underneath`, line.line);
      result.set(key, parseBlock(children));
    } else {
      if (children.length > 0) throw lineError(`Key '${key}' has both an inline value and an indented block`, line.line);
      result.set(key, parseScalar(inline, line.line));
    }
  }
  return Object.fromEntries(result);
}

function parseSequence(lines: SpecLine[]): unknown[] {
  const items: unknown[] = [];
  const indent = lines[0].indent;
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) throw lineError("Inconsistent indentation", line.line);
    if (!isSequenceItem(line.text)) throw lineError("Expected a `- ` sequence item", line.line);
    const inline = line.text.slice(1).trim();
    const children: SpecLine[] = [];
    cursor += 1;
    while (cursor < lines.length && lines[cursor].indent > indent) {
      children.push(lines[cursor]);
      cursor += 1;
    }
    const base = children.length > 0 ? Math.min(...children.map((child) => child.indent)) : indent + 2;
    if (inline === "") {
      if (children.length === 0) throw lineError("Sequence item has no value", line.line);
      items.push(parseBlock(children));
    } else if (/^[A-Za-z][A-Za-z0-9_-]*:(\s|$)/.test(inline)) {
      items.push(parseMapping([{ indent: base, text: inline, line: line.line }, ...children]));
    } else {
      if (children.length > 0) throw lineError("Sequence item has both an inline value and an indented block", line.line);
      items.push(parseScalar(inline, line.line));
    }
  }
  return items;
}

function parseScalar(value: string, line: number): unknown {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  if (quoted) return quoted[1];
  if (/^[[{]/.test(value)) throw lineError("Inline collections are not supported; write an indented block", line);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function lineError(message: string, line: number): EnsoCliError {
  return specError(`${message} (line ${line})`, `frontmatter:${line}`);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
