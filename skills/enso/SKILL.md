---
name: enso
description: Operate in Enso through its local CLI. Treat "in Enso" as a destination and perform the work through the Enso app. For explain, show, map, or illustrate requests, create or update an Enso Canvas. Also use when work otherwise needs Enso vault or Canvas access.
---

# Enso

Enso turns durable Notes and their relationships into navigable Canvases. The agent expresses intent, the CLI validates and compiles it, and the Enso app bridge owns Canvas and vault writes.

## Default Canvas Pass

Use one temporary JSON file for a multi-element Canvas build or reshape. The file keeps dry-run and apply on the same inspectable bytes without putting an intent artifact in the repository.

1. Check the intended Enso instance:

   ```sh
   enso status --pretty
   ```

   Continue on `ok: true`. On `auth_required`, run `enso auth link` and complete pairing. On `app_unavailable`, inspect `error.details.bridgeUrl`; launch that instance or run `enso auth link` to replace the stale pairing. On `pairing_in_progress`, wait for that attempt to finish. Continue when status succeeds for the intended instance.

2. Select one exact Canvas:

   ```sh
   enso canvas list --pretty
   enso context --canvas "<Canvas Name>" --pretty
   ```

   Use `current` only when the user means the open Canvas. Create a missing Canvas only when the request authorizes it. Copy exact selectors or UUIDs for existing objects; preflight rejects missing or ambiguous identities.

3. For placement work among existing elements, open the target and inspect vision once:

   ```sh
   enso canvas open "<Canvas Name>"
   enso context --canvas current --vision --pretty
   ```

   Read the screenshot, viewport, and diagnostics; element world geometry is in the same response's `nodes`, `links`, and `diagramPrimitives` sections. Vision describes the open Canvas. A first build on an empty Canvas needs no vision pass; choose fresh world coordinates directly. Read [references/diagram-design.md](references/diagram-design.md) before choosing or repairing geometry.

4. Load the active contract, then write one descriptive temporary intent file:

   ```sh
   enso canvas apply --schema
   # Write /tmp/enso-<task>-intent.json with a filesystem editing tool.
   ```

   Use explicit modes and final create geometry. For an existing Link endpoint, copy one exact inspected selector. For a Node or Portal created in the same intent, use its declared title. Keep the path outside the repository and reuse it unchanged through apply.

5. Dry-run the file once:

   ```sh
   enso canvas apply /tmp/enso-<task>-intent.json --dry-run
   ```

   Continue only when the command succeeds, `preflightPassed` is true, planned phase counts match the intent, shared Note writes are intentional, and each validation deferral is understood. A named-Canvas dry-run completes local preflight while bridge validation remains deferred until apply.

6. Apply the same file once:

   ```sh
   enso canvas apply /tmp/enso-<task>-intent.json
   ```

   On success, require `verification.status: "verified"` and inspect `appliedBatches` plus any compact `results`. Targeted verification replaces a redundant whole-Canvas count pass.

7. Recapture vision after apply only when the pass moved or reshaped existing elements, or when the user asks for visual polish. A fresh build whose apply reports `verification.status: "verified"` is complete without a screenshot pass.

   ```sh
   enso context --canvas current --vision --pretty
   ```

   Use diagnostics to focus screenshot review. Check for Node overlap, clipped content, unreadable Link labels, Links crossing unrelated Nodes, primitive titles that obscure Links or labels, and unclear reading order. Accept warnings and close proximity when the text remains legible and the reading order remains clear. Repair only a materially impaired screenshot, using the smallest typed change, then recapture. The pass is complete when targeted verification succeeds and any inspected screenshot communicates the requested idea clearly.

8. Delete the temporary intent with the filesystem editing tool after verification or after preserving any failure details needed for recovery. Confirm `/tmp/enso-<task>-intent.json` no longer exists.

## Failure Recovery

- On a phase failure, preserve `appliedBatches`, `failedBatch`, `returnedIds`, and `retrySections`. Earlier successful phases remain applied. Inspect the target and create a new temporary intent containing only unresolved sections.
- On `verification_failed`, treat mutation phases as applied and verification as uncertain. Inspect state and construct the smallest corrective intent; do not replay the full payload.
- On `ambiguous_selector`, choose one exact returned candidate. On `missing_selector`, inspect again and correct the intent instead of inventing a replacement.

## Small Edits

For one surgical mutation, use the typed `enso node`, `enso portal`, `enso link`, `enso primitive`, or `enso canvas` command. Run it with `--dry-run`, inspect success, then run the same command without `--dry-run`.

## Guardrails

- Mutate through the Enso bridge. Vault files, including `Canvases/*.json`, remain app-owned.
- Work on one Canvas per pass.
- Treat Note content updates as shared vault writes, not Canvas-local decoration.
- `node remove` and `portal remove` preserve backing content.
- `link remove` preserves relation prose. `link delete` removes the bound relation line across Canvases.
- Canvas and DiagramPrimitive destructive typed commands use `delete`.
- Portal updates change placement or referenced subcanvas; they do not rename Portal titles.

## Object and Placement Choices

- Use a Note for a durable concept, a Portal for navigation to another Canvas, and a Link for a visible relationship.
- Use a region for a cluster, a divider for a lane, and a line for a precise separator or callout.
- Coordinates are world-space element centers. Anchor new geometry to the vision viewport or inspected neighbors, compute the arrangement before apply, and put final geometry on creates.
- Read [references/codebase-maps.md](references/codebase-maps.md) when the Canvas represents a repository or software architecture.
