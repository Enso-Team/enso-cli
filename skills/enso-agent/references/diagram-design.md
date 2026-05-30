# Enso Diagram Design

Use this reference when creating, reviewing, or improving technical diagrams in Enso.

## Contents

- Capability Contract
- Choosing Canvas Objects
- Codebase Architecture Maps (+ Codebase Node Markdown)
- Design Goals
- Viewport Anchoring (numeric placement recipe)
- Layout Patterns
- Visual Hierarchy Without Styling
- Grouping
- Edges And Labels
- Diagnostics And Fix Order (+ iterative layout loop)
- Review Checklist

## Capability Contract

Through the current Enso CLI/app bridge, agents can:

- Create, write, move, and delete nodes.
- Create, open, retarget, and delete portal nodes for node-level drill-down canvases.
- Create and delete links.
- Set link labels, direction, and line color.
- Create, update, and delete arbitrary diagram lines, structured section dividers, and group boundaries.
- Attach, create, and open subcanvas links on portal nodes (subcanvases live on portal nodes).
- Create, inspect, and open canvases.
- Capture viewport screenshots and structured vision diagnostics.

The Enso app visual surface includes:

- Directed relationship arrows.
- Colored relationship lines.
- Link labels.
- Arbitrary diagram lines, section dividers, and group boundaries.
- Portal nodes and their subcanvas affordances for drill-down diagrams.
- Canvas-level visual affordances such as the dark grid and selection states.

Current CLI support is narrower than the app's full visual surface, but link direction, line color, diagram lines, section dividers, group boundaries, portal nodes, and portal-node subcanvas links are exposed. Subcanvases live on portal nodes. Direction values are `directed`, `undirected`, and `bidirectional`. Color is a string passed to the bridge, such as a hex color or named color supported by the app. Treat direction, color, diagram lines, dividers, groups, portals, and subcanvases as semantic tools, not decoration.

Agents should not promise direct edits to:

- Node color, fill, border, radius, width, height, or typography.
- Canvas background, grid density, theme, or chrome.
- Manual link bend points or label anchors.
- Icons, badges, or arbitrary custom shapes beyond lines, structured dividers, and group boundaries.

When a desired improvement requires unsupported styling, either express it as a recommendation or approximate it with supported changes such as node placement, link direction, link color, label text, diagram lines/dividers/groups, link creation/deletion, and clearer node content.

## Choosing Canvas Objects

Choose objects by what the reader needs to understand, not by decoration:

- Use **note nodes** for durable concepts with markdown explanation, implementation notes, references, tags, or graph links. If the concept already exists, update or move the existing node instead of creating a duplicate.
- Use **portal nodes** for node-level drill-down. A portal should be a clear navigational entry point to another canvas, not a markdown note with extra content.
- Use **canvases** as new detail spaces when the current canvas would become crowded or when a subsystem deserves its own navigable view. Create the canvas first, then create a portal to it.
- Use **links** when the relationship itself matters visually. Direction should encode flow, ownership, dependency, causality, or write direction. If a relationship is incidental or only explanatory, prefer concise node content over another edge.
- Use **group boundaries** for clusters that should be read as one subsystem, ownership zone, lifecycle phase, or concern. Groups work best around several nearby nodes with enough padding.
- Use **dividers** for broad rows or columns. They should separate lanes such as Clients, Control plane, Processing, Storage, Live sync, Restore, Audit, or External systems.
- Use **arbitrary lines** sparingly for precise separators, thresholds, or callouts that are not well represented by a full lane or group boundary.
- Use a **portal node** when a concept needs drill-down detail. Subcanvases live on portal nodes, so to open a subsystem's detail, place a portal node for it.

## Codebase Architecture Maps

A codebase map should compress source code into maintainable architecture, not redraw the call graph. The test is whether a maintainer can open a node and understand what this part owns, where to look in code, and what can break when it changes.

Before drawing, gather evidence from the repository:

- Inventory package manifests, app or CLI entrypoints, framework boot files, route/command registration, generated-code boundaries, config loading, persistence/schema files, external clients, tests, and operational scripts.
- Trace one or two representative user/runtime flows end to end, such as request handling, command execution, sync, render, import/export, or startup.
- Identify the boundaries where data changes form, authority changes hands, state is stored, side effects happen, or errors are normalized.
- Prefer direct file evidence over inferred architecture. If a claim is uncertain, mark it as an open question in the node.

Create a node for:

- A runtime entrypoint or orchestrator that controls lifecycle, routing, or registration.
- A subsystem with coherent ownership, such as auth, rendering, search, sync, persistence, billing, command handling, or extension loading.
- A data/state boundary: database schema, cache, queue, filesystem store, in-memory state owner, serialized document format, or API model.
- An integration boundary: external API client, native bridge, plugin host, worker process, shell command, or network protocol.
- A policy boundary: permission check, validation layer, conflict resolver, retry logic, error normalization, migration, or feature flag decision.
- A build/test/deployment concern only when it materially affects runtime behavior or maintainer workflow.

Avoid nodes for:

- Files, functions, methods, classes, or folders that do not own a distinct architectural responsibility.
- Helper utilities whose behavior is obvious and local.
- One-off call edges that do not represent ownership, data flow, lifecycle flow, or policy.
- Exhaustive file inventories; put those in node markdown or subcanvas detail instead.
- Duplicate nodes for the same concept under different filenames.

### Codebase Node Markdown

Every note node in a codebase map should be useful when opened. Use compact markdown with concrete evidence:

```markdown
**Role:** Owns command registration and delegates each command to the bridge client.

**Evidence**
- `src/index.ts` builds the CLI program and registers command modules.
- `src/commands/*.ts` define command surfaces and request paths.
- `test/cli.test.ts` verifies each command maps to the expected bridge endpoint.

**Flow:** CLI args -> command module -> `BridgeClient.request()` -> Enso app bridge.

**Invariants**
- Selectors must be encoded before they enter bridge URLs.
- Mutating commands expose dry-run behavior before applying.

**Change notes:** Adding a command usually requires a command module, registration in the entrypoint, README coverage, and endpoint tests.
```

Adapt the headings to the codebase, but keep these facts present: responsibility, code anchors, inputs/outputs, neighbors, invariants, and change risk. Avoid markdown that only lists function calls; function names are useful only when they support a higher-level claim.

## Design Goals

An Enso diagram should make the primary read obvious in a few seconds, then reward deeper inspection. Prefer calm structure over dense completeness.

The visible viewport is not a fixed artboard. Users can zoom out and navigate around the canvas, so agents should not shrink or compress a diagram merely to make every node fit in one screenshot. A larger, well-spaced diagram is better than a cramped single-screen diagram.

Optimize for:

- Clear left-to-right or top-to-bottom flow.
- Distinct conceptual clusters.
- Minimal edge crossings.
- Consistent spacing and alignment.
- Adequate whitespace, even when that requires a larger canvas.
- Short, readable node titles and link labels.
- A visible focal path through the system.
- Direction that reinforces the graph semantics.
- Line color that reinforces graph semantics.

Avoid:

- Equally weighted nodes when some are primary and others are supporting.
- Diagonal links that cut through unrelated regions.
- Large empty gaps that do not signal a meaningful boundary.
- Compressing clusters just to keep every node inside the current viewport.
- Edge labels squeezed against nodes or other labels.
- Decorative layout choices that make the technical relationship harder to parse.

## Viewport Anchoring

All `x/y` are world-space coordinates referring to the element **center** (ADR-0003); there is no viewport-relative placement. Always anchor to the live viewport — never invent absolute origins.

1. Run `enso context --canvas current --vision --pretty` and read `data.vision.viewport.visibleRect` (`x`, `y`, `width`, `height`) and `scale`.
2. Viewport center: `cx = x + width/2`, `cy = y + height/2`.
3. Lay the diagram out around `(cx, cy)` in world units.

Keep it compact so the whole diagram frames at one zoom (target 0.5–1.0x, never force 0.2x). Nodes are ~`220 x 140` world units:

- Column step ~`450`, row step ~`280` between centers is plenty; a 2x3 grid then spans only ~`900 x 700`.
- Do not use 1000+ unit gaps or absolute origins like `(1200, 800)` unrelated to the viewport — that scatters nodes off-camera and forces extreme zoom-out.
- Keep the cluster span well inside `visibleRect` (≤ 60–70% of `width`/`height`) so it reads without panning.

Place atomically with `enso node create --x --y` (sets the center on creation) rather than create-then-`node move`, which avoids the gap where a move cannot resolve a node that does not yet exist.

```sh
# viewport center cx,cy; 2x3 grid, steps 450/280; cols cx-225, cx+225; rows cy-280, cy, cy+280
enso node create --title "A" --x "$((CX-225))" --y "$((CY-280))" --dry-run
enso node create --title "B" --x "$((CX+225))" --y "$((CY-280))" --dry-run
```

## Layout Patterns

For system architecture, use columns:

- Entry points and clients on the left.
- Identity, routing, or control-plane services near the center.
- Core processing and authorization in the center-right.
- Persistence, logs, databases, and external systems on the right.

For data flow, arrange the dominant path in a straight horizontal or vertical spine. Place side effects, audits, caches, and optional branches above or below that spine.

For authorization diagrams, keep identity and entitlement checks visually near the protected operation. Do not strand auth nodes far away from the decision they control.

For restore or sync diagrams, separate live paths from bootstrap or recovery paths by row. Use labels to distinguish "live updates", "snapshot", "hydrate", "replay", and "audit".

Use canvas scale intentionally. If a diagram has many subsystems, let it occupy more than one viewport and make each region readable. Prefer panning/zooming over reducing spacing below comfortable reading distance.

## Visual Hierarchy Without Styling

Because the current bridge cannot style individual nodes, use layout and text to create hierarchy:

- Put the most important path in the clearest row or column.
- Give primary nodes central positions with more whitespace.
- Move secondary nodes to the periphery.
- Use shorter titles for primary nodes.
- **Never add an overview / summary / title note** when the canvas name already identifies the diagram. That duplicates the canvas tab and often masquerades as a pipeline step. Use canvas name, group titles, dividers, and portal labels for hierarchy instead.
- Avoid making any remaining title-like node look like a processing step unless it participates in the graph.
- If a large database or storage concept dominates the diagram, place it as a terminal layer on the right or bottom rather than as a random oversized destination.

## Grouping

Cluster related nodes by proximity and alignment. Leave a slightly larger gap between clusters than within clusters.

Common clusters:

- Client surfaces.
- Authentication and identity.
- Entitlements and authorization.
- Sync relay or request processing.
- Storage and persistence.
- Catalog, hydrate, or restore flows.
- Observability, audit, and operational side effects.

Do not rely on link labels alone to communicate grouping. The layout should make categories visible before the text is read.

Use structured dividers and group boundaries when proximity alone is not enough:

- Use arbitrary lines for precise separators or callouts that need endpoints rather than a full swimlane.
- Use horizontal dividers for row-based sections such as Identity, Live sync, Persistence, Restore, or Audit.
- Use vertical dividers for left-to-right architecture columns such as Clients, Control plane, Processing, and Storage.
- Use group boundaries for subsystem ownership or a lifecycle phase that contains several nodes.
- Keep these primitives subtle and sparse; a few clear sections are better than a ruled-up canvas.
- Do not use dividers to compensate for cramped spacing. Fix spacing first, then add section aids.

Use subcanvases for progressive disclosure:

- Create a portal node when a subsystem or concept needs useful implementation detail.
- When a whole cluster deserves a detailed follow-up diagram, add a portal node for it; subcanvases live on portal nodes.
- Prefer a subcanvas over adding every file, table, endpoint, or edge case to the overview.
- Keep the portal title high level; put the detailed mechanics in the subcanvas.

## Edges And Labels

Good links are boring. They should quietly explain relationships without becoming the main visual event.

Prefer:

- Directed arrows for causal flow, request flow, ownership, dependency, or write direction.
- Undirected or visually neutral links only for symmetric association, membership, or loose reference.
- Colored lines for semantic classes such as auth, sync, persistence, restore, audit, error, or optional paths.
- Curved or Bezier links when they reduce visual collisions or create a more graceful path around nodes.
- Short canvas link labels (one to three words). Bound relation lines are separate; use `link update --bound-line` for custom prose with the target wikilink, not `--sync-prose` when prose should differ from the label.
- Consistent verbs for similar relationships.
- Mostly horizontal or vertical paths when node placement can create them.
- Labels placed in whitespace, away from node borders.
- Fewer links when content inside a node can explain secondary details.

Avoid:

- Labels that wrap awkwardly or collide with nodes.
- Multiple long labels in the same small area.
- Crossing links between unrelated subsystems.
- Links that pass through the visual center of unrelated nodes.
- Redundant links that state relationships already obvious from sequence.
- Using many unrelated colors without a legend or obvious repeated meaning.

Suggested color semantics:

- Auth or identity: blue.
- Authorization or policy: violet.
- Sync or live traffic: green.
- Persistence or storage writes: amber.
- Restore, hydrate, or bootstrap: cyan.
- Audit, logging, or operational side effects: gray.
- Failure, rejection, or risk paths: red.

Keep the palette small. Three or four meaningful link colors are usually enough.

## Diagnostics And Fix Order

`enso context --canvas current --vision --pretty` returns `vision.diagnostics` with `metrics` and `issues`. Inspect both the PNG at `data.vision.image.path` and the issues — do not rely on diagnostics alone; screenshot gestalt still judges clarity, hierarchy, and readability.

Fix issues in this order:

1. Overlapping nodes first (`node_overlap`).
2. Label problems (`label_offscreen`, `link_label_overlap`).
3. Link paths crossing unrelated nodes (`link_node_intersection`) — reroute or move nodes.
4. Unnecessary link crossings (`link_crossing`).
5. Cramped nodes (`low_node_gap`) — add whitespace.

Treat `node_offscreen` as an issue only when a node is accidentally clipped in the intended viewport, or when the task explicitly asks for a single-screen overview. Otherwise prefer a navigable canvas over squeezing everything into view.

`diagnostics.ok: true` means the deterministic checks are clean enough for v1, but still inspect the screenshot for balance, grouping, readable labels, and line tangles before finalizing.

Iterative layout loop (use typed commands, not `apply` patches):

1. `enso context --canvas current --vision --pretty`.
2. Open the PNG and read `vision.diagnostics.metrics` plus `issues`.
3. Make the smallest fix with a typed command: `enso node move <selector> --x --y` to reposition; `enso diagram update <id>` to resize/move a group, divider, or line (dry-run first).
4. Recapture with `enso context --canvas current --vision --pretty`.
5. Repeat until blocking diagnostics are gone and the screenshot communicates the idea clearly.

## Review Checklist

Before finalizing a diagram:

1. Capture `enso context --canvas current --vision --pretty`.
2. Inspect the screenshot, not only diagnostics.
3. Confirm the visible region has a clear local story; do not require the entire canvas to fit in one viewport unless the user asked for that.
4. Check that clusters are obvious from position.
5. Check that arrows point in the direction a reader would expect.
6. Check that line colors repeat with consistent meaning.
7. Check that edge crossings and diagonal lines are justified.
8. Check labels for collisions, cramped placement, and unclear verbs.
9. Run a dry-run patch before applying any layout or graph changes.
10. Recapture and compare the new screenshot.

If diagnostics are clean but the screenshot still feels bad, trust the screenshot. Diagnostics catch mechanical issues; they do not fully judge composition, hierarchy, or taste.

If diagnostics report offscreen nodes, distinguish accidental clipping from intentional canvas scale. Offscreen nodes are acceptable when the diagram is designed for navigation and the visible region remains composed.
