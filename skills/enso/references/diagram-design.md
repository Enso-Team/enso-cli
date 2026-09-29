# Enso Diagram Design

Read this reference before choosing geometry, appearance, or repairing an arrangement. First builds go through `enso canvas apply`. The agent picks world-space centers and an appearance per Node.

## Write the Notes

Each markdown file is the explanation of that Node. A reader who opens only that file should understand the part: what it is, what it does, and how it fits the picture. Write in prose. Do not use a Role / Evidence / Flow / Invariants template. A title with an empty or outline-only body is not done.

## Choose a Pattern

Start with the relationship the reader must see first.

- Use a horizontal or vertical spine for a dominant request, data, lifecycle, or control flow. Put side effects and optional branches beside the spine.
- Use columns for layered systems: entry surfaces, control or policy, core processing, then persistence or external systems.
- Use rows when parallel modes must remain distinct, such as live operation versus restore, or success versus failure handling.
- Use compact clusters when ownership or concern matters more than sequence. Separate clusters with more whitespace than their internal spacing.
- Use a Portal to move implementation detail to another Canvas when adding that detail weakens the primary read.

The chosen pattern is complete when a reader can identify the starting point, dominant direction, and major boundaries without opening Node content.

## Choose Objects

- Notes carry durable concepts.
- Portals carry navigation to detail Canvases.
- Links carry relationships whose direction or existence matters visually.
- Regions carry subsystem, ownership, phase, or concern boundaries around several nearby elements.
- Axis-aligned lines divide broad lanes or columns and mark precise separators, thresholds, or callouts.

Prefer content inside a Note when a relationship is explanatory rather than structural. Prefer proximity before adding a boundary, and prefer a region or line only when proximity does not communicate the grouping. Object selection is complete when every element has one semantic job.

## Choose Appearance

Give each Node an appearance that matches what it is. Set `appearance` on each place. Reuse one appearance for parts that are the same kind.

Card carries reading text. Symbols put a glyph above the title. Use People Symbols `user`, `developer`, and `client`, Systems Symbols `service`, `api`, `database`, `server`, `queue`, `cache`, `cloud`, `storage`, `external`, `auth`, and `loadBalancer`, and Product Symbols `mobileApp` and `component`. Stored `player` and `ux` values remain supported.

Shapes `decision` and `terminal` hold the title inside their outline and scale with the title. Choose them for branching and start/end points. Layout uses card spacing for diagrams containing Shapes or Cards, and compact symbol spacing when every member is a Symbol. `glyphSize: null` derives a Symbol's glyph size from its title font size.

Appearance is complete when a reader can tell what a Node is from its shape without opening it, and `card` is reserved for notes meant to be read as cards.

## Scale

One unit is the card title, 17 World points. Cards carry reading text at 17. Symbol Nodes carry diagram text at 14, the same size as a Link label, under an icon four titles tall, 56 points by default. The app derives the icon from the title, so a title change scales the icon with it and a spec never sets glyph sizes.

The design target is zoom 1, where text is native size. Seven symbol columns at the 200 step fit a Mac window there. Between 0.65 and 1 text still reads and a diagram up to about eleven columns fits. At the 0.4 floor titles drop out and only icons identify Nodes. Give members an appearance in the spec so `enso layout` uses symbol density: 140 by 82 blocks on 200 by 140 steps. A single card member sets card density, 220 by 140 blocks on 300 by 200 steps.

## Place Geometry

All `x` and `y` values are world-space element centers. On an empty Canvas, choose a coherent cluster of those centers. On an existing Canvas, read `data.vision.viewport.visibleRect` and the element geometry in the context `nodes` and `diagramPrimitives` sections; anchor the new arrangement to nearby inspected elements. Preserve readable whitespace and allow a coherent diagram to extend beyond one viewport.

Align the dominant path, then place secondary branches. Keep related elements closer to one another than to neighboring clusters. Derive region bounds from the actual outer bounds of their contents plus visible padding.

Placement is complete when every new object has final geometry and an appearance, clusters have distinct gaps, region bounds contain their members, and the intended viewport has no accidental clipping.

## Build Hierarchy and Groups

Put the primary path in the clearest row or column and give it the most direct Links. Move supporting systems, audits, caches, and optional paths to the periphery. Keep primary titles short. Let the Canvas name, region titles, line titles, and Portal labels provide orientation; add a Note only when it represents a real concept in the graph.

Use regions around several elements that form one subsystem or phase. Give each region an intentional color and low fill opacity. Use one color per semantic class, reusing it only when groups share meaning, and keep Nodes and Links in the foreground. Use axis-aligned lines for lanes that span multiple clusters. Add primitives after the Nodes they organize have stable geometry, and keep them sparse enough that the graph remains the foreground.

Hierarchy is complete when the arrangement has one obvious focal path, each group remains understandable without relying on Link labels alone, and every region has a semantic color.

## Shape Links

Use direction for flow, ownership, dependency, causality, or writes; use a neutral relationship for symmetric association. Use short, consistent predicates for labels. Assign color only when it encodes a repeated semantic class in this diagram, and keep the number of classes small enough to remain learnable from repetition or a legend.

Place Nodes so Links travel mostly horizontally or vertically through whitespace. Reduce unnecessary Links before moving Nodes to accommodate them. Link design is complete when direction matches the domain, labels remain readable, and no Link passes through an unrelated Node.

## Diagnose and Repair

Read `data.vision.diagnostics`. Diagnostics find mechanical faults. Repair against inspected `nodes[].position` and primitive geometry.

Repair in this order:

1. `node_overlap`
2. `label_offscreen` and `link_label_overlap`
3. `link_node_intersection`
4. `link_crossing`
5. `low_node_gap`

Treat `node_offscreen` as blocking when clipping is accidental in the intended viewport or the user requests a single-screen overview. A navigable multi-viewport Canvas may contain intentionally offscreen elements.

For each repair, choose the smallest typed geometry change that addresses the highest-priority remaining issue. Dry-run it, apply it, and recapture diagnostics before choosing another change. Prefer moving a Node or updating a primitive from inspected IDs and coordinates.

Repair is complete when blocking diagnostics are absent, the arrangement has a clear focal path and grouping, labels are legible, Links avoid unrelated Nodes, and the change introduces no new higher-priority issue.

## Placement and shared Notes

`canvas apply` and `layout --apply` report `placement` in dry-run, apply, and failure results. When `recentered` is true, the CLI translated the input by `dx` and `dy` World points, onto the empty-Canvas `home` when that field is present. Add the offset to input coordinates to get stored World coordinates. Follow-up `node move` and `primitive update` take those World coordinates.

Dry-run `sharedNoteWrites` lists the Notes the app may rewrite, with `sharedNoteWritesAssessment: "potential"`. A `fromNote` Link removal deletes the mentioning sentence from its source. A Link endpoint move rewrites the mention, and the app saves the Notes on both ends, before and after.
