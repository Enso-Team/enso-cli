import { VISUAL_COLOR_GRAMMAR, lineStyleSchema, markStyleSchema, nodeAppearanceSchema, primitiveKinds, writingTextAlignmentSchema } from "@enso-app/core";

export const canvasApplyContract = {
  transports: ["file", "--json <literal>", "--json -"],
  input: {
    type: "object",
    required: ["canvas"],
    canvas: "Canvas name, ref, stable canvasID, or current (inherit an immutable binding when supplied)",
    unknownFields: "rejected",
    color: VISUAL_COLOR_GRAMMAR,
    nodes: {
      appearance: nodeAppearanceSchema.options,
      glyphSize: { minimum: 24, maximum: 160, null: "derive from title font size" },
      fontSize: { minimum: 8, maximum: 96 },
      titleGap: { exclusiveMinimum: 0, default: 8 },
      isResizeLocked: { type: "boolean", default: false },
      note: {
        place: { identity: "note", required: ["kind", "mode", "note"], optional: ["in", "x", "y", "titleGap", "isResizeLocked", "appearance", "glyphSize", "fontSize"], note: "the Note's title or Vault-relative path; the markdown file already exists in the Vault", position: "omit x and y to let the growth layout place the Node beside its neighbors; x and y pin it", in: "a Region title or id; the Node lands inside that Region, which grows to hold it" },
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
      acceptedKinds: ["region", "group", "line"],
      storedKind: { region: "group" },
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
      fontSize: { unit: "world points", default: 17, minimum: 8, maximum: 96 },
      textAlignment: { default: "left", values: writingTextAlignmentSchema.options, scope: "whole placement" },
      textRuns: { location: "UTF-16 offset", length: "positive UTF-16 length", styles: markStyleSchema.options },
      connect: "Node selectors; each draws a connection from that Node to the Mark",
      create: { identity: "app-returned UUID", required: ["mode", "text"], optional: ["x", "y", "width", "fontSize", "textAlignment", "textRuns", "connect"], position: "omit x and y to place the Mark beside the first Node it connects to, or above the drawing when it connects to none" },
      update: { identity: "app Mark UUID of a typed Mark", required: ["mode", "id"], optional: ["text", "x", "y", "width", "fontSize", "textAlignment", "textRuns", "connect"] },
      remove: { identity: "app Mark UUID", required: ["mode", "id"] }
    },
    excerpts: {
      purpose: "a passage of a placed Note's markdown shown on the Canvas, linked from the Note's Node",
      position: "x and y are the World-space top-left; omit them to place the Excerpt in the lane beside its Node",
      create: { identity: "app-returned UUID", required: ["mode", "note", "text"], optional: ["occurrence", "width", "x", "y"], text: "quoted exactly as the markdown file holds it" },
      update: { identity: "app Excerpt UUID", required: ["mode", "id"], optional: ["x", "y", "width"] },
      remove: { identity: "app Excerpt UUID", required: ["mode", "id"], keepsPassage: true }
    },
    regions: {
      identity: "title; reuses the one Region with that title, and fails as ambiguous when several share it",
      optional: ["color"],
      growth: "a Region appears around the first Node placed in it and grows with each later one; it never covers a Node outside it"
    },
    direction: { values: ["TB", "LR"], default: "TB", note: "the growth direction, set when a growth starts" },
    tidy: "true reruns the full layout over the growth's Nodes and keeps it only when it removes crossings; it ends the growth"
  },
  growth: {
    span: "the applies one agent makes on a Canvas; it ends after 2 minutes without a write, when a person moves one of its Nodes or reshapes one of its Regions, or on tidy",
    runsWhen: "an intent places a Node without x and y, names a Region, or tidies, and every graph change while a growth runs",
    moves: "placed Nodes keep their rank and order; a Node next to new work drifts at most half a grid step",
    olderNodes: "Nodes from before the growth never move; new work lands beside the ones it links to",
    regions: "Regions from before the growth grow when that covers no outside Node; Regions the growth drew also shrink, and go when empty"
  },
  content: "never in an intent; a Note is a markdown file the agent writes into the Vault before placing it",
  sharedNoteWrites: "Existing Notes the app may rewrite: the source of a fromNote Link removal, and every Note on either end of a Link endpoint move, before and after.",
  validation: { local: "complete", placedNotes: "resolved by the bridge from disk at apply; preflight rejects an ambiguous title", bridgeValidated: "first nonempty phase on the invocation target", deferredUntilApply: "later phases" },
  targeting: { contractVersion: 3, selection: "resolved once per invocation", navigation: "separate explicit command", binding: "--vault-id/--canvas-id or ENSO_VAULT_ID/ENSO_CANVAS_ID" },
  partialApplication: { atomicity: "per-phase", rollback: false, phases: ["linkRemovals", "nodePortalRemovals", "nodePortalWrites", "linkWrites", "primitives", "marks", "markConnections", "excerpts"] },
  success: { ok: true, data: { applied: true, appliedBatches: [], results: [], verification: "targeted" } },
  error: { ok: false, error: { code: "string", message: "string", details: {} } },
  example: { canvas: "current", nodes: [{ kind: "note", mode: "place", note: "Sync server" }], links: [{ mode: "create", source: "Client", target: "Sync server", label: "sends updates to" }], excerpts: [{ mode: "create", note: "Sync server", text: "Retries with backoff." }] }
} as const;
