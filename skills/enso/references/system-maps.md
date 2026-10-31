# Enso System Maps

Read this reference before representing a system design, software architecture, or repository on an Enso Canvas, whether it comes from code or from an existing diagram or design doc. A system map answers a maintainer's question with evidence. Let that question and the system's own vocabulary determine the abstraction.

## Gather Evidence

### From a repository

Start with the question the map should answer, then inspect enough representative code to support it. Useful evidence may include manifests, runtime entrypoints, registration, generated-code boundaries, configuration, persistence, external clients, operational scripts, tests, or an end-to-end flow. Follow the evidence that reveals how this repository divides responsibility; treat common architectural categories as search prompts rather than a required inventory.

Prefer direct file evidence. Evidence gathering is complete when every proposed Node has a concrete code anchor and every proposed Link has a stated evidentiary basis.

### From an existing design

Treat the source (a design doc, Mermaid or PlantUML, Excalidraw, an image, a whiteboard photo) as the spec. Read the whole source before building; view images with the Read tool.

Build a **crosswalk**: one row per source element with its Enso counterpart.

- box, service, or store → Note, keeping the source's name so the user recognizes it;
- arrow → Link, keeping its direction and label; a sentence in the source Note carries the `[[Target]]`;
- boundary, tier, or trust zone → region; swimlane → line plus a lane-label Mark;
- legend, title, or annotation → Mark;
- nested sub-diagram → Portal;
- merged or dropped element → the reason.

Each source group becomes a `layout` cluster, and the source's flow direction becomes the layout `direction`. A Node belongs to one cluster, so for nested boundaries such as subnets inside a VPC, lay out the innermost boundaries as clusters, then draw each enclosing region with `canvas apply` from the inner regions' bounds plus padding. Where the source is ambiguous, such as an unlabeled arrow or an overloaded box, ask in a question Mark and keep the source's wording until the user answers. When the user also wants the design checked against code, gather repository evidence as well and record each mismatch in the Note as an observation.

The crosswalk is complete when every source box, arrow, boundary, and annotation has a row.

## Select Architectural Nodes

The map's scope sets what a Node is: a subsystem for a whole codebase, a file or type for a module, a file or function for one question. When a file's functions matter separately, draw the file as a region labeled with its path, holding its functions as Nodes. In `enso layout`, that is one cluster per file.

Choose the level of abstraction that best answers the map's question. For a port, the source's boxes set the default level; change it only for a stated reason recorded in the crosswalk. Possible signals for a Node include:

- a runtime entrypoint or orchestrator that owns lifecycle, routing, or registration;
- a subsystem with coherent responsibility;
- a state boundary such as a database, cache, queue, filesystem store, in-memory owner, or serialized format;
- an integration boundary such as an API client, native bridge, plugin host, worker, shell command, or protocol;
- a policy boundary such as authorization, validation, conflict resolution, retry, error normalization, migration, or feature flags;
- a build, test, or deployment concern that materially affects the question being mapped.

These are prompts, not a taxonomy. A file, function, type, package, process, or cross-cutting concern may be the right Node when that is the system's meaningful unit. Keep lower-level detail in Node markdown when promoting it would obscure the answer. Node selection is complete when each Node earns its place in the map's explanation and no two Nodes accidentally represent the same concept.

## Write Evidence-Rich Notes

Write enough evidence in each Note for a maintainer to evaluate the claim without reopening the entire investigation. Depending on the map, useful material includes:

- **Role:** the responsibility it owns;
- **Evidence:** the code behind the claim, or the source section or diagram it came from;
- **Flow:** inputs, outputs, and neighboring boundaries;
- **Invariants:** behavior that callers or maintainers rely on.

Use headings that fit the system and omit sections that add no value. For example:

```markdown
**Role:** Owns CLI command registration and structured result handling.

**Evidence:** a snippet for each claim, as "Write on the canvas" in SKILL.md describes.

**Flow:** argv -> command action -> bridge request -> structured envelope.

**Invariants**
- Agent-facing output remains machine-readable.
- Mutations expose a dry-run path.

**Change risk:** Command-surface changes usually require command registration, workflow tests, and public guidance to move together.
```

Note writing is complete when a maintainer can open every Node, find its supporting evidence, understand why it appears on this map, and distinguish evidence from open questions.

## Draw the Map

Choose the visual structure from [diagram-design.md](diagram-design.md) that matches the question. For a port, keep the source's arrangement unless the user asks for a new one.

The map is complete when every Node and Link is evidence-backed. A port is complete when every crosswalk row is on the Canvas or carries its stated reason, and a `context --vision` render matches the source's topology.
