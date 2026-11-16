import { VISUAL_COLOR_GRAMMAR } from "@enso-app/core";

export const canvasSpecContract = {
  file: "command-input graph JSON, not a Vault file",
  graph: {
    canvas: "target canvas name, ref, stable canvasID, or current; applying requires the target to be active",
    direction: { values: ["TB", "LR"], aliases: { "top-bottom": "TB", "left-right": "LR" }, default: "TB" },
    members: "sequence of Notes that already exist in the Vault, each a title or Vault-relative path, or a { title, appearance, excerpt, mark } mapping; a spec whose members are all symbols lays out at symbol density",
    "members.excerpt": "a passage of the member's Note, quoted exactly as the markdown file holds it, placed as an Excerpt beside the member's Node",
    "members.mark": "typed text about the member, placed as a Mark beside its Node and connected to it",
    edges: "sequence of { from, to } with optional label, direction, color",
    clusters: "sequence of { name, members } with optional semantic color",
    marks: "sequence of canvas-wide Marks, each text or { text, width }, stacked above the drawing: the takeaway, a legend"
  },
  annotations: "Excerpts and member Marks sit in a lane beside their Node, to the right for TB and below for LR. Regions grow to hold them.",
  color: VISUAL_COLOR_GRAMMAR,
  output: "a canvas apply patch of place/link/region/mark operations, plus the planned Excerpts; see `enso canvas apply --schema`",
  determinism: "identical spec input yields byte-identical geometry",
  example: {
    canvas: "Request Flow",
    direction: "LR",
    members: ["Gateway", "Router"],
    edges: [{ from: "Gateway", to: "Router", label: "routes" }],
    clusters: [{ name: "Edge", color: "#6B7280", members: ["Gateway"] }]
  }
} as const;
