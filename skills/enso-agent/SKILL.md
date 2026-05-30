---
name: enso-agent
description: Works with Enso canvases through the local `enso` CLI — context gathering, dry-run mutations, nodes, links, groups, dividers, portal nodes (drill-down subcanvases), diagram layout, viewport screenshots, and diagnostics. Use when the user wants to explain, map, visualize, or diagram something on an Enso canvas (node by node), or otherwise work with an Enso vault, canvas, node, or the `enso` CLI.
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
7. **Mutate with typed subcommands, one at a time** — `enso node create`, `enso node move`, `enso link create`, `enso diagram group/divider/line`, `enso diagram update`, `enso portal create`. This is the canonical authoring path; their schema is in `<cmd> --help`. `enso apply` (multi-op JSON patch) is an **escape hatch only** — use it when you must batch *and* have confirmed the exact patch schema; never hand-write a patch from memory.
8. Never edit Enso vault files directly. Mutations must go through the Enso app bridge.
9. For diagram design work, including codebase architecture maps, read `references/diagram-design.md` before proposing or applying layout changes.
10. For **Mermaid sequence diagrams**, do not parse or lay them out by hand. Use deterministic CLI conversion when available: `enso import sequence` (see enso-cli). The skill owns spatial diagram design, not Mermaid compilation.

## Invariants (never violate)

Hold on every run regardless of task; do not rely on the user's request to restate them.

1. **Open the target canvas, then confirm it, before any mutation.** `enso canvas open "<Name>"`, then `enso context --canvas current --pretty` and verify the returned name/id. Create/move act on the *current* canvas — never assume which is current.
2. **One canvas per build pass.** Fully build and verify a canvas before opening the next.
3. **Nodes before links, groups, and dividers.** A link/group can only reference nodes that already exist. Create nodes, verify them, then create links.
4. **Selectors must resolve to real elements.** Use a title, id, or vault ref the CLI actually wrote; read it back with `enso context` / `enso search`. Never invent a ref.
5. **Safe titles only.** No `/`, `:`, or other path/selector metacharacters — they break selectors and link matching. Use a plain title (`location api`, not `functions/api/location.js`); put the real path in the node body.
6. **Anchor every coordinate to the live viewport** (see Placement). Never hard-code absolute world origins.
7. **Verify after each canvas.** `enso context --canvas current --pretty` (add `--vision` for layout); confirm node count, targets, and links before moving on.

## Current Design Surface

The Enso app visual surface includes directed relationship arrows, link labels, colored relationship lines, arbitrary diagram lines, structured section dividers, group boundaries, portal nodes, and portal-node subcanvas links. The current CLI/app bridge can create, write, move, and delete note nodes; create, open, retarget, and delete portal nodes; attach, create, and open subcanvases on portal nodes; create and delete links; update link canvas labels, direction, and line color; optionally sync bound relation prose with `--sync-prose`; create/update/delete diagram lines, dividers, and group boundaries; and create or open canvases. A subcanvas is a normal canvas (a `Canvases/*.json`) that a portal node references via its `subcanvas-ref`. The portal node is one entry point to it (`enso portal open`); the subcanvas is also openable directly like any canvas (`enso canvas open "<name>"`). The current CLI schema does not expose node styling, custom edge routing, or background themes. Do not promise or attempt those styling changes unless the active bridge exposes fields for them.

**Links:** Use `link create`, then `link update --label` for a short canvas predicate. Use `link update --bound-line` for custom relation prose in the source note (must include the target wikilink anywhere in the line). Do not use `--sync-prose` when canvas label and note prose should differ. `--label` does not rewrite note markdown. Avoid `node write` on link sources unless editing non-relation body. Do not create the same edge twice. **Do not source interfile links from portal nodes** when you need bound note prose — portals have no markdown; use a note as source (often bidirectional back to the portal) or keep the edge canvas-label-only until portal-sourced links are supported. Keep canvas labels free of URL schemes (`finally://`); put schemes in note body or use a short label like `deep link`.

Use portal nodes when a concept needs drill-down detail without crowding the main canvas. Create or open node-level drill-downs with `enso portal create`, `enso portal open`, and `enso portal change-subcanvas`. A portal node is the on-canvas handle for a subcanvas; the subcanvas is a normal canvas reachable through the portal or directly via `enso canvas open`. Prefer portals over adding many low-level implementation nodes to an already dense overview. Do not write markdown content to nodes whose context output has `kind: "portal"`.

## What To Create When

Use the smallest canvas object that communicates the structure clearly:

- **Do not create overview, summary, or title nodes** on architecture diagrams. The canvas name is the title; high-level context belongs in the canvas name, portal titles, group labels, or the first substantive node — never a floating `* Overview` note wired into the graph.
- Create a **note node** with `enso node create` for a durable concept that needs markdown content, tags, refs, links, or explanation. Prefer editing an existing note when the concept is already present.
- Create a **portal node** with `enso portal create` when a concept needs a drill-down canvas. Portals are navigation objects; do not put markdown content in them.
- Create a **canvas** with `enso canvas create` before creating a portal when the target detail canvas does not already exist.
- Create a **link** with `enso link create` when two nodes have a meaningful relationship the reader should see spatially. Use direction for flow, ownership, dependency, writes, or causality; use labels for non-obvious relationships.
- Create a **group boundary** with `enso diagram group` when several nearby nodes form a subsystem, ownership area, lifecycle phase, or concern that benefits from a visible boundary.
- Create a **divider** with `enso diagram divider` for broad horizontal or vertical lanes such as Clients, Control plane, Processing, Storage, Live sync, Restore, or Audit.
- Create an **arbitrary line** with `enso diagram line` only for a precise separator or callout that a group or divider cannot express cleanly.
- Create a **portal subcanvas** with `enso portal create` / `enso portal change-subcanvas` when a concept deserves a drill-down canvas. Subcanvases live on portal nodes; use a portal whenever you want a drill-down.

## Placement (every build)

All `x/y` are **world-space, element-center** coordinates (ADR-0003); there is no viewport-relative placement. **Anchor to the live viewport; never invent absolute coordinates:**

1. `enso context --canvas current --vision --pretty` → read `data.vision.viewport.visibleRect` (`x`, `y`, `width`, `height`).
2. Center: `cx = x + width/2`, `cy = y + height/2`. Lay out around `(cx, cy)`.
3. Keep it compact (frames at 0.5–1.0x). Nodes ~`220 x 140`; column step ~`450`, row step ~`280`; keep total span ≤ 60–70% of `visibleRect`. No 1000+ gaps or absolute origins like `(1200, 800)`.
4. Place atomically with `enso node create --x --y` (sets center on creation; avoids the move-before-exists gap).

Full numeric recipe, layout patterns, and a worked example: `references/diagram-design.md` (Viewport Anchoring, Layout Patterns).

## Diagram & Codebase-Map Detail

For any diagram design, codebase architecture map, or layout review, read **`references/diagram-design.md`** before proposing or applying changes. It is the canonical source for:

- **Choosing canvas objects** — note vs portal vs canvas vs link vs group vs divider vs line.
- **Codebase maps** — what deserves a node, and the required node markdown (Role / Evidence / Flow / Invariants / Change notes).
- **Layout, hierarchy, grouping, edges/labels, color semantics.**
- **Diagnostics fix-order** (`node_overlap` → labels → `link_node_intersection` → `link_crossing` → `low_node_gap`), the `node_offscreen` nuance, and the iterative typed-command layout loop.
- **Review checklist** before finalizing.

When layout, sizing, overlap, link routing, or positioning matters, capture `enso context --canvas current --vision --pretty` and inspect both the PNG and `diagnostics` — never diagnostics alone.

## Common Commands

```sh
enso status --pretty
enso context --canvas current --pretty
enso context --canvas current --vision --pretty
enso search "query" --pretty
enso node read "Title" --pretty
enso node create --title "Title" --content @note.md --x 18300 --y 18300 --dry-run
enso node write "Title" --content @note.md --dry-run
enso node move "Title" --x 18300 --y 18300 --dry-run
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
enso diagram update "primitive-id" --x 18300 --y 18300 --width 1200 --height 700 --dry-run
```
