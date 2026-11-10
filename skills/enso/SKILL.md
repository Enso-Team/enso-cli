---
name: enso
description: Work with the user on an Enso Canvas. Use when they want something explained or mapped on a diagram, a design ported, a canvas revised, what they wrote on a canvas acted on, or code built from one.
---
# Enso

## Goal

The Canvas must immediately be comprehensible at a glance, without opening any of its Nodes. The broader message must be understandable from Note titles, Link labels, Marks, and Excerpts alone while deeper explanations reside in the Notes of the Nodes. Your chat reply is a caption. Name the Canvas and its key takeaways in a few lines, and put the explanation itself on the Canvas.

Before offering layouts or changing an arrangement, read [references/diagram-design.md](references/diagram-design.md). When the Canvas maps code at any scope (the whole system, a module, or the files one question touches), or ports an existing diagram or design doc, also read [references/system-maps.md](references/system-maps.md).

Then work out what the user needs to understand, and offer two or three layouts as one-line sketches, such as "a map of the files the question touches, each flow a path of Links in its own color". Recommend one and wait for the user's pick, then build the layout they chose. A revision keeps the Canvas's layout unless the user asks for a new one.

## Work through the CLI

Use the Enso CLI for app inspection and edits. Refresh live IDs and geometry after relevant edits. Computer use is reserved for an explicit request to operate the native UI.

Start with `enso status`, `enso vault current`, and `enso canvas list`. When `status` reports `skill.stale`, pass its hint to the user. Write and read Note markdown in the returned Vault `path`. Select the intended Canvas. Each command captures one stable target; `current` captures the active Canvas once for that invocation. Use `--canvas <name|ref|canvasID>` for selection. Open another Canvas with a separate explicit `enso canvas open <selector>` before editing it. Create a missing Canvas with `enso canvas create` when the request authorizes it. Run `enso vault create <path>` only when the user asks for a new Vault, and add `--sync` only when they ask for it synced.

When a caller supplies `ENSO_VAULT_ID` and `ENSO_CANVAS_ID`, preserve that immutable binding on every CLI call. Use no `--canvas` override or navigation; apply/layout inputs use `current` or the bound `canvasID`. Partial bindings and conflicting targets fail. The equivalent flags are `--vault-id <uuid> --canvas-id <uuid>`. Binding checks correctness; app credentials govern access. On `target_not_active`, `wrong_vault`, or `target_changed`, report the error and inspect possible partial effects when the intended target is available. Let the person choose navigation and retries. Targeted commands require app bridge contract 3.

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

Before a first build, and when an apply fails, read [references/canvas-operations.md](references/canvas-operations.md).

Write to the Canvas with `enso canvas apply` so the diagram grows while the user watches:

1. Send one small intent per step: a Node with its Links, and its Excerpt or Mark. Leave out `x` and `y`, and the CLI places the Node beside its neighbors. When the Node belongs to a Region, place it `in` that Region.
2. Start at the beginning of the main path, and link each new Node to one already placed.
3. Set `direction` in the first intent.

Quote each Excerpt passage exactly as the markdown file holds it.

Small edits go through `canvas apply` too, as an intent carrying only the change. Apply without a dry run, except for the commands that rewrite Notes: `enso node rename`, `enso excerpt source`, `enso excerpt remove-from-note`, `enso mark add-to-note`, `enso mark drop-to-note`, and `enso link delete`. Use `enso layout` when the user asks to rearrange a Canvas, or for Regions nested inside Regions.

## Revise the existing explanation

Treat each user revision as an edit to the current Canvas. Inspect its affected elements with `enso context --canvas <target>`, reuse their IDs, and preserve unaffected Notes, positions, and user adjustments.

Link each addition to the Nodes it relates to. It lands beside them, and Nodes that were on the Canvas before you started stay where they are.

When editing a Note's markdown, keep its `<!-- annotation:<id>:start -->` and `:end -->` markers, which hold its Excerpts' passages.

Move a Mark into a Note with `enso mark add-to-note` or `drop-to-note` when the user asks.

## Act on writing on the Canvas

When the user points at writing on the Canvas, read it with `enso mark list`. Handwriting carries an interpretation. Quote an unapproved interpretation back before acting on it.

Writing addressed to you is a prompt. Do what it asks and add the result to the prompt: put a typed Mark with the answer directly below it, and place any new Nodes, Excerpts, or Marks beside it. The prompt stays in place.

## Build from a Canvas

When a Canvas is the design for code or a mockup, read it with `enso context --canvas <target> --spec`, then read each member's `note` in the Vault. The spec view gives the structure: members, edges with their labels and colors, clusters, lines, and Marks for things to note for the entire design. Each Note describes its element.

## Verify

After every build, layout change, or placement revision, run `enso context --canvas <target> --diagnostics` and follow "Inspect and repair" in [references/diagram-design.md](references/diagram-design.md). When Links cross on the main path of a diagram you just built, apply `{"canvas":"current","tidy":true}`. It rearranges what you built only when that removes crossings. Once diagnostics are clean, run `--vision` once before finishing and read the image as a reader who opens no Note. The takeaway, the main path, and each key sentence should be legible at that glance.

Finish when a reader who opens no Note can state the answer from the Canvas alone, diagnostics show no fault that obstructs that reading, and every region holds exactly its members. If the Canvas needs chat to be understood, redraw the Canvas.
