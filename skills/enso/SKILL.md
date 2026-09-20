---
name: enso
description: Use when someone needs to explain something in a visual way, or when they ask to do something in Enso.
---
# Enso

1. Check the intended Enso instance:

   ```sh
   enso status --pretty
   ```

   Continue on `ok: true`. If Enso isn't running, launch it and retry. If Local agent access is off, or the CLI and app are out of date, stop and tell the user, quoting `error.details.hint`.

2. Ask the app which folder it has open using

   ```sh
   enso vault current --pretty
   ```

   then write markdown there. Identity is the filename stem or the path relative to that folder.

   Write at `path`. Cwd is often some other workspace; use that path anyway.

   Each file is the explanation of that part. A reader who opens only that file should learn what it is, what it does, and how it fits. Write in prose. Do not use a Role / Evidence / Flow / Invariants template, and do not leave a title with an empty or outline-only body.

3. Before a first build, lint that folder. `enso check` takes the folder from `vault current`, never a single file, because wikilinks resolve across it. A `[[wikilink]]` inside backticks or a fenced block is text, not a link, so show syntax that way.

   ```sh
   enso check "<path>" --pretty
   ```

   Continue when `ok: true`. Place members must already exist as files.

4. Select one Canvas:

   ```sh
   enso canvas list --pretty
   ```

   Use `current` only when the user means the open Canvas. Create a missing Canvas only when the request authorizes it.

5. Read [references/diagram-design.md](references/diagram-design.md) before choosing geometry or appearance. Give each Node an appearance that matches what it is; `card` is only for a reading surface. All `x`/`y` values are world-space centers.

   On an empty Canvas, choose fresh coordinates. On a Canvas that already has elements:

   ```sh
   enso context --canvas current --vision --pretty
   ```

   Read `data.vision.diagnostics` and the element geometry in `nodes`, `links`, and `diagramPrimitives`. Anchor new placement to neighbors.

6. First build: write one temporary apply JSON (not in the Enso folder). Nodes are existing files, named by stem or folder-relative path, each with an appearance. The same intent carries the `links` and the `primitives`, so the first apply is the whole picture:

   - **Regions** (`primitives`, `kind: region`) around each cluster that forms one subsystem, layer, or phase. Give each a `title`, a `color`, and a low `fillOpacity` (0.06 to 0.12). Size it from its members' positions plus padding. A Canvas with more than one cluster and no region is unfinished.
   - **Direction on every Link** (`links[].direction`): `directed` for flow, dependency, ownership, or writes, pointing from the Note that mentions to the Note it mentions. `bidirectional` when each Note mentions the other and the relationship runs both ways. `undirected` only for a symmetric association. A Link with no `direction` draws an arrowhead at the target, which is right for flow and wrong for a symmetric pair, so say which it is.
   - **Colour on Links** (`links[].color`) by what the Link means: one colour per semantic class (data flow, control, identity, fallback), reused only when Links share meaning. A Link with no `color` takes the ink colour, which is right for the primary path and wrong for everything that should read as secondary.
   - **Lines** (`kind: line`) only for a lane divider or a callout that a region cannot express.

   Colours come from the schema's list: `#RRGGBB`, or `blue`, `teal`, `green`, `orange`, `purple`, `pink`, `red`, `yellow`, `gray`. Pick a colour per meaning and write it down once before the intent, so regions and the Links inside them agree.

   ```sh
   enso canvas apply --schema
   # Write /tmp/enso-<task>-intent.json with a filesystem editing tool.
   enso canvas apply /tmp/enso-<task>-intent.json --dry-run
   enso canvas apply /tmp/enso-<task>-intent.json
   ```

   Continue from dry-run only when the command succeeds, `preflightPassed` is true, and each validation deferral is understood. On apply success, require `verification.status: "verified"`. Then delete the temp file. Confirm `/tmp/enso-<task>-intent.json` no longer exists.

7. Overlap lint, one round. After apply:

   ```sh
   enso context --canvas current --vision --pretty
   ```

   Read `data.vision.diagnostics` only. Do not open `vision.image.path`. Ignore `node_offscreen`, `label_offscreen`, `link_crossing`, and `link_label_overlap`: crossings and label brushes do not stop a person reading the Canvas, and the person will nudge what they want nudged. Act on `node_overlap` and `low_node_gap` only, and only once: collect every subject, `enso node move` each one off its neighbour in a single pass, then stop. Do not run context again after the moves. A Canvas that still has a crossing after one round is finished.

   Each issue carries `subjects` (the ids involved), `bounds` in Viewport space matching the rendered image, and `worldBounds` in World space matching `nodes[].position`. Use `worldBounds` and `subjects` to pick the move. `enso node move` acts on the Canvas the app has open, so there is no `--canvas` flag: `canvas apply` on a named Canvas opens it.

   `enso node place <path>` places a file that already exists. Pass `--x` `--y` from a neighbor. `enso node remove` takes the card off the Canvas; the markdown file stays.

## Failure recovery

- Check or apply failed locally: fix the markdown or the intent JSON, then check or apply again.
- Apply or place failed: inspect, then the smallest typed command or a corrected intent. Dry-run, then apply.
- `verification_failed`: mutation may have landed. Inspect, then the smallest fix. Do not replay the full intent.
- `ambiguous_selector` or `note_ambiguous`: pick one exact returned candidate, usually a folder-relative path.
- `missing_selector` or `note_not_found`: the file is missing or the path is wrong. Write or rename the file, then retry.

## Links are wikilinks

A Link between two placed files stands on a sentence in the source file that holds `[[Target]]`. Write that sentence, one wikilink per sentence, before the intent names the Link. `canvas apply` returns `wikilink_required` when the sentence is missing. A wikilink alone draws nothing: the intent's `links` decides which relationships are worth a line. A Link's `label` is the short reading on the curve. With no label the curve shows the first mentioning sentence, so give a label when that sentence is long.

`link remove` takes the Link off this Canvas and keeps the prose. `link delete` deletes the mentioning sentence from the file, and the Link leaves every Canvas when it was the last. Canvas and DiagramPrimitive destructive commands use `delete`. Portal updates change placement or referenced subcanvas; they do not rename Portal titles.

Work on one Canvas per pass.

Use a markdown file for a durable concept, a Portal for navigation to another Canvas, and a Link for a visible relationship. Use a region for a cluster and an axis-aligned line for a lane divider, separator, or callout. First builds go through `enso canvas apply`. Agent-picked `x`/`y` is a placement from diagram-design, or a nudge off a neighbor's `position`.
