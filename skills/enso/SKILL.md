---
name: enso
description: Operate in Enso through its local CLI. Treat "in Enso" as a destination and perform the work through the Enso app. For explain, show, map, or illustrate requests, create or update an Enso Canvas. Also use when work otherwise needs Enso vault or Canvas access.
---

# Enso

Enso turns durable Notes and their relationships into navigable Canvases. Write Note markdown in the Vault folder. The CLI places, links, and lays those Notes out. The bridge does not write Note bodies.

## Default Canvas Pass

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

2. Ask the app which folder is the Vault, then write Notes as markdown files there. A Note's identity is its filename stem or vault-relative path (`docs/API.md`). Do not send Note `content` through the CLI. Do not write `Canvases/*.json` or sidecar state.

   ```sh
   enso vault current --pretty
   ```

3. Select one exact Canvas:

   ```sh
   enso canvas list --pretty
   enso context --canvas "<Canvas Name>" --pretty
   ```

   Use `current` only when the user means the open Canvas. Create a missing Canvas only when the request authorizes it.

4. For a first build, write one temporary graph JSON (not a Vault file). Members and edge endpoints are existing Note titles or vault-relative paths. Layout owns coordinates.

   ```sh
   enso layout --schema
   # Write /tmp/enso-<task>-graph.json with a filesystem editing tool.
   enso layout /tmp/enso-<task>-graph.json --apply --dry-run
   enso layout /tmp/enso-<task>-graph.json --apply
   ```

   Continue from dry-run only when the command succeeds, `preflightPassed` is true, and each validation deferral is understood. On apply success, require `verification.status: "verified"`.

5. For placement work among existing elements, open the target and inspect vision once, then use a surgical command (`enso node place`, `enso node move`, `enso link create`) instead of inventing a full graph.

   ```sh
   enso canvas open "<Canvas Name>"
   enso context --canvas current --vision --pretty
   ```

   Read the screenshot, viewport, and diagnostics. Element world geometry is in `nodes`, `links`, and `diagramPrimitives`. Read [references/diagram-design.md](references/diagram-design.md) before choosing or repairing geometry.

6. Recapture vision after apply only when the pass moved or reshaped existing elements, or when the user asks for visual polish. A fresh layout whose apply reports `verification.status: "verified"` is complete without a screenshot pass.

   ```sh
   enso context --canvas current --vision --pretty
   ```

   Use diagnostics to focus screenshot review. Check for Node overlap, clipped content, unreadable Link labels, Links crossing unrelated Nodes, primitive titles that obscure Links or labels, and unclear reading order. Accept warnings and close proximity when the text remains legible and the reading order remains clear. Repair only a materially impaired screenshot, using the smallest typed change, then recapture.

7. Delete the temporary graph JSON after verification or after preserving any failure details needed for recovery. Confirm `/tmp/enso-<task>-graph.json` no longer exists.

## Failure Recovery

- On a phase failure, preserve `appliedBatches`, `failedBatch`, `returnedIds`, and `retrySections`. Earlier successful phases remain applied. Inspect the target and send only unresolved work.
- On `verification_failed`, treat mutation phases as applied and verification as uncertain. Inspect state and construct the smallest corrective layout or typed command; do not replay the full payload.
- On `ambiguous_selector` or `note_ambiguous`, choose one exact returned candidate, usually a vault-relative path. On `missing_selector` or `note_not_found`, inspect again and correct the graph instead of inventing a replacement.

## Small Edits

For one surgical mutation, use the typed `enso node`, `enso portal`, `enso link`, `enso primitive`, or `enso canvas` command. Run it with `--dry-run`, inspect success, then run the same command without `--dry-run`. `enso node place <path>` places a Note that already exists. There is no `node write` and no Note `content` on apply.

## Guardrails

- Write Note markdown in the Vault folder. Arrange through the CLI. Canvas JSON lives in the app sidecar, not the folder.
- Work on one Canvas per pass.
- Treat Note content updates as file writes, not Canvas-local decoration.
- `node remove` and `portal remove` preserve backing content.
- `link remove` preserves relation prose. `link delete` removes the bound relation line across Canvases.
- Canvas and DiagramPrimitive destructive typed commands use `delete`.
- Portal updates change placement or referenced subcanvas; they do not rename Portal titles.

## Object and Placement Choices

- Use a Note for a durable concept, a Portal for navigation to another Canvas, and a Link for a visible relationship.
- Use a region for a cluster and an axis-aligned line for a lane divider, separator, or callout.
- First builds go through `enso layout`. Agent-picked `x`/`y` is for a single nudge against inspected geometry.
- Read [references/codebase-maps.md](references/codebase-maps.md) when the Canvas represents a repository or software architecture.
