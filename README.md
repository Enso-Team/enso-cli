# Enso CLI

Local CLI for the Enso app. It talks to Enso on your machine and allows agents to read vault context, mutate canvases, and capture viewport diagnostics without editing vault files directly.

## Quick start

Requirements: macOS, Enso app running, Node.js 20+.

```sh
npm install -g @enso-app/cli
enso status --pretty
```

With the Enso app open, the first command links itself by reading the token
file the app provisions. `enso auth link` stays available for relinking.

Install the bundled agent skill:

```sh
enso skill install
npx skills list -g
```

## For agents

Paste this block when onboarding an agent:

```txt
Use the Enso CLI to work with canvases in the Enso Mac app.

Setup:
1. npm install -g @enso-app/cli
2. Launch Enso
3. enso skill install

Default workflow for diagram or canvas work:
1. enso status --pretty
2. enso canvas apply --schema
3. enso context --canvas "<Canvas Name>" --vision --pretty
4. Pipe one explicit-mode intent to: enso canvas apply --json - --dry-run
5. Pipe the same intent to: enso canvas apply --json -

Rules:
- Never edit Canvases/*.json or other vault files directly.
- Use --dry-run before mutations and read its bridge-validation limits.
- Prefer enso canvas apply for multi-element work; use atomic commands for one-off edits.
- Read skills/enso/SKILL.md (installed via enso skill install) for the full workflow.
```

## Command model

Three layers. Compile a whole diagram from a spec, batch a hand-written patch, or edit one element.


| Layer       | When                                  | Commands                                                  |
| ----------- | ------------------------------------- | --------------------------------------------------------- |
| **Compile** | Building a diagram from a graph       | `enso layout <spec.canvas.md>`                            |
| **Batch**   | Building or reshaping a canvas region | `enso canvas apply <file.json>`                          |
| **Atomic**  | One surgical edit                     | `enso node`, `enso link`, `enso portal`, `enso primitive` |
| **Verify**  | Linting an authoring folder           | `enso check [folder]`                                     |


`canvas apply` runs complete local preflight, then applies dependency phases. Each phase is app-atomic; successful earlier phases remain when a later phase fails. The error envelope reports `appliedBatches`, `failedBatch`, returned IDs, and `retrySections`.

## layout

`enso layout` compiles a canvas spec into a `canvas apply` patch. Declare the graph; the CLI owns every coordinate.

A canvas spec is one markdown manifest per canvas. Frontmatter carries members by Note title, visible edges, named clusters, and a direction hint of `TB` or `LR`. The body is the canvas's own prose and never compiles.

```markdown
---
canvas: Request Flow
direction: LR
members:
  - Gateway
  - Router
  - title: Object Store
    mode: reuse
edges:
  - from: Gateway
    to: Router
    label: routes
    direction: directed
  - from: Router
    to: Object Store
clusters:
  - name: Edge
    color: "#6B7280"
    members:
      - Gateway
      - Router
---

How a request reaches the store.
```

```sh
enso layout request-flow.canvas.md --apply
enso canvas apply request-flow.json --dry-run
enso layout request-flow.canvas.md --apply
```

Members become Notes ranked along the direction hint on the shared spacing steps, edges become Links, and each cluster becomes a region whose bounds are its member bounds plus padding. Identical spec input yields byte-identical geometry. `--apply` sends the compiled patch through the `canvas apply` pipeline with its preflight and verification, `--apply --dry-run` validates without mutating, and running without `--apply` prints the compiled patch for inspection. Run `enso layout --schema` for the machine-readable spec contract.

Colors take the app's visual grammar: `#RGB`, `#RRGGBB`, `#RRGGBBAA`, or one of `black`, `blue`, `cyan`, `gray`, `grey`, `green`, `orange`, `pink`, `purple`, `red`, `teal`, `white`, `yellow`. Every path enforces it, so a color outside the grammar fails locally in `layout`, `canvas apply`, `apply`, `link`, and `primitive` alike, before any element reaches the canvas.

`--apply --dry-run` reports `validation.bridgeValidated` and `validation.locallyValidatedOnly`. The app checks the first phase; later phases carry local validation alone until you apply.

`layout` builds a canvas once. Compiling the same spec onto a canvas that already holds its members returns `canvas_already_laid_out`. Re-layout and update mode are tracked in issue #25.

## check

`enso check [folder]` lints an authoring folder, `enso/` by default, and exits non-zero when it finds a violation. It reads files and nothing else. No writes, no bridge calls, so it runs after every edit like a test suite.

```sh
enso check
enso check docs/enso --pretty
```

The folder holds Notes as markdown files and canvases as `*.canvas.md` manifests. A Note's title is its filename stem, the identity `enso layout` resolves manifest members against. A file whose frontmatter sets `generated: true` is a generated outline, a read-only projection. Outlines keep their UUIDs unique like any other file, their bodies stay out of the wikilink rule, and no manifest may list one as a member.

Each violation carries a `code` in the envelope:

| Code                            | Rule                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| `frontmatter_invalid`           | Note or manifest frontmatter parses                         |
| `duplicate_uuid`                | Each `uuid` is claimed by one file                          |
| `duplicate_title`               | Each title is claimed by one file                           |
| `unresolved_wikilink`           | Every wikilink resolves to a Note in the folder             |
| `missing_canvas_member`         | Every manifest member matches a Note                        |
| `generated_outline_referenced`  | No manifest references a generated outline                  |
| `duplicate_member`              | Each manifest declares a member once                        |
| `duplicate_edge`                | Each manifest declares an edge once                         |
| `self_edge`                     | No edge points at its own endpoint                          |
| `edge_endpoint_not_member`      | Both endpoints of an edge are canvas members                |
| `duplicate_cluster`             | Each manifest declares a cluster name once                  |
| `cluster_member_outside_canvas` | Every cluster member is also a canvas member                |
| `member_in_two_clusters`        | Each member belongs to at most one cluster                  |

Wikilinks resolve in Note bodies and in a manifest's prose body alike, and a wikilink inside a fenced code block is a sample rather than a link. A `duplicate_uuid` or `duplicate_title` violation lands on every file sharing the value and names the whole set, since a collision has no original.

A Note without a `uuid` reports as a warning and the folder still passes. Stable UUIDs become expected when the app reads folders directly. Duplicate UUIDs always fail. A clean run prints `ok: true` with the file counts and any warnings. A failing run prints a `check_failed` envelope whose `details.violations` names every violation in the folder, each with its file, message, and, where one applies, its line. One broken file never hides the rest.

## canvas apply

Run `enso canvas apply --schema` for the machine-readable source of truth. Inputs require an explicit Canvas name or `current`, reject unknown fields, and use explicit element modes. All `x`/`y` values are element centers in world coordinates.

```json
{
  "canvas": "current",
  "nodes": [
    { "kind": "note", "mode": "create", "title": "Client", "content": "# Client\n", "x": 18300, "y": 18200 },
    { "kind": "note", "mode": "reuse", "selector": "API Gateway", "x": 18600, "y": 18200 },
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

## Context and vision

```sh
enso context --canvas current --pretty
enso context --canvas current --vision --pretty
```

Vision adds a viewport PNG path (downscaled to at most 1568 px on the long edge), the visible rectangle, and layout diagnostics (overlaps, crossings, offscreen nodes). Element world geometry stays in the structural context sections. Use both the screenshot and diagnostics — neither alone is enough to judge layout.

## Atomic commands

All mutating commands support `--dry-run`.

### Canvas

```sh
enso canvas list --pretty
enso canvas open "Auth Flow"
enso canvas create "Auth Flow" --dry-run
enso canvas inspect "Auth Flow" --pretty
```

### Nodes and portals

```sh
enso node create --title "API" --content @note.md --x 18300 --y 18200 --dry-run
enso node write "API" --content @note.md --dry-run
enso node move "API" --x 18600 --y 18200 --dry-run
enso node remove "API" --dry-run
enso portal create --title "Detail" --subcanvas-ref "Canvases/Detail.json" --dry-run
enso portal open "Detail"
enso portal remove "Detail" --dry-run
```

Portal nodes do not carry markdown — use `enso node write` only on note nodes.

### Links


| Concept             | Meaning                                     |
| ------------------- | ------------------------------------------- |
| Canvas label        | Short predicate on the link curve           |
| Bound relation line | Source note markdown line owned by the link |
| Wikilink            | `[[Target]]` inside the bound line          |


```sh
enso link create "Source" "Target" --direction directed --color "#3B82F6" --dry-run
enso link update "<id>" --label syncs --dry-run
enso link update "<id>" --bound-line "Streams events to [[Target]]"
enso link update "<id>" --sync-prose
enso link update "<id>" --source "Cache" --dry-run
enso link update "<id>" --target "Database"
enso link update "<id>" --delink --target-position 320,-180
enso link remove "<id>" --dry-run
enso link delete "<id>" --dry-run
```

`link remove` removes the Canvas-local Link and preserves relation prose. `link delete` removes the bound relation line from the source Note across canvases. `--label` changes the canvas label only; `--bound-line` rewrites Note prose; `--sync-prose` copies the label into the bound line.

One update moves one endpoint. `--source` re-sources the tail and moves the bound relation line to the new source Note, appended at its end. `--target` re-targets the head and rewrites the `[[wikilink]]` token in the bound line. `--delink` detaches the head into open space: the Link goes dangling and unbound, the wikilink token is removed, and the prose stays. `--target-position x,y` picks where the dangling head points in World space and applies only with `--delink`. Endpoints resolve like every other selector, with the same `not_found` and `ambiguous_selector` errors. A move that would make a Link start and end at the same Node fails with `invalid_link_endpoint`. An endpoint move never travels with `--bound-line` or `--sync-prose`, since the line would validate against the stale target, and the CLI refuses those combinations before sending. The returned link carries `targetPosition` after a delink, so the change is observable.

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
| `invalid_token`        | Run `enso auth link` to replace the stale pairing    |
| `access_disabled`      | Turn on Local agent access in Enso's Settings        |
| `bridge_busy`          | Wait for the agent change in flight, then retry      |
| `canvas_changed`       | The user changed the open Canvas; inspect `appliedBatches`, reopen the target, and resume |
| `pairing_in_progress`  | Wait for the active pairing attempt                  |
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
