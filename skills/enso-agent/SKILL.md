---
name: enso-agent
description: Work with Enso canvases through the local Enso CLI, including safe context gathering, dry-run mutations, diagram layout, viewport screenshots, diagnostics, links, groups, dividers, portal nodes, and subcanvases.
---

# Enso Agent

Use this skill when working with an Enso vault through the local `enso` CLI.

## Workflow

1. Run `enso status` first. If it returns `app_unavailable`, ask the user to launch the Mac Catalyst Enso app and pair with `enso auth link`.
2. Use selectors carefully. A node selector can be a UUID, vault-relative ref, or title. A canvas selector can be an id, path, or name.
3. Treat `ambiguous_selector` errors as a request to choose from the returned candidates. Never guess between ambiguous titles.
4. Use `enso context` before edits so changes are grounded in the current canvas or node neighborhood. Use `enso context --canvas current --vision --pretty` when visual layout, sizing, overlap, link routing, or node positioning matters.
5. Use `enso search` and `enso node neighbors` for discovery.
6. Use `--dry-run` before mutating commands.
7. Use `enso apply --dry-run` for multi-step patches, then `enso apply` only after validation succeeds.
8. Never edit Enso vault files directly. Mutations must go through the Enso app bridge.
9. For diagram design work, including codebase architecture maps, read `references/diagram-design.md` before proposing or applying layout changes.

## Current Design Surface

The Enso app visual surface includes directed relationship arrows, link labels, colored relationship lines, arbitrary diagram lines, structured section dividers, group boundaries, portal nodes, and group subcanvas links. The current CLI/app bridge can create, write, move, and delete note nodes; create, open, retarget, and delete portal nodes; create and delete links; update link canvas labels, direction, and line color; optionally sync bound relation prose with `--sync-prose`; create/update/delete diagram lines, dividers, and group boundaries; attach, detach, create, and open subcanvases from diagram primitives; and create or open canvases. The current CLI schema does not expose node styling, custom edge routing, or background themes. Do not promise or attempt those styling changes unless the active bridge exposes fields for them.

**Links:** Use `link create`, then `link update --label` for a short canvas predicate. Use `link update --bound-line` for custom relation prose in the source note (must include the target wikilink anywhere in the line). Do not use `--sync-prose` when canvas label and note prose should differ. `--label` does not rewrite note markdown. Avoid `node write` on link sources unless editing non-relation body. Do not create the same edge twice.

Use portal nodes or diagram primitive subcanvas links when a concept needs drill-down detail without crowding the main canvas. Create or open node-level drill-downs with `portal create`, `portal open`, and `portal change-subcanvas`. Attach existing subcanvases to diagram primitives with `diagram attach-subcanvas`, create new empty detail canvases for primitives with `diagram create-subcanvas`, and open them with `diagram open-subcanvas`. Prefer portals and subcanvases over adding many low-level implementation nodes to an already dense overview. Do not write markdown content to nodes whose context output has `kind: "portal"`.

## What To Create When

Use the smallest canvas object that communicates the structure clearly:

- Create a **note node** with `enso node create` or `node.create` for a durable concept that needs markdown content, tags, refs, links, or explanation. Prefer editing an existing note when the concept is already present.
- Create a **portal node** with `enso portal create` or `portal.create` when a concept needs a drill-down canvas. Portals are navigation objects; do not put markdown content in them.
- Create a **canvas** with `enso canvas create` or `canvas.create` before creating a portal when the target detail canvas does not already exist.
- Create a **link** with `enso link create` or `link.create` when two nodes have a meaningful relationship the reader should see spatially. Use direction for flow, ownership, dependency, writes, or causality; use labels for non-obvious relationships.
- Create a **group boundary** with `enso diagram group` or `group.create` when several nearby nodes form a subsystem, ownership area, lifecycle phase, or concern that benefits from a visible boundary.
- Create a **divider** with `enso diagram divider` or `divider.create` for broad horizontal or vertical lanes such as Clients, Control plane, Processing, Storage, Live sync, Restore, or Audit.
- Create an **arbitrary line** with `enso diagram line` or `line.create` only for a precise separator or callout that a group or divider cannot express cleanly.
- Create or attach a **diagram primitive subcanvas** when a whole group, divider, or line represents detail worth opening. Use a portal instead when the drill-down belongs to a node-level concept.

## Codebase Maps

When mapping a codebase, the diagram is only useful if each node is an architectural explanation backed by code evidence. Before creating nodes, inspect the repository structure, package manifests, app entrypoints, route/command registration, persistence/schema definitions, external integration clients, shared state, and tests. Use `rg --files`, `rg`, package scripts, and relevant source reads to form a small set of architectural claims before drawing.

Create nodes for concepts a maintainer would use to navigate or change the system: runtime entrypoints, subsystem boundaries, data/state ownership, request or command pipelines, persistence boundaries, external service integrations, plugin/extension points, background workers, and cross-cutting concerns such as auth, configuration, errors, logging, or caching. Do not create a node merely because a file, class, function, or call exists. A low-level symbol deserves a node only when it owns a meaningful boundary, policy, lifecycle transition, or failure mode.

Every codebase-map note node must contain useful markdown, not just a call list. Include:

- **Role:** what responsibility this part owns in the system.
- **Evidence:** concrete files, functions, commands, schemas, or tests that prove the claim.
- **Flow:** what enters, what leaves, and which neighboring nodes it depends on or feeds.
- **Invariants:** assumptions, constraints, lifecycle rules, or error cases a maintainer must preserve.
- **Change notes:** where to edit safely, what breaks if the boundary changes, or open questions if the code is ambiguous.

Use links for architectural relationships such as "registers", "calls", "persists", "validates", "publishes", "loads config", or "handles errors". If a relationship needs a long explanation, put the explanation inside the relevant node markdown and keep the visible link label short. Use portals or group subcanvases for drill-downs when a subsystem needs file-level detail.

## Diagram Review Workflow

When creating or improving a technical diagram, request visual context with `enso context --canvas current --vision --pretty`. Inspect both the PNG at `data.vision.image.path` and `data.vision.diagnostics`; do not rely on diagnostics alone because screenshot gestalt still matters for clarity, hierarchy, and readability.

A good diagram should communicate the technical concept clearly, keep related nodes visually grouped, minimize overlapping links and nodes, preserve enough whitespace around nodes, and make link direction/meaning easy to follow. The current vision capture is a viewport sample, not a requirement that every node must fit on screen at once. Users can zoom and pan; do not compress a diagram just to satisfy the visible viewport. Use the screenshot to judge whether the visible region reads well, then use structured node bounds and diagnostics issue subjects to plan precise node moves or link edits.

Use structured diagram primitives when they improve readability:

- Use `diagram.divider` or `divider.create` for horizontal/vertical swimlane separators such as Identity, Live sync, Persistence, Restore, or Control plane.
- Use `diagram.line` or `line.create` for a precise arbitrary separator or callout line when a divider is too constrained.
- Use `diagram.group` or `group.create` for light semantic boundaries around clusters when node spacing alone is not enough.
- Keep lines, dividers, and groups subtle. They should clarify hierarchy and sections, not replace good node placement or clean links.
- Prefer group boundaries over a pile of ad hoc lines when communicating ownership, lifecycle phase, or subsystem scope.

Fix diagram-quality issues in this order:

1. Fix overlapping nodes first (`node_overlap`).
2. Fix label problems next (`label_offscreen`, `link_label_overlap`).
3. Reroute or move nodes for link paths crossing unrelated nodes (`link_node_intersection`).
4. Reduce unnecessary link crossings (`link_crossing`).
5. Increase whitespace around cramped nodes (`low_node_gap`).

Treat `node_offscreen` as an issue only when a node is accidentally clipped in the intended viewport or when the task explicitly asks for a single-screen overview. Otherwise, prefer adequate spacing and a navigable canvas over squeezing everything into view.

Use an iterative loop for layout work:

1. Run `enso context --canvas current --vision --pretty`.
2. Open or attach the PNG path and read `vision.diagnostics.metrics` plus `vision.diagnostics.issues`.
3. Draft a minimal patch and run `enso apply --dry-run`.
4. Apply the patch with `enso apply`.
5. Recapture with `enso context --canvas current --vision --pretty`.
6. Repeat until blocking diagnostics are gone and the screenshot visually communicates the idea clearly.

`diagnostics.ok: true` means the deterministic checks are clean enough for v1, but still inspect the screenshot for visual balance, node grouping, readable labels, and excessive line tangles before finalizing.

## Common Commands

```sh
enso status --pretty
enso context --canvas current --pretty
enso context --canvas current --vision --pretty
enso search "query" --pretty
enso node read "Title" --pretty
enso node write "Title" --content @note.md --dry-run
enso portal create --title "Sync Server Detail" --subcanvas-ref "Canvases/Sync Server Detail.json" --dry-run
enso portal open "Sync Server Detail"
enso portal change-subcanvas "Sync Server Detail" "Canvases/Existing Detail.json" --dry-run
enso link create "Source" "Target" --direction directed --color "#3B82F6" --dry-run
enso link update "link-id" --label supports --dry-run
enso link update "link-id" --bound-line "Longer prose anywhere before [[Target Title]]"
enso link update "link-id" --sync-prose
enso diagram line --x1 17800 --y1 18100 --x2 19400 --y2 18100 --title "Control plane" --color "#6B7280" --dry-run
enso diagram divider --orientation horizontal --x 17800 --y 18100 --length 1600 --title "Live sync" --color "#6B7280" --dry-run
enso diagram group --x 18300 --y 18300 --width 1200 --height 700 --title "Persistence + Restore" --color "#6B7280" --dry-run
enso diagram create-subcanvas "group-id" --name "Persistence Detail" --dry-run
```
