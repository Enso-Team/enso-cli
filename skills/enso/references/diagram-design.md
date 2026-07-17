# Enso Diagram Design

Read this reference after the verified Canvas pass reaches visual context and before choosing or repairing geometry.

## Choose a Pattern

Start with the relationship the reader must see first.

- Use a horizontal or vertical spine for a dominant request, data, lifecycle, or control flow. Put side effects and optional branches beside the spine.
- Use columns for layered systems: entry surfaces, control or policy, core processing, then persistence or external systems.
- Use rows when parallel modes must remain distinct, such as live operation versus restore, or success versus failure handling.
- Use compact clusters when ownership or concern matters more than sequence. Separate clusters with more whitespace than their internal spacing.
- Use a Portal to move implementation detail to another Canvas when adding that detail weakens the primary read.

The chosen pattern is complete when a reader can identify the starting point, dominant direction, and major boundaries without opening Node content.

## Choose Objects

- Notes carry durable concepts and evidence.
- Portals carry navigation to detail Canvases.
- Links carry relationships whose direction or existence matters visually.
- Regions carry subsystem, ownership, phase, or concern boundaries around several nearby elements.
- Dividers carry broad lanes or columns.
- Lines carry precise separators, thresholds, or callouts.

Prefer content inside a Note when a relationship is explanatory rather than structural. Prefer proximity before adding a boundary, and prefer a region or divider only when proximity does not communicate the grouping. Object selection is complete when every element has one semantic job.

## Place Geometry

All `x` and `y` values are world-space element centers. Read `data.vision.viewport.visibleRect` and the element geometry in the context `nodes` and `diagramPrimitives` sections; anchor the new arrangement to the viewport center or to nearby inspected elements. Preserve readable whitespace and allow a coherent diagram to extend beyond one viewport.

Align the dominant path, then place secondary branches. Keep related elements closer to one another than to neighboring clusters. Derive region bounds from the actual outer bounds of their contents plus visible padding. Put final geometry on creates so the applied state never depends on a follow-up move.

Placement is complete when every new object has final geometry, clusters have distinct gaps, region bounds contain their members, and the intended viewport has no accidental clipping.

## Build Hierarchy and Groups

Put the primary path in the clearest row or column and give it the most direct Links. Move supporting systems, audits, caches, and optional paths to the periphery. Keep primary titles short. Let the Canvas name, region titles, divider titles, and Portal labels provide orientation; add a Note only when it represents a real concept in the graph.

Use regions around several elements that form one subsystem or phase. Give each region an intentional color and low fill opacity. Use one color per semantic class, reusing it only when groups share meaning, and keep Nodes and Links in the foreground. Use dividers for lanes that span multiple clusters. Add primitives after the Nodes they organize have stable geometry, and keep them sparse enough that the graph remains the foreground.

Hierarchy is complete when the screenshot has one obvious focal path, each group remains understandable without relying on Link labels alone, and every region has a semantic color.

## Shape Links

Use direction for flow, ownership, dependency, causality, or writes; use a neutral relationship for symmetric association. Use short, consistent predicates for labels. Assign color only when it encodes a repeated semantic class in this diagram, and keep the number of classes small enough to remain learnable from repetition or a legend.

Place Nodes so Links travel mostly horizontally or vertically through whitespace. Reduce unnecessary Links before moving Nodes to accommodate them. Link design is complete when direction matches the domain, labels remain readable, and no Link passes through an unrelated Node.

## Diagnose and Repair

Inspect both the image at `data.vision.image.path` and `data.vision.diagnostics`. Diagnostics find mechanical faults; the screenshot reveals hierarchy, grouping, balance, and confusing tangles.

Repair in this order:

1. `node_overlap`
2. `label_offscreen` and `link_label_overlap`
3. `link_node_intersection`
4. `link_crossing`
5. `low_node_gap`

Treat `node_offscreen` as blocking when clipping is accidental in the intended viewport or the user requests a single-screen overview. A navigable multi-viewport Canvas may contain intentionally offscreen elements.

For each repair, choose the smallest typed geometry change that addresses the highest-priority remaining issue. Dry-run it, apply it, and recapture vision before choosing another change. Prefer moving a Node or updating a primitive from inspected IDs and coordinates; let the resulting screenshot determine the next repair.

Repair is complete when blocking diagnostics are absent, the screenshot has a clear focal path and grouping, labels are legible, Links avoid unrelated Nodes, and the change introduces no new higher-priority issue.
