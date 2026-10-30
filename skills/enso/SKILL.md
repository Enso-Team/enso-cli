---
name: enso
description: Create and revise visual explanations in Enso, including system-design and architecture maps and ports of existing diagrams or design docs. Use when someone needs a visual explanation, wants a system mapped, builds from a Canvas, or asks to work in Enso.
---
# Enso

## Frame the explanation

Use the conversation to identify what the reader needs to understand. Choose the concepts and relationships that answer that question before choosing geometry. When a broad request supports materially different diagram structures, ask one focused question before building. Recommend a structure based on the conversation and wait for the answer. For a clearly specified request, briefly state the organizing structure and proceed.

Let the subject determine the form: a journey, state model, comparison, architecture, or another useful arrangement. Screens and states can be Nodes; actions often work as Link labels. Give an action its own Node when its behavior deserves separate explanation. Keep the behavior under investigation visible, including intermediate states that explain a delay or failure. Distinguish reported observations, source evidence, and hypotheses in the Notes and labels.

For a new arrangement or a substantial layout change, read [references/diagram-design.md](references/diagram-design.md).

For a system design, architecture, or codebase map, including a port of an existing diagram or design doc, read [references/system-maps.md](references/system-maps.md).

## Work through the CLI

Use the Enso CLI for app inspection and edits. Use focused `enso <command> --help` or the chosen command's schema when its contract is unfamiliar. Read CLI output as returned: each `context` view carries only what its task needs, and apply results are short. Reuse loaded instructions, contracts, and target information within the active context; refresh live IDs and geometry after relevant edits. Computer use is reserved for an explicit request to operate the native UI.

Start with `enso status`, `enso vault current`, and `enso canvas list`. When `status` reports `skill.stale`, pass its hint to the user. Write and read Note markdown in the returned Vault `path`. Select the intended Canvas; `current` means the Canvas the app has open. Create a missing Canvas with `enso canvas create` when the request authorizes it. Run `enso vault create <path>` only when the user asks for a new Vault, and add `--sync` only when they ask for it synced.

Each Note is a durable explanation of its concept in prose. Read and edit its markdown directly, but rename a Note with `enso node rename <selector> <new-title>` rather than `mv`: it rewrites the `[[wikilinks]]` and Canvas references a moved file would break. It finds the Node on the open Canvas, so open a Canvas holding the Note first, and check `unreadableNotes` in its result for Links it could not rewrite. A visible Link rests on a sentence in the source Note containing `[[Target]]`; give the curve a short label when that sentence is long. The app owns Canvas JSON and sidecar state.

A Mark is typed text on the Canvas that labels, decorates, or expands on it without being a concept. Use one where a Note would be hollow, such as a heading, lane label, legend, or callout. Put a question or unverified claim addressed to the user in a Mark connected to its Node, and keep durable reasoning in the Note. When the user answers one of your Marks from this session, fold the answer into the Note or delete the Mark. Leave the user's Marks and Marks from earlier sessions in place unless asked.

An Excerpt shows a passage of a Note on the Canvas, linked from that Note's node. Use one to surface the sentence or code a reader should see without opening the Note. Place it with `enso excerpt create --note <node> --text "<passage>" --x <n> --y <n>`, quoting the passage exactly as the markdown file holds it. The Note owns the text, so `enso excerpt source <id> --text` edits the Note, and `enso excerpt delete` removes only the placement.

## Build

Before a first build or a multi-element revision, read [references/canvas-operations.md](references/canvas-operations.md) for file checks, creation, and recovery. Use `enso layout` for a new arrangement of Notes whose relationships, direction, and clusters determine placement. Use `canvas apply` for precise geometry, mixed elements, or multi-element revisions, collecting a coherent change in one temporary intent. Use a typed command for a single edit. Dry-run CLI mutations before applying them.

## Revise the existing explanation

Treat each user revision as an edit to the current Canvas. Inspect its affected elements with `enso context --canvas <target>`, reuse their IDs, and preserve unaffected Notes, positions, and user adjustments. Change the organizing structure when the user requests that change. Anchor additions to inspected neighbors. Refresh affected Links after prose edits because changing a mention can change the live Link inventory.

When the user refers to writing on the Canvas, read it with `enso mark list`. Handwriting carries an interpretation. Quote an unapproved interpretation back before acting on it. Move a Mark into a Note with `enso mark add-to-note` or `drop-to-note` when the user asks.

## Build from a Canvas

When a Canvas is the spec for code or a mockup, read it with `enso context --canvas <target> --spec`, then read each member's `note` in the Vault. The spec view gives the structure: members, edges with their labels and colors, clusters, lines, and Marks with the members they are about. Each Note describes its element.

## Verify

After every build, layout change, or placement revision, run `enso context --canvas <target> --diagnostics` and follow "Inspect and repair" in [references/diagram-design.md](references/diagram-design.md). Use `--vision` and inspect the returned image when a concrete visual question needs rendered appearance, such as whether color or scale conveys the intended grouping, or whether a port matches its source.

Finish when the Canvas answers the user's question, the affected elements have the requested structure and appearance, and diagnostics show no fault that obstructs the intended reading, and every region holds exactly its members. For a port, every crosswalk row is on the Canvas or carries a stated reason.
