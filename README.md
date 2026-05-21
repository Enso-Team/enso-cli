# Enso CLI

Enso CLI is the local command line bridge for the Enso Mac app. It lets agents and developers inspect an Enso vault, read canvas context, create and move note nodes, create portal nodes for drill-down canvases, create links, add diagram primitives, and request viewport screenshots with layout diagnostics.

## Give This To Your Agent

If you are setting up Enso CLI for an AI coding agent, paste this whole block into the agent:

```txt
Install and configure the Enso CLI.

1. Make sure Node.js 20 or newer is installed.
2. Install the CLI:
   npm install -g @enso-app/cli
3. Make sure the Enso Mac app is installed and running.
4. Pair the CLI with the app:
   enso auth link
5. Confirm the bridge works:
   enso status --pretty
6. Install the bundled Enso agent skill:
   enso skill install
   # equivalent direct Skills CLI command:
   npx skills add "$(npm root -g)/@enso-app/cli/skills/enso-agent" -g -y --copy
7. Confirm the skill is installed:
   npx skills list -g
8. When working with Enso, start with:
   enso status --pretty
   enso context --canvas current --pretty
9. When visual layout matters, use:
   enso context --canvas current --vision --pretty
10. Before mutating a canvas, always use --dry-run first, especially with:
   enso apply patch.json --dry-run
   enso apply patch.json
```

## What Is Enso?

Enso is a Mac app for working with spatial notes, diagrams, canvases, and markdown-backed knowledge graphs. A canvas can contain note nodes, portal nodes, links, labels, groups, dividers, arbitrary lines, ink, annotations, and subcanvases for drill-down detail.

The CLI does not replace the app. The app owns the vault, rendering, permissions, screenshot capture, and geometry. The CLI is a thin local JSON client that talks to the Enso app bridge on your machine.

This means agents can:

- Inspect the current canvas and nearby graph context.
- Read and write note markdown content.
- Create, move, and delete note nodes.
- Create, open, retarget, and delete portal nodes.
- Create and update links with labels, directions, and colors.
- Add group boundaries, section dividers, and arbitrary diagram lines.
- Attach or open subcanvases on diagram primitives.
- Capture viewport-only visual context with screenshot metadata and diagnostics.
- Apply multi-operation patches with a dry-run validation pass.

## Requirements

- macOS with the Enso Mac app installed.
- Node.js `>=20`.
- The Enso app must be running when you use bridge-backed commands.
- The CLI must be paired with the app using `enso auth link`.

## Install

Install globally from npm:

```sh
npm install -g @enso-app/cli
```

Check that the binary is available:

```sh
enso --help
```

Pair with the local Enso app:

```sh
enso auth link
```

Then verify the bridge:

```sh
enso status --pretty
```

If pairing opens the app, approve the pairing request in Enso. The CLI stores a local token after pairing.

## Install The Agent Skill

The npm package includes an `enso-agent` skill for Codex-style agents. `enso skill install` delegates to the open Skills CLI installer, so the Enso command and the direct `npx skills` command use the same installation path.

### Install With The Enso CLI

The simplest path is:

```sh
enso skill install
```

Internally, this runs the Skills CLI against the bundled skill:

```sh
npx --yes skills add <bundled-enso-agent-skill-path> -g -y --copy
```

### Install Directly With `npx skills`

You can also run the equivalent command yourself:

```sh
npx skills add "$(npm root -g)/@enso-app/cli/skills/enso-agent" -g -y --copy
```

Then confirm it is installed:

```sh
npx skills list -g
```

If you do not want to install `@enso-app/cli` globally, install it into a project first:

```sh
npm install @enso-app/cli
npx skills add ./node_modules/@enso-app/cli/skills/enso-agent -g -y --copy
```

The `npx skills` installer reads the skill metadata from `skills/enso-agent/SKILL.md` and installs it into your agent skills directory.

The skill teaches agents the safe Enso workflow:

- Run `enso status --pretty` first.
- Read context before editing.
- Use `enso context --canvas current --vision --pretty` for diagram layout work.
- Inspect screenshots and diagnostics together.
- Use `--dry-run` before mutations.
- Prefer portal nodes or diagram primitive subcanvases for detailed drill-downs instead of crowding one canvas.
- Never edit Enso vault files directly.

## Basic Usage

All commands return a JSON envelope. Use `--pretty` for formatted output:

```sh
enso status --pretty
```

### Authentication

```sh
enso auth link
enso auth status --pretty
enso auth unlink
```

### Vault And Canvas Discovery

```sh
enso vault --pretty
enso canvas list --pretty
enso canvas current --pretty
enso canvas inspect "My Canvas" --pretty
enso canvas open "My Canvas"
```

### Context For Agents

Get semantic context for the current canvas:

```sh
enso context --canvas current --pretty
```

Get semantic context plus viewport visual context:

```sh
enso context --canvas current --vision --pretty
```

The vision response may include:

- A temporary PNG path for the Enso viewport.
- Viewport scale and visible rectangle.
- Node bounds and selection state.
- Link, label, and diagram primitive geometry.
- Diagnostics for overlaps, offscreen labels, link crossings, link-node intersections, and cramped spacing.

The screenshot is intentionally scoped to the Enso canvas viewport. It should not capture the whole screen or unrelated app chrome.

### Nodes

Node responses may include `kind: "note"` or `kind: "portal"`. Note nodes may have markdown content, refs, tags, and markdown links. Portal nodes have a `subcanvasRef`, do not carry markdown/ref/tag/link state, and should not be written with `enso node write`.

```sh
enso node list --canvas current --pretty
enso node read "Node Title" --pretty
enso node create --title "New Node" --content "Markdown body" --dry-run
enso node create --title "New Node" --content "Markdown body"
enso node write "Node Title" --content @note.md --dry-run

Inline `--content` and `--bound-line` strings automatically turn shell-style `\n` into real newlines before JSON encoding. Prefer `@file` for long markdown, or use `$'line one\nline two'` in bash if you need explicit control.
enso node move "Node Title" --x 1200 --y 900 --dry-run
enso node neighbors "Node Title" --depth 2 --pretty
```

### Portals

Portal nodes represent drill-down canvases. Create the target canvas first with `enso canvas create` when needed, then create a portal to its canvas ref.

```sh
enso portal create --title "Sync Server Detail" --subcanvas-ref "Canvases/Sync Server Detail.json" --dry-run
enso portal create --title "Sync Server Detail" --subcanvas-ref "Canvases/Sync Server Detail.json"
enso portal open "Sync Server Detail"
enso portal change-subcanvas "Sync Server Detail" "Canvases/Existing Detail.json" --dry-run
```

### Links and relation sync

Three concepts (do not conflate):

| Concept | Meaning | Where it lives |
|--------|---------|----------------|
| Canvas label | Graph predicate on the link | `link.label` in bridge response |
| Wikilink | `[[TargetTitle]]` in source note | vault `.md` |
| Bound occurrence | One anchored line owned by the link | `primaryBinding` + line in source note |

Rules:

- `link create` always establishes `primaryBinding` and inserts `Related: [[Target]]` in the source note (even when `--label` is omitted).
- `link update --label` sets the **canvas label only** — it does not rewrite bound markdown.
- `link update --bound-line` replaces the owned relation line in the source note (custom prose; must include the target wikilink, which may appear anywhere in the line). Does not change the canvas label.
- `link update --sync-prose` rewrites the bound line from the canvas label or Related fallback (use when note text should mirror the label, not for longer custom prose).
- A second `link create` between the same undirected pair returns `duplicate_link`.
- After `node write`, re-fetch links if binding state matters (`isUnbound`, `primaryBinding.status`).

```sh
enso link create "Source Node" "Target Node" --direction directed --color "#3B82F6" --dry-run
enso link list --pretty
enso link update "link-id" --label "implements" --dry-run
enso link update "link-id" --bound-line "Streams domain events to consumers: [[Event Bus]]"
enso link update "link-id" --bound-line @relation-line.md
enso link update "link-id" --sync-prose
enso link update "link-id" --clear-label --dry-run
```

Typical workflow (short canvas label + longer bound prose):

```sh
enso link create "Source" "Target"
enso link update "<id>" --label syncs
enso link update "<id>" --bound-line "Streams domain events to downstream consumers: [[Event Bus]]"
```

When note text should mirror the canvas label:

```sh
enso link update "<id>" --label implements --sync-prose
```

Use consistent link semantics when building diagrams:

- Blue for auth or identity.
- Violet for authorization or feature gates.
- Green for sync or live traffic.
- Amber for persistence.
- Cyan for restore, hydrate, agent context, or inspection.
- Gray for supporting dependencies or operational side effects.

### Diagram Primitives

Use diagram primitives to make technical diagrams easier to read:

```sh
enso diagram group --x 1000 --y 1000 --width 1200 --height 700 --title "Persistence" --color "#6B7280" --dry-run
enso diagram divider --orientation vertical --x 2200 --y 900 --length 900 --title "Network boundary" --color "#6B7280" --dry-run
enso diagram line --x1 1000 --y1 1800 --x2 2200 --y2 1800 --title "Restore path" --color "#06B6D4" --dry-run
```

Groups, dividers, and lines can also have subcanvases attached.

### Subcanvases

Subcanvases are useful when a portal node or group needs implementation detail without crowding the overview. Use portal nodes for node-level drill-downs. Diagram primitives still support direct subcanvas commands.

```sh
enso canvas create "Sync Server Detail" --dry-run
enso portal create --title "Sync Server Detail" --subcanvas-ref "Canvases/Sync Server Detail.json" --dry-run
enso portal open "Sync Server Detail"
enso diagram create-subcanvas "group-id" --name "Group Detail" --dry-run
```

### Multi-Operation Patches

For larger changes, use `enso apply` with a patch file:

```json
{
  "operations": [
    {
      "type": "node.create",
      "title": "Client",
      "content": "# Client\n\nEntry point for user traffic."
    },
    {
      "type": "node.create",
      "title": "API",
      "content": "# API\n\nHandles authenticated requests."
    },
    {
      "type": "portal.create",
      "title": "API Detail",
      "subcanvasRef": "Canvases/API Detail.json"
    },
    {
      "type": "node.move",
      "selector": "Client",
      "x": 1000,
      "y": 1000
    },
    {
      "type": "node.move",
      "selector": "API",
      "x": 1450,
      "y": 1000
    },
    {
      "type": "link.create",
      "source": "Client",
      "target": "API",
      "direction": "directed",
      "color": "#10B981"
    },
    {
      "type": "link.update",
      "id": "<link-id-from-create>",
      "label": "syncs"
    },
    {
      "type": "link.update",
      "id": "<link-id-from-create>",
      "boundLine": "Streams domain events to downstream consumers: [[API]]"
    },
    {
      "type": "portal.open",
      "selector": "API Detail"
    }
  ]
}
```

Validate first:

```sh
enso apply patch.json --dry-run
```

Then apply:

```sh
enso apply patch.json
```

## Agent Workflow For Diagram Work

When an agent is creating or improving a diagram:

1. Run `enso status --pretty`.
2. Run `enso context --canvas current --vision --pretty`.
3. Inspect both the screenshot at `data.vision.image.path` and `data.vision.diagnostics`.
4. Treat the screenshot as a viewport sample, not a requirement that the entire graph fit on screen.
5. Fix node overlaps and accidental clipping first.
6. Then fix label overlaps, link-node intersections, link crossings, and cramped spacing.
7. Use groups, dividers, link colors, portal nodes, and subcanvases for hierarchy.
8. Run `enso apply --dry-run` before mutating.
9. Apply, recapture vision context, and iterate.

A good Enso diagram should be spacious, readable, and navigable. Do not compress a complex system into one viewport if subcanvases or a larger canvas communicate it better.

## Troubleshooting

### `app_unavailable`

The Enso Mac app is not running or the local bridge is unavailable. Open the Enso app and try again:

```sh
enso status --pretty
```

### `invalid_token`

The CLI is not paired with the current app bridge token. Relink:

```sh
enso auth unlink
enso auth link
```

### Pairing Times Out

Make sure the Enso app is open and approve the pairing request in the app. Pairing waits for up to two minutes.

### Command Output Is Hard To Read

Use:

```sh
enso --pretty <command>
```

or:

```sh
enso status --pretty
```

## Development

From the repository:

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev -- status --pretty
```

Before publishing:

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm publish --access public
```
