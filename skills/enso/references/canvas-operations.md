# Canvas operations

Read this before a first build or a multi-element revision, and when recovering from an apply failure. Use focused command help for individual edits.

## Files and target

Write Notes in the Vault `path` returned by `enso vault current --pretty`. Identity is the filename stem or Vault-relative path. Place members must exist as markdown files. Before placing new Notes or adding wikilinks, run `enso check "<path>" --pretty` on that folder, where links resolve across files. Wikilink examples inside backticks or fenced blocks are literal text.

Continue from `enso status` when `ok: true`. If Enso is closed, launch it and retry. For unavailable Local agent access or incompatible CLI/app versions, report `error.details.hint` so the user can resolve setup.

Use an exact Canvas selector from `enso canvas list`. A named `canvas apply` opens its target. Typed commands such as `enso node move` act on the open Canvas; use `enso canvas open <target>` before editing a different target through those commands.

## Apply a coherent change

Read the contract when constructing an intent:

```sh
enso canvas apply --schema
```

Write the intent with a filesystem editing tool to a temporary JSON file outside the Vault. Include the Nodes, Links, and regions or lines needed for this change. For an existing Canvas, use inspected IDs for updates and removals, and keep creation sections limited to additions.

```sh
enso canvas apply /tmp/enso-<task>-intent.json --dry-run
enso canvas apply /tmp/enso-<task>-intent.json
```

Continue from dry-run when `ok: true`, `preflightPassed` is true, and each validation deferral is understood. Read `sharedNoteWrites` for potential changes to Notes shared across Canvases. On apply, require `ok: true` and `data.applied: true`, and read the returned IDs.

Read `data.placement`. When `recentered` is true, the CLI translates the creation onto the empty-Canvas home. Use the compiled phase coordinates from dry-run or add the returned `dx` and `dy` to input coordinates for subsequent edits.

Delete the temporary file after success. Retain a failed intent only while using it for recovery, then clean it up.

## Link and removal semantics

Write the source sentence containing `[[Target]]` before creating its Link. The intent selects which mentions appear as visible relationships. Choose each Link's `direction` deliberately: `directed` for a one-way relationship, `bidirectional` when both Notes mention each other and the relationship runs both ways, or `undirected` for a symmetric association. The default arrowhead points at the target.

`enso node remove` removes a placement and preserves its markdown file. `enso link remove` removes a curve from this Canvas and preserves the prose. `enso link delete` deletes the mentioning sentence; removing the last mention removes the Link across Canvases. A Link endpoint move rewrites its mention. Use these shared-file effects when deciding which operation fits the user's request.

## Recover from failure

An apply runs dependency phases. Earlier successful phases remain when a later phase fails. Read `appliedBatches`, `failedBatch`, `returnedIds`, and `retrySections`, inspect the affected state, and build the smallest remaining correction. Dry-run that correction, then apply it.

For `verification_failed`, inspect the mutations that landed and repair the reported mismatch. Replay only operations that remain necessary.

For `ambiguous_selector` or `note_ambiguous`, select one exact returned candidate, usually a Vault-relative path. For `missing_selector` or `note_not_found`, check the live inventory and file path. Prose edits can remove a Link, so refresh its inventory before preparing a Link removal.

For local file or intent validation failures, fix the reported input and validate again. If `enso check` rejects a reference that the app resolves, report the specific discrepancy and verify it against the app's Note inventory; preserve the reference that identifies the intended Note.
