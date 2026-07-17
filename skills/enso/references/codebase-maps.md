# Enso Codebase Maps

Read this reference before representing a repository or software architecture on an Enso Canvas. A codebase map answers a maintainer's question with source evidence. Let that question and the repository's own vocabulary determine the abstraction.

## Gather Evidence

Start with the question the map should answer, then inspect enough representative code to support it. Useful evidence may include manifests, runtime entrypoints, registration, generated-code boundaries, configuration, persistence, external clients, operational scripts, tests, or an end-to-end flow. Follow the evidence that reveals how this repository divides responsibility; treat common architectural categories as search prompts rather than a required inventory.

Prefer direct file evidence. Record uncertainty as an open question rather than converting it into an architectural claim. Evidence gathering is complete when every proposed Node has a concrete code anchor and every proposed Link has a stated evidentiary basis.

## Select Architectural Nodes

Choose the level of abstraction that best answers the map's question. Possible signals for a Node include:

- a runtime entrypoint or orchestrator that owns lifecycle, routing, or registration;
- a subsystem with coherent responsibility;
- a state boundary such as a database, cache, queue, filesystem store, in-memory owner, or serialized format;
- an integration boundary such as an API client, native bridge, plugin host, worker, shell command, or protocol;
- a policy boundary such as authorization, validation, conflict resolution, retry, error normalization, migration, or feature flags;
- a build, test, or deployment concern that materially affects the question being mapped.

These are prompts, not a taxonomy. A file, function, type, package, process, or cross-cutting concern may be the right Node when that is the repository's meaningful unit. Keep lower-level detail in Node markdown when promoting it would obscure the answer. Node selection is complete when each Node earns its place in the map's explanation and no two Nodes accidentally represent the same concept.

## Write Evidence-Rich Notes

Write enough evidence in each Note for a maintainer to evaluate the claim without reopening the entire investigation. Depending on the map, useful material includes:

- **Role:** the responsibility it owns;
- **Evidence:** concrete repository paths;
- **Flow:** inputs, outputs, and neighboring boundaries;
- **Invariants:** behavior that callers or maintainers rely on.

Use headings that fit the repository and omit sections that add no value. This is one possible shape for this repository, not a required template:

```markdown
**Role:** Owns CLI command registration and structured result handling.

**Evidence**
- `src/index.ts` assembles command groups and prints envelopes.
- `src/commands/*.ts` define the public command surfaces.
- `test/cli/*.test.ts` verify behavior by workflow.
- `test/support/cli-harness.ts` supplies the shared CLI boundary harness.

**Flow:** argv -> command action -> bridge request -> structured envelope.

**Invariants**
- Agent-facing output remains machine-readable.
- Mutations expose a dry-run path.

**Change risk:** Command-surface changes usually require command registration, workflow tests, and public guidance to move together.
```

Note writing is complete when a maintainer can open every Node, find the supporting code, understand why it appears on this map, and distinguish evidence from open questions.

## Draw the Map

Choose a visual pattern that matches the question: a flow can form a spine, ownership can form clusters, layers can form columns, and change impact can radiate from a focal concept. Use Links only for relationships that help answer the question. Use regions when a boundary clarifies the repository's own structure and a Portal when useful detail would crowd the current explanation.

The map is complete when every Node and Link is evidence-backed, the chosen visual pattern makes the target question easier to answer, and necessary detail remains available in Note content or a Portal without crowding the overview.
