# Canvas operations

Read this before a first build or a multi-element revision, and when recovering from an apply failure.

## Files and target

A Note's identity is the filename stem or Vault-relative path. Before writing a note, choose a nonempty filename other than `.` or `..`, with safe folder components and at most 255 UTF-8 bytes including `.md`. Use spaces, Unicode, and safe punctuation freely. Separators, colons, and control characters belong outside a filename component. The CLI validates canvas names, portal titles, and note placement paths before its mutations; the agent owns validation before direct filesystem writes. Place members must exist as markdown files. Before placing new Notes or adding wikilinks, run `enso check "<path>"` on that folder. Wikilink examples inside backticks or fenced blocks are literal text.

Use an exact Canvas selector or stable `canvasID` from `enso canvas list`. Each invocation resolves one stable vault/canvas pair and reuses it across requests, batches and dry runs. Open another Canvas as a separate explicit `enso canvas open <target>` action before targeting it; named apply/layout commands also require that target to be active. With an immutable vault/canvas binding, keep apply/layout `canvas` as `current` or the bound `canvasID` and preserve the binding. Handle inactive or changed targets by reporting the error and inspecting partial effects before a retry.

Use `enso setup` for agent onboarding and report its structured blockers and hints to the person. It preserves the person's Local agent access setting. Continue from `enso status` when `ok: true`. If Enso is closed, launch it and retry. For unavailable Local agent access or incompatible CLI/app versions, report `error.details.hint` so the user can resolve setup.

## Lay out a new graph

Write a temporary graph JSON with the target `canvas`, `members`, `edges`, optional `clusters`, and a `direction`. A member can carry an `excerpt` from its Note and a `mark` about it, and top-level `marks` hold the takeaway and legend. The CLI computes Node positions, cluster bounds, and where every Excerpt and Mark goes.

```sh
enso layout /tmp/enso-<task>-graph.json --apply --dry-run
enso layout /tmp/enso-<task>-graph.json --apply
```

Apply when the dry-run's `data.warnings` is empty. Each warning carries a `hint` for its repair. `data.crossings` estimates crossing Links and does not block. When a crossing cuts the main path, fix it in the graph before applying: reorder members or edges, change the `direction` or clusters, or leave out a Link the prose already states. Accept crossings off the main path.

## Apply a coherent change

Read the contract when constructing an intent:

```sh
enso canvas apply --schema
```

Write the intent to a temporary JSON file outside the Vault. Include the Nodes, Links, regions or lines, and Marks needed for this change. A mark's `connect` list connects each named node to it. Numeric `fontSize` ranges from 8 to 96 world points and defaults to 17; width controls wrapping separately. Reset size with `enso mark update <id> --reset-size` or `enso excerpt update <id> --reset-size`. Regions use `kind: region`; inspected `kind: group` identifies the same region. For an existing Canvas, use inspected IDs for updates and removals, and keep creation sections to additions.

```sh
enso canvas apply /tmp/enso-<task>-intent.json --dry-run
enso canvas apply /tmp/enso-<task>-intent.json
```

Apply when the dry-run returns `ok: true` and `preflightPassed: true`. Check `sharedNoteWrites` for edits to Notes other Canvases also show.

When `data.placement.recentered` is true, the CLI moved the creation onto the empty-Canvas home. Add the returned `dx` and `dy` to your input coordinates for later edits.

For a requested overview, `enso canvas fit <target>` frames the open Canvas content.

## Link and removal semantics

A Link's `direction` is `directed` for a one-way relationship, `bidirectional` when both Notes mention each other and the relationship runs both ways, or `undirected` for a symmetric association. The arrowhead points at the target.

Each command touches shared files differently:

- `enso node remove` removes a placement and keeps its markdown file.
- `enso node rename <selector> <new-title>` renames the file and rewrites its `[[wikilinks]]` and Canvas references. It finds the Node on the open Canvas, so open a Canvas holding the Note first, and check `unreadableNotes` for Links it could not rewrite.
- `enso excerpt source <id> --text` edits the passage in its Note. `enso excerpt delete` removes only the placement.
- `enso link remove` removes a curve from this Canvas and keeps the prose.
- `enso link delete` deletes the mentioning sentence. Removing the last mention removes the Link on every Canvas.
- Moving a Link endpoint rewrites its mention.

## Recover from failure

An apply runs in phases, and phases that succeeded stay applied when a later one fails. Read `appliedBatches`, `failedBatch`, `returnedIds`, and `retrySections`, then dry-run and apply the smallest remaining correction. For `verification_failed`, repair the reported mismatch on the mutations that landed.

For `ambiguous_selector` or `note_ambiguous`, pick one returned candidate, usually a Vault-relative path. Prose edits can remove a Link, so refresh the inventory before removing one.

If `enso check` rejects a reference the app resolves, report the discrepancy and keep the reference that names the intended Note.
