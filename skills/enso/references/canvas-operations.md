# Canvas operations

Read this before a first build or a multi-element revision, and when recovering from an apply failure.

## Files and target

A Note's identity is the filename stem or Vault-relative path. Place members must exist as markdown files. Before placing new Notes or adding wikilinks, run `enso check "<path>"` on that folder, where links resolve across files. Wikilink examples inside backticks or fenced blocks are literal text.

Continue from `enso status` when `ok: true`. If Enso is closed, launch it and retry. For unavailable Local agent access or incompatible CLI/app versions, report `error.details.hint` so the user can resolve setup.

Use an exact Canvas selector from `enso canvas list`. A named `canvas apply` opens its target. Typed commands such as `enso node move` act on the open Canvas; use `enso canvas open <target>` before editing a different target through those commands.

## Lay out a new graph

Use `enso layout` when new Notes and their relationships determine placement. Read `enso layout --schema` when constructing an unfamiliar graph contract. Write a temporary graph JSON with the target `canvas`, `members`, `edges`, optional `clusters`, and a `direction`. The CLI computes Node positions and cluster bounds, keeping each cluster's members together and its region clear of other regions and non-member Nodes at any `--spacing`.

```sh
enso layout /tmp/enso-<task>-graph.json --apply --dry-run
enso layout /tmp/enso-<task>-graph.json --apply
```

Continue from the dry-run when `data.warnings` is empty; each region warning names the regions and Nodes involved and carries a `hint` for its repair. `data.crossings` lists pairs of unrelated Links whose straight paths cross, an estimate of the crossings the app's diagnostics report, and it does not block continuing. When a crossing cuts the main path, resolve it in the graph before applying: change the member or edge order, the `direction`, or the clusters, or leave out a Link whose relationship the Note's prose already states. Accept crossings off the main path rather than repairing them after apply. Layout uses the apply pipeline below. Its `data.applied` contains that pipeline's result, including preflight, verification, and returned IDs. Read `validation.locallyValidatedOnly` for phases that receive app validation during apply. Add any Marks or other mixed elements through a focused apply intent. Use inspected IDs and `canvas apply` for revisions to existing placements. Delete the temporary graph after success.

## Apply a coherent change

Read the contract when constructing an unfamiliar intent:

```sh
enso canvas apply --schema
```

Write the intent with a filesystem editing tool to a temporary JSON file outside the Vault. Include the Nodes, Links, regions or lines, and Marks needed for this change. A Mark's `connect` list connects each named Node to it. For an existing Canvas, use inspected IDs for updates and removals, and keep creation sections limited to additions.

```sh
enso canvas apply /tmp/enso-<task>-intent.json --dry-run
enso canvas apply /tmp/enso-<task>-intent.json
```

Continue from dry-run when `ok: true`, `preflightPassed` is true, and each validation deferral is understood. Read `sharedNoteWrites` for potential changes to Notes shared across Canvases. On apply, require `ok: true` and `data.applied: true`, and read the returned IDs.

Read `data.placement`. When `recentered` is true, the CLI translates the creation onto the empty-Canvas home. Use the compiled phase coordinates from dry-run or add the returned `dx` and `dy` to input coordinates for subsequent edits.

Delete the temporary file after success. Retain a failed intent only while using it for recovery, then clean it up.

For a requested overview, `enso canvas fit <target>` frames the open Canvas content. Dry-run it first and read the proposed viewport and `fits`. If framing fails, report the bridge error, keep the diagram's geometry, and continue with the rest of the request.

## Link and removal semantics

Write the source sentence containing `[[Target]]` before creating its Link. The intent selects which mentions appear as visible relationships. Choose each Link's `direction` deliberately: `directed` for a one-way relationship, `bidirectional` when both Notes mention each other and the relationship runs both ways, or `undirected` for a symmetric association. The default arrowhead points at the target.

`enso node remove` removes a placement and preserves its markdown file. `enso node rename` renames the markdown file and rewrites its `[[wikilinks]]` across the Vault and its Canvas references. `enso link remove` removes a curve from this Canvas and preserves the prose. `enso link delete` deletes the mentioning sentence; removing the last mention removes the Link across Canvases. A Link endpoint move rewrites its mention. Use these shared-file effects when deciding which operation fits the user's request.

## Recover from failure

An apply runs dependency phases. Earlier successful phases remain when a later phase fails. Read `appliedBatches`, `failedBatch`, `returnedIds`, and `retrySections`, inspect the affected state, and build the smallest remaining correction. Dry-run that correction, then apply it.

For `verification_failed`, inspect the mutations that landed and repair the reported mismatch. Replay only operations that remain necessary.

For `ambiguous_selector` or `note_ambiguous`, select one exact returned candidate, usually a Vault-relative path. For `missing_selector` or `note_not_found`, check the live inventory and file path. Prose edits can remove a Link, so refresh its inventory before preparing a Link removal.

For local file or intent validation failures, fix the reported input and validate again. If `enso check` rejects a reference that the app resolves, report the specific discrepancy and verify it against the app's Note inventory; preserve the reference that identifies the intended Note.
