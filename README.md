# Enso CLI

Local CLI for the Enso app. It talks to Enso on your machine and allows agents to read vault context, mutate canvases, and capture viewport diagnostics without editing vault files directly.

## Quick start

Requirements: macOS, Enso app running, Node.js 20+.

```sh
npm install -g @enso-app/cli
enso auth link
enso status --pretty
```

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
2. Launch Enso, then: enso auth link
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
enso layout request-flow.canvas.md --out request-flow.json
enso canvas apply request-flow.json --dry-run
enso layout request-flow.canvas.md --apply
```

Members become Notes ranked along the direction hint on the shared spacing steps, edges become Links, and each cluster becomes a region whose bounds are its member bounds plus padding. Identical spec input yields byte-identical geometry, so the emitted patch is reviewable in a diff. `--out` writes the patch, `--apply` sends it through the `canvas apply` pipeline with its preflight and verification, and `--apply --dry-run` validates without mutating. Run `enso layout --schema` for the machine-readable spec contract.

Colors take the app's visual grammar: `#RGB`, `#RRGGBB`, `#RRGGBBAA`, or one of `black`, `blue`, `cyan`, `gray`, `grey`, `green`, `orange`, `pink`, `purple`, `red`, `teal`, `white`, `yellow`. Every path enforces it, so a color outside the grammar fails locally in `layout`, `canvas apply`, `apply`, `link`, and `primitive` alike, before any element reaches the canvas.

`--apply --dry-run` reports `validation.bridgeValidated` and `validation.locallyValidatedOnly`. The app checks the first phase; later phases carry local validation alone until you apply.

`layout` builds a canvas once. Compiling the same spec onto a canvas that already holds its members returns `canvas_already_laid_out`. Re-layout and update mode are tracked in issue #25.

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
enso link remove "<id>" --dry-run
enso link delete "<id>" --dry-run
```

`link remove` removes the Canvas-local Link and preserves relation prose. `link delete` removes the bound relation line from the source Note across canvases. `--label` changes the canvas label only; `--bound-line` rewrites Note prose; `--sync-prose` copies the label into the bound line.

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
