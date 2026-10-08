# Dogfooding CLI reliability

The DBS flow sessions exercise fresh Canvas creation, revisions, file-based Notes, and diagnostics. This change addresses the concrete CLI obstructions reported in those sessions and the follow-up trial.

## Requirements

1. `enso check` resolves wikilinks by filename stem or Vault-relative markdown path, with or without `.md`, case-insensitively. Aliases, headings, and escaped alias pipes in tables resolve their target. Literal examples in code stay literal. Existing title-collision findings remain part of the folder convention.
2. Note placement accepts folder-relative paths with or without `.md`. Canvas preflight and verification use the app's Note identity rules. Ambiguous Note references receive a structured error; fuzzy search results support discovery and leave file existence validation to the bridge.
3. Canvas apply verifies requested Node coordinates and appearance, Portal destinations, Link presentation and endpoints, and region or line geometry and styling. Created DiagramPrimitives bind to IDs returned by apply. A mismatch returns `verification_failed` with landed batch information so recovery targets the remaining correction.
4. Removing an already absent Canvas Link is idempotent and preserves Note prose. Operations that delete a mentioning sentence still require an existing Link identity.
5. Typed Link create/update and Canvas intents accept `solid`, `dashed`, and `dotted` line styles. Context exports preserve Link styling, dangling endpoint positions, and DiagramPrimitive centers and endpoints.
6. Default Canvas context requests omit Note content. `context --diagnostics` returns Canvas identity and visual diagnostic metadata without the full graph or prose; it preserves bridge errors and reports unavailable diagnostics explicitly. Focused Node/query context keeps its content behavior.
7. Skill installation targets Codex by default and supports explicit agent selection, so a Codex installation uses a supported target.

## Validation

Regression tests exercise the reported failures and mismatched bridge state. Typecheck, the full test suite, build, and live read-only CLI probes validate the change. Adversarial Standards and Spec reviews compare the committed diff against `64a3dcd3d251e269bf5998a21a1826976f24fd2c`.
