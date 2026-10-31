---
name: enso
description: Work with the user on an Enso Canvas. Use when they want something explained or mapped on a diagram, a design ported, a canvas revised, what they wrote on a canvas acted on, or code built from one.
---
# Enso

## Goal

The Canvas must immediately be comprehensible at a glance, without opening any of its Nodes. The broader message must be understandable from Note titles, Link labels, Marks, and Excerpts alone while deeper explanations reside in the Notes of the Nodes. Your chat reply is a caption. Name the Canvas and its key takeaways in a few lines, and put the explanation itself on the Canvas.

Before building a new Canvas, work out what the user needs to understand, then offer two or three layouts as one-line sketches, such as "rows for each user flow, columns for each part of the flow such as the server and database". Recommend one and wait for the user's pick, then build the layout they chose. A revision keeps the Canvas's layout unless the user asks for a new one.

To sketch layouts or change an arrangement, read [references/diagram-design.md](references/diagram-design.md).

For a map of code at any scope (the whole system, a module, or the files one question touches), or a port of an existing diagram or design doc, read [references/system-maps.md](references/system-maps.md).

## Work through the CLI

Use the Enso CLI for app inspection and edits. Refresh live IDs and geometry after relevant edits. Computer use is reserved for an explicit request to operate the native UI.

Start with `enso status`, `enso vault current`, and `enso canvas list`. When `status` reports `skill.stale`, pass its hint to the user. Write and read Note markdown in the returned Vault `path`. Select the intended Canvas. `current` means the Canvas the app has open. Create a missing Canvas with `enso canvas create` when the request authorizes it. Run `enso vault create <path>` only when the user asks for a new Vault, and add `--sync` only when they ask for it synced.

## Write on the canvas

A Node's title names its concept. Its Note holds the detail behind the surface in prose. Read and edit its markdown directly.

An Excerpt shows a passage of a Note on the Canvas, linked from that Note's Node. Give relevant Nodes on the canvas an Excerpt carrying a key sentence or code, and write that sentence in the Note so it reads well on its own.

Show claims about code with code. Put the smallest snippet that proves the claim in the Note as a fenced block headed by its `path:line`: the exact lines, a pseudocode sketch, a call tree, or a diff. Excerpt the snippet when it is the Node's point. For example, a call tree:

```text
Enso/CRDT/CRDTCoordinator.swift:139
retireDeletedCanvases
  stopSyncingDeletedCanvas
  publishDiscoveryEntry(kind: .canvas, deleted: true)
```

A claim you cannot back with a snippet goes in a question Mark.

A visible Link rests on a sentence in the source Note containing `[[Target]]`. Label it with a linking phrase of two to five words that reads between the two titles as one sentence. The label holds the verb: Sync server → "sends an update on GET" → Client. Add a noun only for what the titles leave out, such as the data the Link carries ("sends a JSON patch") or the event that triggers it ("on reconnect").

A Mark is words on the Canvas that is not a part of a concept. Use Marks for the takeaway, headings, lane labels, legends, callouts and questions. For questions, connect the Mark to its related Nodes. When the user answers one of your Marks from this session, fold the answer into the Mark. Leave the user's Marks and Marks from earlier sessions in place unless asked.

When the user asks a follow-up about the Canvas, answer on the Canvas. Add or revise the Marks, Excerpts, and Nodes that carry the answer, then caption the change in chat.

## Build

Before a first build or a multi-element revision, and when an apply fails, read [references/canvas-operations.md](references/canvas-operations.md). Use `enso layout` for a new arrangement of Notes whose relationships, direction, and clusters determine placement. Use `canvas apply` for precise geometry, mixed elements, or multi-element revisions, collecting a coherent change in one temporary intent. Give a member an `excerpt` or `mark` in the layout graph and `enso layout` places it beside the member's Node. Add an Excerpt to a Node already on the Canvas with `enso excerpt create --note <node> --text "<passage>" --x <n> --y <n>`. Quote each passage exactly as the markdown file holds it. Use a typed command for a single edit. Dry-run CLI mutations before applying them.

## Revise the existing explanation

Treat each user revision as an edit to the current Canvas. Inspect its affected elements with `enso context --canvas <target>`, reuse their IDs, and preserve unaffected Notes, positions, and user adjustments. Anchor additions to inspected neighbors. When editing a Note's markdown, keep its `<!-- annotation:<id>:start -->` and `:end -->` markers, which hold its Excerpts' passages.

Move a Mark into a Note with `enso mark add-to-note` or `drop-to-note` when the user asks.

## Act on writing on the Canvas

When the user points at writing on the Canvas, read it with `enso mark list`. Handwriting carries an interpretation. Quote an unapproved interpretation back before acting on it.

Writing addressed to you is a prompt. Do what it asks and add the result to the prompt: put a typed Mark with the answer directly below it, and place any new Nodes, Excerpts, or Marks beside it. The prompt stays in place.

## Build from a Canvas

When a Canvas is the design for code or a mockup, read it with `enso context --canvas <target> --spec`, then read each member's `note` in the Vault. The spec view gives the structure: members, edges with their labels and colors, clusters, lines, and Marks for things to note for the entire design. Each Note describes its element.

## Verify

After every build, layout change, or placement revision, run `enso context --canvas <target> --diagnostics` and follow "Inspect and repair" in [references/diagram-design.md](references/diagram-design.md). Once diagnostics are clean, run `--vision` once before finishing and read the image as a reader who opens no Note. The takeaway, the main path, and each key sentence should be legible at that glance.

Finish when a reader who opens no Note can state the answer from the Canvas alone, diagnostics show no fault that obstructs that reading, and every region holds exactly its members. If the Canvas needs chat to be understood, redraw the Canvas.
