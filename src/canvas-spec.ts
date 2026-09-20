import { z } from "zod";
import { EnsoCliError } from "./errors.js";
import { VISUAL_COLOR_GRAMMAR, linkDirectionSchema, visualColorSchema } from "./link-model.js";

// A canvas spec is a graph JSON: members, edges, clusters, direction. Layout compiles
// it into a place-only apply patch. Titles are vault files, never mermaid ids.

const nonEmpty = z.string().min(1);

const directionHintSchema = z.preprocess(
  (value) => typeof value === "string" ? { "top-bottom": "TB", "left-right": "LR", tb: "TB", lr: "LR" }[value.toLowerCase()] ?? value : value,
  z.enum(["TB", "LR"])
);

// A member names a Note that already exists in the Vault, by title or Vault-relative path.
const memberSchema = z.union([
  nonEmpty.transform((title) => ({ title })),
  z.object({ title: nonEmpty }).strict()
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
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch (error) {
    throw specError(
      error instanceof Error ? `Graph JSON is not valid JSON: ${error.message}` : "Graph JSON is not valid JSON",
      "spec"
    );
  }
  const spec = canvasSpecFromObject(decoded);
  const issue = canvasSpecIssues(spec)[0];
  if (issue) throw specError(issue.message, issue.path);
  return spec;
}

export function canvasSpecFromObject(value: unknown): CanvasSpec {
  const parsed = canvasSpecSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path =
    issue?.code === "unrecognized_keys" ? issue.keys[0] ?? "spec" : issue?.path.join(".") || "spec";
  throw specError(
    issue?.message ?? "Canvas graph JSON is invalid",
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
    expected: expected ?? "a graph JSON with canvas, members, and optional edges, clusters, and direction",
    hint: "Run `enso layout --schema` for the machine-readable canvas spec contract"
  });
}

export const canvasSpecContract = {
  file: "command-input graph JSON, not a Vault file",
  graph: {
    canvas: "target Canvas name, or current",
    direction: { values: ["TB", "LR"], aliases: { "top-bottom": "TB", "left-right": "LR" }, default: "TB" },
    members: "sequence of Notes that already exist in the Vault, each a title or Vault-relative path, or a { title } mapping",
    edges: "sequence of { from, to } with optional label, direction, color",
    clusters: "sequence of { name, members } with optional semantic color"
  },
  color: VISUAL_COLOR_GRAMMAR,
  output: "a canvas apply patch of place/link/region operations; see `enso canvas apply --schema`",
  determinism: "identical spec input yields byte-identical geometry",
  example: {
    canvas: "Request Flow",
    direction: "LR",
    members: ["Gateway", "Router"],
    edges: [{ from: "Gateway", to: "Router", label: "routes" }],
    clusters: [{ name: "Edge", color: "#6B7280", members: ["Gateway"] }]
  }
} as const;

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
