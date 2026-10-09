---
name: enso
description: Create and revise visual explanations in Enso. Use when someone needs a visual explanation or asks to work in Enso.
---
# Enso

## Frame the explanation

Use the conversation to identify what the reader needs to understand. Choose the concepts and relationships that answer that question before choosing geometry. When a broad request supports materially different diagram structures, ask one focused question before building. Recommend a structure based on the conversation and wait for the answer. For a clearly specified request, briefly state the organizing structure and proceed. Choose spacing, icons, colors, and other presentation details using your judgment.

Let the subject determine the form: a journey, state model, comparison, architecture, or another useful arrangement. Screens and states can be Nodes; actions often work as Link labels. Give an action its own Node when its behavior deserves separate explanation. Keep the behavior under investigation visible, including intermediate states that explain a delay or failure. Distinguish reported observations, source evidence, and hypotheses in the Notes and labels.

For a new arrangement or a substantial layout change, read [references/diagram-design.md](references/diagram-design.md). Choose grouping, appearance, and color for their explanatory value.

## Work through the CLI

Use the Enso CLI for app inspection and edits, and filesystem tools for markdown and temporary intents. Discover operations through focused `enso <command> --help` or `enso canvas apply --schema`. Computer use is reserved for an explicit request to operate the native UI.

Start with `enso status --pretty`, `enso vault current --pretty`, and `enso canvas list --pretty`. Use the returned Vault `path` for markdown. Select the intended Canvas; `current` means the Canvas the app has open. Create a missing Canvas with `enso canvas create` when the request authorizes it.

Each Note is a durable explanation of its concept in prose. Read and edit its markdown directly. A visible Link rests on a sentence in the source Note containing `[[Target]]`; give the curve a short label when that sentence is long. The app owns Canvas JSON and sidecar state.

A Mark is typed text on the Canvas that labels, decorates, or expands on it without being a concept. Use one where a Note would be hollow, such as a heading, lane label, legend, or callout. Put a question or unverified claim addressed to the user in a Mark connected to its Node, and keep durable reasoning in the Note. When the user answers one of your Marks from this session, fold the answer into the Note or delete the Mark. Leave the user's Marks and Marks from earlier sessions in place unless asked.

Before a first build or a multi-element revision, read [references/canvas-operations.md](references/canvas-operations.md) for file checks, apply, and recovery. Put one coherent creation or revision in one temporary `canvas apply` intent. Use a typed command for a single edit. Dry-run CLI mutations before applying them.

## Revise the existing explanation

Treat each user revision as an edit to the current Canvas. Inspect its affected elements, reuse their IDs, and preserve unaffected Notes, positions, and user adjustments. Change the organizing structure when the user requests that change. Anchor additions to inspected neighbors. Refresh affected Links after prose edits because changing a mention can change the live Link inventory.

When the user refers to writing on the Canvas, read it with `enso mark list`. Handwriting carries an interpretation. Quote an unapproved interpretation back before acting on it. Move a Mark into a Note with `enso mark add-to-note` or `drop-to-note` when the user asks.

For placement changes, inspect `enso context --canvas <target> --vision --pretty` and use the returned geometry and `data.vision.diagnostics`. All `x` and `y` values are world-space centers. After creation or a layout change, check diagnostics and repair faults that obstruct the intended reading. Keep repairs scoped to the affected area and inspect after a repair to confirm its effect. Report a remaining obstruction when further repair needs a broader redesign.

Finish when the Canvas expresses the requested explanation and the affected elements have the requested structure and appearance. Successful apply and clear diagnostics support mechanical verification; assess the explanation against the user's question as well.
