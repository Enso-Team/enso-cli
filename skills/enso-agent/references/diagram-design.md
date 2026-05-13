# Enso Diagram Design

Use this reference when creating, reviewing, or improving technical diagrams in Enso.

## Capability Contract

Through the current Enso CLI/app bridge, agents can:

- Create, write, move, and delete nodes.
- Create, open, retarget, and delete portal nodes for node-level drill-down canvases.
- Create and delete links.
- Set link labels, direction, and line color.
- Create, update, and delete arbitrary diagram lines, structured section dividers, and group boundaries.
- Attach, detach, create, and open subcanvas links from diagram primitives.
- Create, inspect, and open canvases.
- Capture viewport screenshots and structured vision diagnostics.

The Enso app visual surface includes:

- Directed relationship arrows.
- Colored relationship lines.
- Link labels.
- Arbitrary diagram lines, section dividers, and group boundaries.
- Portal nodes and group subcanvas affordances for drill-down diagrams.
- Canvas-level visual affordances such as the dark grid and selection states.

Current CLI support is narrower than the app's full visual surface, but link direction, line color, diagram lines, section dividers, group boundaries, portal nodes, and diagram primitive subcanvas links are exposed. Direction values are `directed`, `undirected`, and `bidirectional`. Color is a string passed to the bridge, such as a hex color or named color supported by the app. Treat direction, color, diagram lines, dividers, groups, portals, and subcanvases as semantic tools, not decoration.

Agents should not promise direct edits to:

- Node color, fill, border, radius, width, height, or typography.
- Canvas background, grid density, theme, or chrome.
- Manual link bend points or label anchors.
- Icons, badges, or arbitrary custom shapes beyond lines, structured dividers, and group boundaries.

When a desired improvement requires unsupported styling, either express it as a recommendation or approximate it with supported changes such as node placement, link direction, link color, label text, diagram lines/dividers/groups, link creation/deletion, and clearer node content.

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
- Avoid making a title or overview node look like another processing step unless it participates in the graph.
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
- Attach a subcanvas to a group boundary when the whole cluster deserves a detailed follow-up diagram.
- Prefer a subcanvas over adding every file, table, endpoint, or edge case to the overview.
- Keep the portal or group title high level; put the detailed mechanics in the subcanvas.

## Edges And Labels

Good links are boring. They should quietly explain relationships without becoming the main visual event.

Prefer:

- Directed arrows for causal flow, request flow, ownership, dependency, or write direction.
- Undirected or visually neutral links only for symmetric association, membership, or loose reference.
- Colored lines for semantic classes such as auth, sync, persistence, restore, audit, error, or optional paths.
- Curved or Bezier links when they reduce visual collisions or create a more graceful path around nodes.
- Short labels, usually one to three words.
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
