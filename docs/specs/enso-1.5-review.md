# Enso 1.5 CLI review readiness

Audit date: 2026-10-11. Deadline deliverable: implementation and issue accounting ready for review. Publication is a separate release decision.

## Governing design

The source canvas is **Enso 1.5 release** in `/Users/kaungzinye/Documents/New Enso Round`, selector `Canvases/Enso 1.5 release.json`. Its governing notes are `Enso 1.5/CLI contracts.md`, `Writing resize.md`, `Release contract.md`, and `Review gate.md`. The app implementation specification is `enso/docs/specs/enso-1.5-implementation.md`.

The review gate requires an automatically triggered Greptile review at each coherent PR checkpoint, actionable findings addressed, checks rerun, pictures, and evidence that the final head is reviewed. Open acceptance items remain explicit.

## Branch and publication boundary

The agreed CLI baseline is `eeb2fea6a1f501804a8f1a70368ae5e4627acfc9` on main. The implementation branch is `feat/enso-1.5-contracts`; its audited head is `d1b727b95ab43321833ccd1eaaf0436a6d4a72d2`.

Its implementation commits are:

- `af7e702512b246d4ce6bc9db4f6e1ceb9183bd67` — `feat(cli): validate canvas edits and complete agent setup`.
- `d1b727b95ab43321833ccd1eaaf0436a6d4a72d2` — `fix(cli): keep bundled skill provenance inside its package`.

GitHub has no CLI staging branch. The local staging ref is `a80946e8b13992a1ca4302372b91d94162afe0a6`, an ancestor 37 commits behind the agreed baseline. Its workflow includes publication on staging pushes. The safe review base is a remote staging ref at the agreed baseline, followed by a feature-branch PR targeting staging. Parent coordination owns the push and PR after bridge compatibility checks.

At the agreed baseline, `.github/workflows/ci.yml` runs typechecking and tests for every PR base. Its push trigger selects main. `.github/workflows/release-version.yml` selects main pushes and manual dispatch; it runs release-please and publishes when the package version is absent from npm. A staging ref at this baseline and a staging-target PR stay within the review boundary. Main promotion and release-workflow dispatch carry a publication consequence.

The package version is `0.8.1`. The open release-please PR is [#88](https://github.com/Enso-Team/enso-cli/pull/88), targeting main, head `6a363b64a9d39824b52c64d6edaa71e7ad0957ef`. A PR for the implementation branch is absent at audit time.

## Automatic Greptile gate

GitHub's organization installations API confirms `greptile-apps`, app ID `867647`, installation `129349588`, with access to all organization repositories and pull-request events. Repository enablement and an actual review require separate evidence.

[PR #13's Greptile summary](https://github.com/Enso-Team/enso-cli/pull/13#issuecomment-4809705217) shows a bot review on head `023e0135d9cae90b061ebbc0d79269a2b8dc485b`. Its branch contains root `greptile.json`. The implementation branch supplies `.greptile/config.json` for the agreed automatic review checkpoint.

The sampled recent PRs have GitHub Actions test checks and zero Greptile comments or formal reviews:

| PR | Audited head |
| --- | --- |
| [#92](https://github.com/Enso-Team/enso-cli/pull/92) | `119160e4bd36596293f027329819db3eb721188b` |
| [#91](https://github.com/Enso-Team/enso-cli/pull/91) | `11b434e3f3bc5cabedca120b2d9f440feccedca0` |
| [#90](https://github.com/Enso-Team/enso-cli/pull/90) | `82abc82130e40c76b0e802b504b645a6a539893f` |
| [#89](https://github.com/Enso-Team/enso-cli/pull/89) | `68d4a931f230870d3d5ef437d673ea9fb4716d70` |
| [#88](https://github.com/Enso-Team/enso-cli/pull/88) | `6a363b64a9d39824b52c64d6edaa71e7ad0957ef` |

Installed Greptile CLI `3.0.7` authenticates to organization `enso`. Its command surface exposes review and authentication, with no effective repository configuration reader. Dashboard enablement remains unverified. The CLI's local review command does not satisfy the selected PR review checkpoint.

### Repository configuration

The ready PR supplies this configuration at `.greptile/config.json`:

```json
{
  "autoReview": ["open", "push", "rebase"],
  "triggerOnDrafts": false,
  "statusCheck": true,
  "statusCommentsEnabled": true,
  "shouldUpdateDescription": false,
  "hideFooter": false
}
```

Greptile reads source-branch settings for the PR and gives repository configuration priority over dashboard settings. This enables opening, commit pushes, and history rewrites as automatic triggers. A draft checkpoint requires `triggerOnDrafts: true`. The supported `triggerOnUpdates: true` spelling has the same events as this array. These fields and precedence are documented in the [configuration guide](https://www.greptile.com/docs/code-review/greptile-config), [file reference](https://www.greptile.com/docs/code-review/greptile-config-reference), and [trigger reference](https://www.greptile.com/docs/code-review/greptile-json-reference).

Acceptance: record a completed Greptile check or bot review that identifies the current PR head, inspect its findings, address actionable findings, and verify the updated final head receives automatic review. A queued check, repository file, app installation, or unrelated historical review leaves this gate open. Missing signals require checking repository enablement and filters using [Greptile's troubleshooting guide](https://www.greptile.com/docs/troubleshooting/common-issues).

## Issue accounting draft

| Issue | Implementation and evidence | Open acceptance |
| --- | --- | --- |
| [#93 — apply edits to regions returned by context](https://github.com/Enso-Team/enso-cli/issues/93) | Intent preflight accepts context's `group`, normalizes to `region`, preserves group wire operations, and returns precise kind errors. Public CLI tests cover plan verification and rejection before mutations. | Create, inspect, update, and remove against the supported released app and reviewed development bridge; record exact versions and results. |
| [#96 — explain invalid note filenames before writing](https://github.com/Enso-Team/enso-cli/issues/96) | Canvas and portal names and node note selectors validate before bridge mutation. Tests cover empty/dot components, separators, control characters, safe Unicode, byte limits, and folder-relative notes. Bundled skill requires validation before note filesystem writes. | CLI provides note placement, not note creation. Arbitrary agent shell writes follow the skill's authoring rule; the CLI cannot intercept those writes. Record this capability boundary in issue acceptance. |
| [#94 — install the skill for the intended coding agent](https://github.com/Enso-Team/enso-cli/issues/94) | Default installation targets all detected supported agents noninteractively. Explicit targets validate before writes. Package-confined source, SHA-256 provenance, per-target results, npm/Bun executables, and setup blockers have boundary tests. Packaged CLI rejects a missing bundled source even when a sibling skill exists. | Real SDK installation in disposable fresh/existing agent homes, project-only destinations, and the distributed Bun-owned package remain runtime acceptance items. User agent folders remain untouched by the audit. |
| [#95 — show the right update path for each installation](https://github.com/Enso-Team/enso-cli/issues/95) | Ownership tests cover npm/Bun global installations, links, and project installs; update failures and registry failures report precise actions. `enso setup` and `enso skill install` refresh the bundled skill and report provenance. | Disposable real global npm/Bun update and linked/project guidance checks remain runtime acceptance items. Package publication is a separate decision. |
| [App #559 — mark resizing](https://github.com/Enso-Team/enso/issues/559) | CLI mark/excerpt font size accepts finite world-point values 8–96. Reset sends 17 and retains width. Tests cover commands, strict intents, read projections, and geometry estimates. | Reviewed native bridge must persist and return fontSize, default 17, for mark create/update and excerpt update. Parent owns Swift models, CRDT adapters, bridge operations, and native resizing. |

`enso setup` verifies local CLI provenance, bridge health/status, pairing, access, and bundled skill installation. It attempts launching an installed Mac app when bridge discovery requires it. Missing app, unavailable bridge, unpaired access, and disabled agent access have structured blockers. App version and capabilities remain explicitly unknown when the bridge supplies no corresponding evidence. Vault choice and folder grants follow the vault-open flow.

## Validation at audited head

- `npm test`: 326 passing tests across 19 files.
- `npm run typecheck`: pass.
- `npm run build`: pass.
- Packaged CLI help and invalid-agent smoke checks: pass.
- External installer boundary and packaged-source rejection tests: pass.

The app-side size validation and disabled web preservation evidence belongs to the coordinated native PR: server validation has 41 passing tests; the canvas decode suite has 9 passing tests. App environment acceptance is recorded separately in `enso/docs/research/enso-1.5-environment.md`.

## PR draft

Title: `feat(cli): finish agent setup and control canvas writing size`

Body:

> Agents need predictable setup, editable context regions, and clear filename errors before canvas mutations. The CLI validates those edits, installs its bundled skill for detected or explicit agent targets, reports installation ownership and setup blockers, and exposes mark/excerpt font size with reset-to-17 behavior.
>
> Verification: 326 tests pass; typecheck, build, packaged CLI smoke checks, and installer boundary tests pass. Native bridge font-size persistence and real disposable npm/Bun installation/update checks remain coordinated acceptance items. Governing design: **Enso 1.5 release**, with the CLI contracts, Writing resize, Release contract, and Review gate notes in the agreed development vault.
>
> Related: Enso-Team/enso-cli#93, #94, #95, #96; Enso-Team/enso#559. Automatic Greptile review of the final head is required before this checkpoint passes.

The [packaged CLI preflight picture](assets/enso-1.5-cli-preflight.png) captures setup help, a project-only target blocker, and font-size rejection before bridge mutation. Bridge integration evidence remains a coordinated acceptance item. Use related issue references while acceptance items remain open.
