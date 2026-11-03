# Enso CLI

Local CLI for the Enso app. Markdown files live in the folder Enso has open. This CLI places them on a Canvas, draws links, and runs layout.

## Quick start

Requirements: macOS, Enso app running, Node.js 20+.

```sh
npm install -g @enso-app/cli
enso status --pretty
```

Run `enso update` to install the latest release for a global npm installation, or
`enso update --check` to inspect the installed and available versions. Interactive
commands check npm at most once per day and print update notifications to stderr.
Set `ENSO_CLI_NO_UPDATE_CHECK=1` to disable these checks. Checks use a 5-second
timeout; CI and piped commands keep their structured output.

With the Enso app open, the first command links itself by reading the token
file the app provisions. `enso auth link` relinks the same way.

Canvas operations require an Enso app with **bridge contract 3**. The CLI checks
`/v1/health` before targeting and sends `Enso-Contract-Version: 3` on canvas
requests. An older app fails with `app_outdated` and upgrade guidance; canvas
commands never fall back to implicit active-canvas execution. Health, pairing,
discovery, vault operations and explicit navigation use the supported bootstrap
contract (2), so you can inspect an older app before upgrading.

Install the bundled agent skill:

```sh
enso skill install
enso skill install --agent codex claude-code
npx skills list -g
```

`enso skill install` detects installed agents and installs to every supported global target, including Codex and Claude Code. Detected project-only agents appear in `skippedAgents`. `--agent` selects specific targets. The reply reports each target's installation status and any failures.

## Canvas targets and immutable bindings

Every canvas command resolves one stable vault/canvas pair for its invocation.
Without a selector it captures the active canvas once. `--canvas` accepts a name,
ref or stable `canvasID`; names and refs are resolved from bridge discovery. The
same target and bridge connection are reused for all reads, writes, context,
searches, fit, layout, apply phases and verification, including dry runs.

```sh
enso canvas list --pretty
enso canvas current --pretty
enso node list                         # capture the active canvas once
enso --canvas "Architecture" node list
enso context --canvas "Architecture" --full
enso --canvas "Architecture" mark create "Open question" --at 120,200 --dry-run
```

Discovery reports `vaultID`, `canvasID`, and `canvasTarget`. Use those UUIDs for
stable identity; the legacy `id` can still be a filename stem. A canvas with
`canvasID: null` has no available stable target. The CLI never derives one from
a name or path.

Canvas selection does not navigate. Open the intended canvas as a separate
explicit action before using it. Named `canvas apply` and `layout --apply` follow
this rule too. Targeted `portal open` returns `explicit_navigation_required`;
read the portal's `subcanvasRef` from context and open that canvas explicitly.

```sh
enso canvas open "Architecture"
enso --canvas "Architecture" node list
```

Automation can bind the invocation to an immutable pair using both flags:

```sh
enso --vault-id 77A94BC5-18EA-4869-AAC5-10C461601E26 \
     --canvas-id B0C38C1D-E096-42E9-BFFA-7BD04CF6F44F node list
```

The reusable process interface for a local caller is the equivalent environment
pair. It is read independently for each invocation and is never persisted in the
pairing configuration:

```sh
export ENSO_VAULT_ID=77A94BC5-18EA-4869-AAC5-10C461601E26
export ENSO_CANVAS_ID=B0C38C1D-E096-42E9-BFFA-7BD04CF6F44F
enso context --full
enso node move "API" --x 120 --y 200 --dry-run
enso canvas apply intent.json --dry-run  # intent.canvas: "current" or the bound canvasID
```

A binding requires both valid UUIDs. Conflicting flag/environment pairs and
`--canvas` selectors alongside a binding are rejected. A named apply/layout
selector cannot replace a binding; use `current` (inherit the pair) or its exact
`canvasID`. Bound invocations reject canvas/vault navigation, canvas deletion,
portal opening, and pairing changes before their effects, even on dry runs.
They use only the configured bridge instance; they never search another app
instance to recover. These options enforce correctness, not authorization; app
bearer-token and local access rules still govern access.

If the person switches from canvas A to B after resolution, later requests still
specify A and fail with `target_not_active`. `target_changed` means navigation
interrupted work already in progress. The CLI preserves bridge error codes and
details, adds recovery hints, and never switches back, retries against B, or
replays targeted mutations. Inspect the original target for partial effects
before deciding whether to retry. A lost mutation response reports an unknown
outcome; it is not proof that nothing changed.

A batch inherits one outer target. Conflicting operation targets and navigation
operations are rejected before submission. Dry runs use the same targeting and
version rules as execution. Apply phases retain their existing partial-success
reporting; rollback is a canvas snapshot operation, not a transaction covering
notes, files and sync writes.

## For agents

The skill is `skills/enso/SKILL.md`. Paste this when onboarding an agent:

```txt
Use the Enso CLI to work with canvases in the Enso Mac app.

Setup:
1. npm install -g @enso-app/cli
2. Launch Enso
3. enso skill install

Read skills/enso/SKILL.md for the workflow. Frame the explanation around the
user's question, then create or revise the Canvas through the CLI. Write Note
markdown in the Vault folder Enso reports. Each revision edits the affected
elements and preserves the user's adjustments elsewhere.
```

## Command model

`enso vault open <path>` opens an existing folder as the vault and waits for its canvas to load. Relative paths and `~` resolve on the CLI. The sandboxed Mac app remembers folder grants; a folder needing access opens a native permission panel for that exact folder. `--dry-run` checks access without switching vaults or presenting a panel.

`enso vault create <path>` makes a folder into a new vault. A missing folder is created by the CLI, because the sandboxed app is granted only that exact folder; its parent must already exist, so a mistyped path fails instead of building a chain of folders. An existing folder is adopted as-is, and the app refuses one that is already a Vault. `--name` sets the vault's name. Vaults are local unless `--sync` asks Enso to sync them; `--team <id>` puts a synced vault under a team and requires `--sync`. `--dry-run` creates nothing but still checks the path and its parent. When the app refuses, the CLI removes the folder it created, provided it is still empty.

`enso canvas fit [selector]` frames all content on the open canvas inside the visible area, including sidebars and editor insets. The selector defaults to `current`. `--dry-run` returns the proposed viewport. The reply reports `fits: false` when the app's minimum zoom keeps some content outside the frame.

Three layers. Compile a whole diagram from a graph, batch a hand-written patch, or edit one element.


| Layer       | When                                  | Commands                                                  |
| ----------- | ------------------------------------- | --------------------------------------------------------- |
| **Compile** | Building a diagram from a graph       | `enso layout <graph.json>`                                |
| **Batch**   | Building or reshaping a canvas region | `enso canvas apply <file.json>`                          |
| **Atomic**  | One surgical edit                     | `enso node`, `enso link`, `enso portal`, `enso primitive`, `enso mark`, `enso excerpt` |
| **Verify**  | Linting a Vault folder                | `enso check [folder]`                                     |


`canvas apply` runs complete local preflight, then applies dependency phases. Each phase uses the app's canvas-snapshot rollback while its target remains active; completed work may remain after navigation or a later failure. The error envelope reports `appliedBatches`, `failedBatch`, returned IDs, and `retrySections`.

## mark

A Mark is typed text on the open Canvas that labels, decorates, or comments without becoming a Note. `x` and `y` place the top-left of the text block. Text wraps at `--width`, or at 420 World points when unset.

```sh
enso mark create "Open question: does the retry reuse the token?" --at 120,-40 --width 260
enso mark connect <mark-id> Auth
enso mark list
```

`enso mark update` edits a typed Mark. Handwritten Marks belong to the person who drew them, and `mark list` reports each one's interpretation and approval. `add-to-note` moves a Mark's writing into a Note as an Excerpt, and `drop-to-note` appends it to the Note and removes the Mark. `canvas apply` takes the same Marks in its `marks` section. An app without Marks answers with `app_outdated`.

## excerpt

An Excerpt places a passage of a Note on the open Canvas, linked from the Note's node. The Note owns the text, so editing an Excerpt edits the Note. `x` and `y` place the top-left of the text block.

```sh
enso excerpt create --note Auth --text "Tokens expire after an hour." --x 120 --y -40
enso excerpt move <excerpt-id> --x 300 --y -40
enso excerpt update <excerpt-id> --width 320 --font-size 14 --align left
enso excerpt connect <excerpt-id> Billing
enso excerpt source <excerpt-id> --text "Tokens expire after a day."
enso excerpt list
```

`create --note` takes a note node on the open Canvas and the passage exactly as its markdown file holds it, markup included. The CLI finds the passage in the file and the app links it from that node. When the passage repeats, `--occurrence <n>` picks one. The CLI takes the Note's id from its node, then from `--note-id`, then from the app's index of the open Vault, which it reads and never writes. `create --link <link-id> --text <text>` writes new text into a Note at the end of a dangling link from its node. `source <excerpt-id>` shows the owning Note and its markdown, and `--text` replaces the passage in the Note. `remove-from-note` deletes the passage from the Note and keeps the Excerpt on the Canvas. `delete` removes the Excerpt and its links from the Canvas and leaves the Note's text in place. An app without Excerpts answers with `app_outdated`.

## layout

`enso layout` compiles graph JSON into a `canvas apply` patch. Declare the graph; the CLI owns every coordinate.

The JSON is a command input, not a Vault file. Members are Notes that already exist, named by title or vault-relative path. Edges become Links. Clusters become regions. `direction` is `TB` or `LR`.

```json
{
  "canvas": "Request Flow",
  "direction": "LR",
  "members": [
    { "title": "Gateway", "excerpt": "Requests enter through the gateway.", "mark": "Where requests enter" },
    "Router",
    { "title": "Object Store" }
  ],
  "edges": [
    { "from": "Gateway", "to": "Router", "label": "routes", "direction": "directed" },
    { "from": "Router", "to": "Object Store" }
  ],
  "clusters": [
    { "name": "Edge", "color": "#6B7280", "members": ["Gateway", "Router"] }
  ],
  "marks": [
    "Requests pass through the edge before reaching storage.",
    { "text": "Edge: Gateway and Router", "width": 320 }
  ]
}
```

```sh
enso layout request-flow.json --apply
enso layout request-flow.json --apply --dry-run
enso layout request-flow.json --spacing 1.5 --apply --dry-run
```

Members become Notes ranked along the direction hint on the shared spacing steps, edges become Links, and each cluster becomes a region whose bounds are its member bounds plus padding. Identical spec input yields byte-identical geometry. `--apply` sends the compiled patch through the `canvas apply` pipeline with its preflight and verification, `--apply --dry-run` validates without mutating, and running without `--apply` prints the compiled patch for inspection. Run `enso layout --schema` for the machine-readable spec contract.

A member's optional `excerpt` must quote its Note's markdown exactly, including markup; the example requires that sentence in `Gateway.md`. Its optional `mark` adds typed text connected to the member's Node. The CLI places both to the right of the Node for `TB`, or below it for `LR`, and grows regions to contain them. Top-level `marks` are strings or `{ "text": "...", "width": 320 }` objects, stacked above the drawing in declaration order.

`--spacing <factor>` scales the distance between Node centers while keeping Node sizes fixed. It defaults to `1` and accepts values from `1` to `10`; use `1.5` or `2` when Link labels need more room.

When applied, the compiled drawing is centered on the app's empty-Canvas home point, `(25000, 25000)`. On a Canvas with existing content, it is centered among that content if there is room, or placed to its right with a gap. Dry runs report the same proposed coordinates and a `placement` object with `recentered`, `dx`, and `dy`.

Colors take the app's visual grammar: `#RGB`, `#RRGGBB`, `#RRGGBBAA`, or one of `black`, `blue`, `cyan`, `gray`, `grey`, `green`, `orange`, `pink`, `purple`, `red`, `teal`, `white`, `yellow`. Every path enforces it, so a color outside the grammar fails locally in `layout`, `canvas apply`, `apply`, `link`, and `primitive` alike, before any element reaches the canvas.

`--apply --dry-run` reports `validation.bridgeValidated` and `validation.locallyValidatedOnly`. The app checks the first phase; later phases carry local validation alone until you apply. Planned Excerpts are reported separately in `excerpts` with `validated: "locally"`; execution places them after the compiled patch succeeds.

`layout` builds a canvas once. Compiling the same spec onto a canvas that already holds its members returns `canvas_already_laid_out`. Re-layout and update mode are tracked in issue #25.

## check

`enso check [folder]` lints a Vault folder, `.` by default, and exits non-zero when it finds a violation. It reads files and nothing else. No writes, no bridge calls.

```sh
enso check
enso check /path/to/vault --pretty
```

A Note is any markdown file that is not a generated Canvas outline. A Note's title is its filename stem. Outlines start with Enso's generated header and stay out of the wikilink rule. Leftover `*.canvas.md` files are ignored. Graph JSON is a layout command input, not something check lints.

Each violation carries a `code` in the envelope:

| Code                   | Rule                                            |
| ---------------------- | ----------------------------------------------- |
| `frontmatter_invalid`  | Note frontmatter parses                         |
| `duplicate_title`      | Each title is claimed by one file               |
| `unresolved_wikilink`  | Every wikilink resolves to a Note in the folder |

Wikilinks resolve case-insensitively by filename stem or folder-relative markdown path, with or without `.md`. Aliases and headings identify the same Note; escaped alias pipes work in tables. Fenced code blocks hold literal examples. A `duplicate_title` violation lands on every file sharing the value and names the whole set. A clean run prints `ok: true` with the file counts. A failing run prints a `check_failed` envelope whose `details.violations` names every violation in the folder.

## canvas apply

Run `enso canvas apply --schema` for the machine-readable source of truth. Inputs require an explicit canvas name, stable `canvasID`, or `current`, reject unknown fields, and use explicit element modes. Coordinates are in world space: `x`/`y` are centers for Nodes, Portals, and regions, and the text block's top-left for Marks. Lines use endpoints `x1`/`y1` and `x2`/`y2`.

```json
{
  "canvas": "current",
  "nodes": [
    { "kind": "note", "mode": "place", "note": "Client.md", "x": 18300, "y": 18200 },
    { "kind": "note", "mode": "place", "note": "docs/API Gateway.md", "x": 18600, "y": 18200 },
    { "kind": "portal", "mode": "create", "title": "Auth Detail", "subcanvasRef": "Canvases/Auth Detail.json", "x": 18900, "y": 18200 }
  ],
  "links": [
    { "mode": "create", "source": "Client", "target": "API Gateway", "direction": "directed", "label": "calls" }
  ],
  "primitives": [
    { "kind": "region", "mode": "create", "title": "Identity", "x": 18600, "y": 18200, "width": 1200, "height": 700 }
  ]
}
```

```sh
enso canvas apply auth-flow.json --dry-run
enso canvas apply auth-flow.json
rm -f auth-flow.json
```

Use a temporary JSON file so dry-run and apply read the same inspectable bytes, then remove it after verification. Inline JSON and `--json -` remain available for automation.

On an empty Canvas, an intent that only places Notes and creates Portals, primitives, and Marks is translated as one group so its bounds are centered on the app's home point, `(25000, 25000)`. Relative distances and sizes stay the same. Existing content or any update or removal of those elements preserves the supplied coordinates. Dry-run and apply replies report `placement.recentered`, `placement.dx`, and `placement.dy`, plus `placement.home` when translated onto the home point. Verification uses the translated coordinates.

Note placement accepts folder-relative paths with or without `.md`. Verification checks requested coordinates, presentation, Portal destinations, Link endpoints, and DiagramPrimitive geometry against inspected state. Created primitives use their returned IDs. A mismatch returns `verification_failed` with field-specific `mismatches`, `appliedBatches`, and `returnedIds`; use those details to prepare the correction. An already absent Link satisfies a Canvas removal; `fromNote: true` requires a live Link to identify the mentioning sentence.

## Context and vision

```sh
enso context --canvas current --pretty
enso context --canvas current --spec --pretty
enso context --canvas current --full --pretty
enso context --canvas current --vision --pretty
enso context --canvas current --diagnostics --pretty
```

Vision adds a viewport PNG path (downscaled to at most 1568 px on the long edge), the visible rectangle, and layout diagnostics (overlaps, crossings, offscreen nodes). Element world geometry stays in the structural context sections. Use both the screenshot and diagnostics — neither alone is enough to judge layout.

Default Canvas context returns element IDs, meaning, and world geometry for placing and repairing elements, with styling and Note content omitted. `--spec` returns the Canvas as members, edges, clusters, lines, Marks, and Excerpt owners, named by title, for building from it. `--full` returns every Canvas field the app stores, including styling. Note content stays in the Vault files. `--node` and `--query` request focused content. `--diagnostics` returns only Canvas identity, viewport metadata, and visual diagnostics, including issue subjects and repair bounds. It reports `diagnostics_unavailable` when the app supplies no diagnostics.

## Atomic commands

All mutating commands support `--dry-run`.

### Canvas

```sh
enso canvas list --pretty
enso canvas open "Auth Flow"
enso canvas create "Auth Flow" --dry-run
```

### Nodes and portals

```sh
enso node place "docs/API.md" --x 18300 --y 18200 --dry-run
enso node move "API" --x 18600 --y 18200 --dry-run
enso node remove "API" --dry-run
enso node rename "API" "Public API" --dry-run
enso portal create --title "Detail" --subcanvas-ref "Canvases/Detail.json" --dry-run
enso portal open "Detail"
enso portal remove "Detail" --dry-run
```

Place a Note that already exists in the Vault. Write the markdown file first. There is no `node write` and no `node read`; open the file.

`enso node rename "API" "Public API"` renames the Note's markdown file, rewrites `[[wikilinks]]` to it across the Vault, and updates Canvas references to it. Renaming the file by hand breaks its Links; use `node rename` instead. The new title is the filename stem: it has no `.md` suffix, cannot start with a dot or start or end with whitespace, and cannot contain `/`, `:`, `?`, `#`, `|`, `[`, `]`, control characters, or pre-encoded `%xx` sequences. Like `node move`, it finds the Node on the Canvas the app has open; to rename a Note placed elsewhere, `enso canvas open` a Canvas that holds it first. The result reports `from`, `to`, `changed`, `rewrittenWikilinks`, `unreadableNotes` (Notes whose wikilinks could not be scanned), and `updatedCanvases`. An app that predates the command fails with `app_outdated`.

`enso node place "API" --appearance api` places a Note as a symbol Node.
`enso node update "API" --appearance database` changes its visual form.
Use `--appearance card` to reset it, and `--dry-run` to validate a request.
`enso canvas apply` accepts `appearance` on Note place and update intents and Portal create and update intents.
`enso canvas apply --schema` lists the supported values.

`enso node update "API" --glyph-size 72` sets the icon width in World points.
`enso node update "API" --font-size 24` sets the title size.
`enso node update "API" --clear-glyph-size` derives the icon size from the block width.
Canvas intents accept optional `glyphSize` and `fontSize` fields on place, create, and update.
`glyphSize: null` clears an explicit icon size. Icon sizes range from 24 to 160; title sizes range from 8 to 96.

`enso node update API --lock-ratio true` locks the proportions of the complete Node. Use `--lock-ratio false` to resize its parts independently. The setting survives Appearance changes. `--title-gap 12` sets the spacing between the icon and title in World points. Canvas intents accept `isResizeLocked` and `titleGap` for Node placement, creation, and updates.

### Links


| Concept             | Meaning                                     |
| ------------------- | ------------------------------------------- |
| Canvas label        | Short predicate on the link curve           |
| Mention             | A sentence in the source Note holding a wikilink to the target |
| Wikilink            | `[[Target]]` in a Note. Links derive from it |


```sh
enso link create "Source" "Target" --direction directed --color "#3B82F6" --dry-run
enso link update "<id>" --label syncs --dry-run
enso link update "<id>" --clear-label
enso link update "<id>" --label-font-size 12
enso link update "<id>" --line-style dashed
enso link update "<id>" --source "Cache" --dry-run
enso link update "<id>" --target "Database"
enso link update "<id>" --delink --target-position 320,-180
enso link remove "<id>" --dry-run
enso link delete "<id>" --dry-run
```

A Link between two placed Notes stands on a mention: the source Note holds `[[Target]]`. `link create` returns `wikilink_required` when it does not, and a mention alone draws nothing. `link remove` takes the Link off this canvas and keeps the prose. `link delete` deletes the first mentioning sentence from the source Note, on every canvas. `--label` sets the override shown on the curve. `--label ""` displays a blank label, and `--clear-label` restores the Note-derived label. Omitting `--label` during creation uses the Note-derived label. Label options leave the Note intact.

One update moves one endpoint. `--source` re-sources the tail: the old sentence stays, and the new source gets a sentence when it does not mention the target. `--target` re-targets the head and rewrites the token in the first mention. `--delink` detaches the head into open space: the Link goes dangling, the token leaves the first mention, and the prose stays. Re-targeting that head writes the token back into the sentence it left when the line still exists. `--target-position x,y` picks where the dangling head points in World space and applies only with `--delink`. Endpoints resolve like every other selector, with the same `not_found` and `ambiguous_selector` errors. A move that would make a Link start and end at the same Node fails with `invalid_link_endpoint`. The returned link carries `targetPosition` after a delink, so the change is observable.

### DiagramPrimitives

Regions and lines are non-node canvas elements.

```sh
enso primitive region --x 18300 --y 18200 --width 1200 --height 700 --title "Runtime" --dry-run
enso primitive line --x1 17800 --y1 18100 --x2 19400 --y2 18100 --dry-run
enso primitive list --pretty
enso primitive update "<id>" --x 18300 --y 18200 --dry-run
```

## Troubleshooting


| Error                  | Fix                                                 |
| ---------------------- | --------------------------------------------------- |
| `app_unavailable`      | Launch the configured app, or run `enso auth link` to relink |
| `invalid_token`        | Run `enso auth link` separately with the app open; targeted and bound requests are not replayed |
| `access_disabled`      | Turn on Local agent access in Enso's Settings        |
| `bridge_busy`          | Wait for the agent change in flight, then retry      |
| `target_not_active`    | Open the intended canvas explicitly, inspect it, then decide whether to retry |
| `wrong_vault`          | Open the intended vault explicitly in Enso |
| `target_not_found`     | Rediscover stable identities with `enso canvas list` |
| `target_changed`       | Inspect partial effects on the original target before retrying |
| `target_conflict`      | Use one selector or one matching stable binding |
| `invalid_target`       | Supply both valid vault and canvas UUIDs |
| `explicit_navigation_required` | Navigate separately without a binding |
| `app_outdated` / `cli_outdated` | Upgrade the side named by the error |
| `ambiguous_selector`   | Use the candidate list from the error; do not guess |
| Unreadable JSON output | Add `--pretty`                                      |


## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev -- status --pretty
```

To run the local build as the global `enso` command, link it once:

```sh
npm run dev:install
```

This symlinks the global bin into the repo, so every `npm run build` is live
immediately. `npm install -g .` compares only name and version, so it keeps a
stale build whenever the version is unchanged.

## Releases

PRs target `main` and use conventional commit titles. `fix:` bumps the patch
digit, `feat:` the minor, and a `!` or `BREAKING CHANGE:` footer the minor as
well while the package is below 1.0. On every push to `main`, release-please
keeps one release PR open with the next version and its changelog. Merging that
PR tags the version, creates the GitHub release, and publishes to npm through
trusted publishing. npm lists this repo's `release-version.yml` as the package's
publisher, so the job authenticates with its OIDC token and no npm secret
exists. The release PR is opened with the `RELEASE_PLEASE_TOKEN` secret, a
fine-grained personal access token with contents and pull requests write on
this repo, since the org keeps `GITHUB_TOKEN` from opening PRs.
