# Canvas operations

Read this before a first build, and when recovering from an apply failure.

## Files and target

A Note's identity is the filename stem or Vault-relative path. Place members must exist as markdown files. Before placing new Notes or adding wikilinks, run `enso check "<path>"` on that folder. Wikilink examples inside backticks or fenced blocks are literal text.

Use an exact Canvas selector or stable `canvasID` from `enso canvas list`. Each invocation resolves one stable vault/canvas pair and reuses it across requests, batches and dry runs. Open another Canvas as a separate explicit `enso canvas open <target>` action before targeting it; named apply/layout commands also require that target to be active. With an immutable vault/canvas binding, keep apply/layout `canvas` as `current` or the bound `canvasID` and preserve the binding. Handle inactive or changed targets by reporting the error and inspecting partial effects before a retry.

## Grow a diagram

Write each step's intent to a temporary JSON file outside the Vault, or pass it with `--json`. A step adds one Node with the Links to Nodes already placed, plus its Excerpt or Mark:

```json
{
  "canvas": "current",
  "direction": "TB",
  "regions": [{ "title": "Sync layer", "color": "blue" }],
  "nodes": [{ "kind": "note", "mode": "place", "note": "Sync server", "in": "Sync layer" }],
  "links": [{ "mode": "create", "source": "Client", "target": "Sync server", "label": "sends updates to" }],
  "excerpts": [{ "mode": "create", "note": "Sync server", "text": "Retries with backoff." }],
  "marks": [{ "mode": "create", "text": "Why retry here?", "connect": ["Sync server"] }]
}
```

```sh
enso canvas apply /tmp/enso-<task>-step.json
```

A Node without `x` and `y` lands beside the Nodes it links to. Nodes you placed earlier keep their order, and a Node next to new work shifts at most half a step. `x` and `y` pin a Node where you put them. An Excerpt or connected Mark without a position goes beside its Node, and a Mark that connects to nothing goes above the drawing.

The CLI groups your applies on a Canvas into one growth. It ends after 2 minutes without a write, when the user moves one of its Nodes or reshapes one of its Regions, or on tidy. The next apply starts a new growth, and everything already on the Canvas stays where it is. `data.growth` reports the growth's `status`, the Nodes it `placed` and `moved`, and the Regions it `drawn`, `resized`, or `removed`.

## Regions

Place a Node `in` a Region by its title or id. Declare a new Region's title and color in `regions`. A declared title reuses the one Region with that title. When several share a title, the apply fails with their ids, so name the Region by id.

A Region appears around its first Node and grows with each Node placed in it. Nodes placed outside every Region stay clear of the boxes. A Region never grows over a Node that is not in it. When it has no room, the apply fails with `region_blocked`. Make the Region bigger, move what blocks it, or place the Node in another Region. A Region you drew this growth shrinks when its Nodes go and disappears when empty. Regions that were on the Canvas before only grow.

## Edit what is there

For a change to existing elements, write an intent carrying only that change. Use inspected IDs for updates and removals.

```json
{ "canvas": "current", "links": [{ "mode": "update", "id": "<link-id>", "color": "blue" }] }
```

Check `sharedNoteWrites` in the result for edits to Notes other Canvases also show.

For a requested overview, `enso canvas fit <target>` frames the open Canvas content.

## Rearrange

`{"canvas":"current","tidy":true}` reruns the full layout over the Nodes of the current growth and keeps the result only when it removes crossings. It ends the growth.

When the user asks to rearrange a Canvas, or for Regions nested inside Regions, write a graph JSON with the target `canvas`, `members`, `edges`, optional `clusters`, and a `direction`, then run `enso layout <graph.json> --apply`. Apply when `data.warnings` is empty. Each warning carries a `hint` for its repair. `data.crossings` estimates crossing Links and does not block.

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

An apply runs in phases, and phases that succeeded stay applied when a later one fails. Read `appliedBatches`, `failedBatch`, `returnedIds`, and `retrySections`, then apply the smallest remaining correction. For `verification_failed`, repair the reported mismatch on the mutations that landed.

For `ambiguous_selector` or `note_ambiguous`, pick one returned candidate, usually a Vault-relative path. Prose edits can remove a Link, so refresh the inventory before removing one.

If `enso check` rejects a reference the app resolves, report the discrepancy and keep the reference that names the intended Note.
