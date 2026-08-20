import { z } from "zod";
import { safeTitle } from "./canvas-intent.js";
import { EnsoCliError } from "./errors.js";
import { FrontmatterError, parseFrontmatter, type ParsedFrontmatter } from "./frontmatter.js";
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
export type DirectionHint = CanvasSpec["direction"];

/**
 * Every structural rule carries its own code, so a caller acts on the rule itself rather than
 * on a display path that two rules happen to share.
 */
export type SpecIssueCode =
  | "duplicate_member"
  | "edge_endpoint_not_member"
  | "self_edge"
  | "duplicate_edge"
  | "duplicate_cluster"
  | "cluster_member_outside_canvas"
  | "member_in_two_clusters";

export type SpecIssue = { code: SpecIssueCode; message: string; path: string };

export function parseCanvasSpec(source: string): CanvasSpec {
  return buildCanvasSpec(readSpecFrontmatter(source).value, specError, "frontmatter");
}

/** The graph model every layout front end compiles to, with its invariants enforced. */
export function buildCanvasSpec(
  value: unknown,
  fail: (message: string, path: string, expected?: string) => EnsoCliError,
  root = "graph"
): CanvasSpec {
  const parsed = canvasSpecSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || root;
    throw fail(
      issue?.message ?? "The canvas graph is invalid",
      path,
      path.endsWith("color") ? VISUAL_COLOR_GRAMMAR : undefined
    );
  }
  const issue = canvasSpecIssues(parsed.data)[0];
  if (issue) throw fail(issue.message, issue.path);
  return parsed.data;
}

/** The shared frontmatter reader in canvas spec dressing. */
export function readSpecFrontmatter(source: string): ParsedFrontmatter {
  try {
    return parseFrontmatter(source);
  } catch (error) {
    if (!(error instanceof FrontmatterError)) throw error;
    throw frontmatterError(error);
  }
}

export function frontmatterError(error: FrontmatterError): EnsoCliError {
  if (error.line === undefined) return specError(error.message, "frontmatter");
  const dressed = specError(`${error.message} (line ${error.line})`, `frontmatter:${error.line}`);
  dressed.body.details = { ...dressed.body.details, line: error.line };
  return dressed;
}

export function canvasSpecFromFrontmatter(frontmatter: unknown): CanvasSpec {
  const parsed = canvasSpecSchema.safeParse(frontmatter);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") || "frontmatter";
  throw specError(
    issue?.message ?? "Canvas spec frontmatter is invalid",
    path,
    path.endsWith("color") ? VISUAL_COLOR_GRAMMAR : undefined
  );
}

/** Every structural violation, in declaration order, so a linter reports the whole file. */
export function canvasSpecIssues(spec: CanvasSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const members = new Set<string>();
  for (const member of spec.members) {
    if (members.has(member.title)) {
      issues.push({ code: "duplicate_member", message: `Member '${member.title}' is declared more than once`, path: "members" });
      continue;
    }
    members.add(member.title);
  }
  // The app holds one Link per unordered endpoint pair, so a pair takes one declaration
  // and a two-way relationship rides on the Link's own direction.
  const pairs = new Set<string>();
  for (const edge of spec.edges) {
    for (const [end, title] of [["from", edge.from], ["to", edge.to]] as const) {
      if (!members.has(title)) {
        issues.push({ code: "edge_endpoint_not_member", message: `Edge endpoint '${title}' is not a canvas member`, path: `edges.${end}` });
      }
    }
    if (edge.from === edge.to) {
      issues.push({ code: "self_edge", message: `Edge '${edge.from}' points at itself`, path: "edges" });
      continue;
    }
    const pair = [edge.from, edge.to].sort(compareStrings).join("\u0000");
    if (pairs.has(pair)) {
      issues.push({ code: "duplicate_edge", message: `Edge '${edge.from}' ↔ '${edge.to}' is declared more than once`, path: "edges" });
    }
    pairs.add(pair);
  }
  const clusterNames = new Set<string>();
  const owners = new Map<string, string>();
  for (const cluster of spec.clusters) {
    if (clusterNames.has(cluster.name)) {
      issues.push({ code: "duplicate_cluster", message: `Cluster '${cluster.name}' is declared more than once`, path: "clusters" });
    }
    clusterNames.add(cluster.name);
    for (const member of cluster.members) {
      if (!members.has(member)) {
        issues.push({
          code: "cluster_member_outside_canvas",
          message: `Cluster '${cluster.name}' lists '${member}', which is not a canvas member`,
          path: "clusters.members"
        });
        continue;
      }
      const owner = owners.get(member);
      if (owner !== undefined) {
        issues.push({
          code: "member_in_two_clusters",
          message: `Member '${member}' belongs to both '${owner}' and '${cluster.name}'`,
          path: "clusters.members"
        });
        continue;
      }
      owners.set(member, cluster.name);
    }
  }
  return issues;
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

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
