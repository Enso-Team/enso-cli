---
name: enso
description: Write markdown in the folder Enso has open, then layout or place those files on a Canvas through the local CLI. Treat "in Enso" as a destination and perform the work through the Enso app. For explain, show, map, or illustrate requests, create or update an Enso Canvas. Also use when work needs that folder or Canvas access.
---

# Enso

Write markdown in the folder `enso vault current` prints. The CLI places, links, and lays those files out on a Canvas. To read a file, open the file.

## Default pass

1. Check the intended Enso instance:

   ```sh
   enso status --pretty
   ```

   Continue on `ok: true`. Otherwise route on `error.code`. Never run `enso auth link` from this skill. The CLI links itself inside any command, with no prompt, whenever the app provisions a token file. `enso auth link` is the prompt path for older apps.

   - `auth_required`: no pairing exists. Launch the Enso app, then run `enso status` again. It links itself.
   - `invalid_token`: the stored pairing is stale and the configured app provisions no token file to replace it. Stop. Tell the user to update Enso, quoting `error.details.hint`.
   - `app_unavailable`: nothing answers at `error.details.bridgeUrl`. Launch that instance, or run `enso auth unlink` and then `enso status` to link to the instance that is running.
   - `access_disabled`: Local agent access is off in Enso's Settings. Stop and tell the user.
   - `cli_outdated` or `app_outdated`: stop. Tell the user which side is behind, quoting `error.details.hint`, and wait for them to update it.
   - `pairing_in_progress`: another `enso auth link` owns the app's dialog. Wait for it, then run `enso status` again.

   Continue when status succeeds for the intended instance.

2. Ask the app which folder it has open, then write markdown there. Identity is the filename stem or the path relative to that folder (`docs/API.md`). Do not stamp a UUID into the file. Do not write `Canvases/*.json` or sidecar state.

   ```sh
   enso vault current --pretty
   ```

   Write at `path`. Cwd is often some other workspace; use that path anyway. Bodies are not on node payloads and not in `enso context`.

3. Before a first build, lint that folder:

   ```sh
   enso check "<path>" --pretty
   ```

   Continue when `ok: true`. Layout members must already exist as files.

4. Select one Canvas:

   ```sh
   enso canvas list --pretty
   ```

   Use `current` only when the user means the open Canvas. Create a missing Canvas only when the request authorizes it.

5. First build: write one temporary graph JSON (not in the Enso folder). Members and edge endpoints are existing files, named by stem or folder-relative path. Layout owns coordinates.

   ```sh
   enso layout --schema
   # Write /tmp/enso-<task>-graph.json with a filesystem editing tool.
   enso layout /tmp/enso-<task>-graph.json --apply --dry-run
   enso layout /tmp/enso-<task>-graph.json --apply
   ```

   Continue from dry-run only when the command succeeds, `preflightPassed` is true, and each validation deferral is understood. On apply success, require `verification.status: "verified"`. Then delete the temp file. Confirm `/tmp/enso-<task>-graph.json` no longer exists.

6. Surgical work among existing canvas elements: open the target, inspect vision for geometry, then a typed command. Dry-run, then apply.

   ```sh
   enso canvas open "<Canvas Name>"
   enso context --canvas current --vision --pretty
   ```

   Vision is screenshot, viewport, and diagnostics. Element world geometry is in `nodes`, `links`, and `diagramPrimitives`. Read [references/diagram-design.md](references/diagram-design.md) before choosing or repairing geometry.

   Recapture vision only when the pass moved or reshaped existing elements, or when the user asks for visual polish. A fresh layout whose apply reports `verification.status: "verified"` is complete without a screenshot pass. Repair a materially impaired screenshot with the smallest typed change, then recapture.

   `enso node place <path>` places a file that already exists. `enso node remove` takes the card off the Canvas; the markdown file stays.

## Failure recovery

- Check or layout failed locally: fix the markdown or the graph JSON, then check or layout again.
- Apply or place failed: inspect, then the smallest typed command or a corrected graph. Dry-run, then apply.
- `verification_failed`: mutation may have landed. Inspect, then the smallest fix. Do not replay the full graph.
- `ambiguous_selector` or `note_ambiguous`: pick one exact returned candidate, usually a folder-relative path.
- `missing_selector` or `note_not_found`: the file is missing or the path is wrong. Write or rename the file, then retry.

## Bound relation lines

Edit markdown in the file. The one CLI exception is `link update --bound-line` and `link delete`, which rewrite the bound relation line.

`link remove` keeps that prose. Canvas and DiagramPrimitive destructive commands use `delete`. Portal updates change placement or referenced subcanvas; they do not rename Portal titles.

Work on one Canvas per pass.

Use a markdown file for a durable concept, a Portal for navigation to another Canvas, and a Link for a visible relationship. Use a region for a cluster and an axis-aligned line for a lane divider, separator, or callout. First builds go through `enso layout`. Agent-picked `x`/`y` is for a single nudge against inspected geometry.

Read [references/codebase-maps.md](references/codebase-maps.md) when the Canvas represents a repository or software architecture.
