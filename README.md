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
2. enso canvas open "<Canvas Name>"
3. enso context --canvas current --vision --pretty   # once, for placement
4. Write a JSON file (e.g. auth-flow.json) with nodes, links, regions, dividers, lines
5. enso canvas apply auth-flow.json --dry-run
6. enso canvas apply auth-flow.json
7. enso context --canvas current --pretty            # verify counts (use --vision only for layout/diagnostics)

Rules:
- Never edit Canvases/*.json or other vault files directly.
- Use --dry-run before mutations.
- Prefer enso canvas apply for multi-element work; use atomic commands for one-off edits.
- Read skills/enso-agent/SKILL.md (installed via enso skill install) for the full workflow.
```

## Command model

Two layers — use the batch path by default.


| Layer      | When                                  | Commands                                                  |
| ---------- | ------------------------------------- | --------------------------------------------------------- |
| **Batch**  | Building or reshaping a canvas region | `enso canvas apply <file.json>`                           |
| **Atomic** | One surgical edit                     | `enso node`, `enso link`, `enso portal`, `enso primitive` |


`canvas apply` compiles a JSON file into ordered bridge patches: **nodes/portals → links → DiagramPrimitives**. Links cannot reference nodes created in the same patch, so the CLI splits them automatically.

Raw `enso apply patch.json` remains for low-level operations not covered by `canvas apply`.

## canvas apply

Write a descriptive JSON file per canvas (e.g. `auth-flow.json`), with explicit world-space geometry on every new element. All `x`/`y` values are element **centers** in world coordinates.

```json
{
  "canvas": "Auth Flow",
  "nodes": [
    { "kind": "note", "title": "Client", "content": "# Client\n", "x": 18300, "y": 18200 },
    { "kind": "existing", "title": "API Gateway", "x": 18600, "y": 18200 },
    { "kind": "portal", "title": "Auth Detail", "subcanvasRef": "Canvases/Auth Detail.json", "x": 18900, "y": 18200 }
  ],
  "links": [
    { "source": "Client", "target": "API Gateway", "direction": "directed", "label": "calls" }
  ],
  "regions": [
    { "title": "Identity", "x": 18600, "y": 18200, "width": 1200, "height": 700 }
  ],
  "dividers": [
    { "title": "Control plane", "orientation": "horizontal", "x": 18600, "y": 18020, "length": 1600 }
  ],
  "lines": [
    { "title": "Section split", "x1": 18600, "y1": 18400, "x2": 19800, "y2": 18400 }
  ]
}
```

```sh
enso canvas apply auth-flow.json --dry-run
enso canvas apply auth-flow.json
```

Node kinds: `note` (new note), `existing` (place an existing note), `portal` (drill-down entry point).

## Context and vision

```sh
enso context --canvas current --pretty
enso context --canvas current --vision --pretty
```

Vision adds a viewport PNG path, visible rectangle, element geometry, and layout diagnostics (overlaps, crossings, offscreen nodes). Use both the screenshot and diagnostics — neither alone is enough to judge layout.

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
enso portal create --title "Detail" --subcanvas-ref "Canvases/Detail.json" --dry-run
enso portal open "Detail"
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
```

`--label` changes the canvas label only. `--bound-line` rewrites note prose. `--sync-prose` copies the label into the bound line.

### DiagramPrimitives

Regions, dividers, and lines are non-node canvas elements.

> **Breaking change (0.5.0):** the `enso diagram` command group is renamed to `enso primitive`, and its `group` subcommand to `region`. Bridge operation types (`group.create`, `divider.create`, …) are unchanged. Update any stored agent prompts or scripts that call `enso diagram …`.

```sh
enso primitive region --x 18300 --y 18200 --width 1200 --height 700 --title "Runtime" --dry-run
enso primitive divider --orientation horizontal --x 18300 --y 18020 --length 1600 --dry-run
enso primitive line --x1 17800 --y1 18100 --x2 19400 --y2 18100 --dry-run
enso primitive list --pretty
enso primitive update "<id>" --x 18300 --y 18200 --dry-run
```

## Low-level apply

For operations not covered by `canvas apply`, use a patch file of bridge operations:

```sh
enso apply patch.json --dry-run
enso apply patch.json
```

Split node and link operations into separate patches when creating both in one pass — links cannot bind to nodes created in the same apply call.

## Troubleshooting


| Error                  | Fix                                                 |
| ---------------------- | --------------------------------------------------- |
| `app_unavailable`      | Launch the Enso app                                 |
| `invalid_token`        | `enso auth unlink && enso auth link`                |
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

