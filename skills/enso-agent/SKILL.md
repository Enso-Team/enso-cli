---
name: enso-agent
description: Enso canvas edits through the local `enso` CLI — batch `canvas apply` or atomic commands. Use when the user wants to diagram, map, visualize, or build an architecture map on an Enso canvas; or inspect or mutate an Enso vault, canvas, or node.
---

# Enso Agent

## Default Edit Path

When the user asks to diagram, map, or visualize something, edit an Enso **Canvas** through the bridge — never edit `Canvases/*.json` directly.

Batch with `enso canvas apply <file.json>`. One JSON file replaces dozens of per-element CLI calls.

1. `enso status --pretty`. If `app_unavailable`, ask the user to launch Enso and pair with `enso auth link`.
2. Derive a canvas title from the request (e.g. "auth flow" → `"Auth Flow"`). Open it, or create it if missing. Ask when the target canvas is ambiguous.
   ```sh
   enso canvas open "Auth Flow"            # if this returns not_found, create it first:
   enso canvas create "Auth Flow" && enso canvas open "Auth Flow"
   enso context --canvas current --pretty
   ```
3. When placement matters, run once: `enso context --canvas current --vision --pretty`. Read `data.vision.viewport.visibleRect` and compute every `x`/`y` before writing JSON (see Placement).
4. Write a descriptive JSON file (e.g. `auth-flow.json`) with explicit geometry on every new node, region, divider, and line:
   ```json
   {
     "canvas": "Auth Flow",
     "nodes": [
       { "kind": "note", "title": "Source", "content": "Markdown body", "x": 18300, "y": 18200 },
       { "kind": "existing", "title": "Existing Note", "x": 18600, "y": 18200 },
       { "kind": "portal", "title": "Detail", "subcanvasRef": "Canvases/Detail.json", "x": 18900, "y": 18200 }
     ],
     "links": [
       { "source": "Source", "target": "Existing Note", "direction": "directed", "label": "feeds" }
     ],
     "regions": [
       { "title": "Runtime", "x": 18600, "y": 18200, "width": 1200, "height": 700 }
     ],
     "dividers": [
       { "title": "Control plane", "orientation": "horizontal", "x": 18600, "y": 18020, "length": 1600 }
     ],
     "lines": [
       { "title": "Section split", "x1": 18600, "y1": 18400, "x2": 19800, "y2": 18400 }
     ]
   }
   ```
5. Dry-run once: `enso canvas apply auth-flow.json --dry-run`.
6. Apply once: `enso canvas apply auth-flow.json`.
7. Verify once with the **smallest** context that answers the question:
   - After a fresh build: `enso context --canvas current --pretty` only.
   - `data.canvas.nodes` / `data.canvas.links` / `data.canvas.diagramPrimitives` are integer **counts** (the full arrays live at `data.nodes` etc.). Done when the counts match intent and apply returned `ok: true`.
   - Use `--vision` only when fixing layout, overlap, or diagnostics — not for a post-apply count check on a canvas you just built.
   - Do not re-read, grep, or paginate vision or agent-tools output files after apply. Do not run a second verify pass.

Done when `data.canvas` counts match and apply succeeded. Trust the dry-run + apply envelope; do not grep CLI output files to confirm.

`canvas apply` compiles JSON into bridge operations and applies them in three ordered batches: nodes/portals, links, DiagramPrimitives. It does not compute layout — missing `x`/`y` on a new node fails validation. Omit coordinates only on nodes that already exist on the canvas and should stay put.

## When Not To Use `canvas apply`

- Canvas JSON: never edit `Canvases/*.json` directly.
- One surgical edit: use atomic commands with `--dry-run`, then without `--dry-run`.
- Unsupported bridge operations: use `enso apply patch.json --dry-run`, then `enso apply patch.json`.
- Mermaid sequence diagrams: use deterministic import when available (`enso import sequence`). Do not manually convert Mermaid syntax into nodes and edges.

## Invariants (never violate)

1. Mutate only through the Enso bridge. Never edit vault files directly.
2. One canvas per build pass. Verify before opening another canvas.
3. Links cannot bind to nodes created in the same apply patch. `canvas apply` enforces nodes → links → DiagramPrimitives; with raw `apply`, split patches the same way.
4. Selectors can be UUIDs, vault-relative refs, or titles. On `ambiguous_selector`, stop and choose from returned candidates; do not guess.
5. Safe titles only: no `/`, `:`, `?`, `#`, URL schemes, or pre-encoded path fragments. Put real file paths and URLs in node content.
6. Every hand-placed coordinate is viewport-anchored. Read `visibleRect`, set `cx = x + width/2` and `cy = y + height/2`, lay out around `(cx, cy)` with `colStep=450` and `rowStep=280`; never invent an absolute origin.
7. Give every region, divider, and line a `title` — it is the only key `canvas apply` uses to dedupe primitives, so untitled ones are re-created (duplicated) on each re-apply.
8. Link `source`/`target` must match the exact string used as a node's `title` (for existing nodes, the context's `displayTitle`); otherwise the link is created fresh instead of deduped.

## What To Create When

- Do not create title, overview, or summary nodes. Canvas name, portal titles, region labels, and node content carry context.
- Note nodes: durable concepts with markdown, refs, tags, or evidence.
- Existing notes: `{ "kind": "existing", ... }` when the note already exists.
- Portal nodes: drill-down entry points; never write markdown to nodes whose context says `kind: "portal"`.
- Links: visible flow, ownership, dependency, causality, or writes.
- Regions: clusters read as one subsystem, phase, owner area, or concern.
- Dividers: broad lanes (Clients, Control plane, Processing, Storage, etc.).
- Lines: precise separators or callouts a divider/region cannot express.

Bridge does not expose node styling, custom edge routing, background themes, icons, or arbitrary shapes beyond DiagramPrimitives.

## Placement

Agents compute layout before writing JSON. The CLI forwards coordinates; it does not auto-layout.

1. Ground once with `--vision` and read `visibleRect`.
2. Anchor at viewport center `(cx, cy)`.
3. Space nodes with `colStep=450`, `rowStep=280` (world-space element centers).
4. Put final `x`/`y` on every create in JSON — do not create then move.
5. For regions/dividers: bbox from enclosed node centers ± half node size (~110×70) + ~40px pad (center coords per ADR-0003). Do not pin region `y` to one row in a multi-row layout. Prefer `enso primitive region` after nodes exist if unsure.

For atomic commands or raw `apply`, follow the same anchoring recipe. Read `references/diagram-design.md` for layout patterns, regions, edge semantics, and diagnostics fix order.

## Diagram & Codebase-Map Detail

Read `references/diagram-design.md` before diagram design work, codebase architecture maps, or layout repair. When layout matters, inspect both the PNG path and `diagnostics`; do not use diagnostics alone.

## Common Commands

```sh
enso status --pretty
enso context --canvas current --pretty
enso context --canvas current --vision --pretty
enso search "query" --pretty
enso node read "Title" --pretty
enso canvas apply auth-flow.json --dry-run
enso canvas apply auth-flow.json
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
enso primitive line --x1 17800 --y1 18100 --x2 19400 --y2 18100 --title "Control plane" --color "#6B7280" --dry-run
enso primitive divider --orientation horizontal --x 17800 --y 18100 --length 1600 --title "Live sync" --color "#6B7280" --dry-run
enso primitive region --x 18300 --y 18300 --width 1200 --height 700 --title "Persistence + Restore" --color "#6B7280" --dry-run
enso primitive update "primitive-id" --x 18300 --y 18300 --width 1200 --height 700 --dry-run
enso canvas delete "Old Canvas" --dry-run
```
