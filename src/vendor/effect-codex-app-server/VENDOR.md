# effect-codex-app-server (vendored)

The Codex app-server JSON-RPC client from Enso's T3 Code fork, copied unmodified. It is an
internal workspace package of that repository (`"private": true`), not published to npm, so
it lives here.

- Source: https://github.com/Enso-Team/agent-host, branch `enso`
- Revision: `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`
- Package: `packages/effect-codex-app-server`
- License: MIT, Copyright (c) 2026 T3 Tools Inc. (`LICENSE`, the repository's root license)
- Local patches: none. `vendor.json` lists every file with its source path and git blob hash,
  and `test/runner/codex-vendor.test.ts` fails if a copied file no longer matches it.

| File | Original path (under `packages/effect-codex-app-server/`) | Role |
| --- | --- | --- |
| `src/client.ts` | `src/client.ts` | Typed client: requests, notifications and server-request handlers over the protocol |
| `src/protocol.ts` | `src/protocol.ts` | JSONL framing, request ids, response routing, termination |
| `src/errors.ts` | `src/errors.ts` | Tagged transport, protocol and request errors |
| `src/schema.ts`, `src/rpc.ts` | same | Public re-exports of the generated schema and method maps |
| `src/_internal/shared.ts` | same | Payload encoding and decoding against the schema |
| `src/_internal/stdio.ts` | same | stderr tail and excerpt (the child-process `Stdio` helpers are not used) |
| `src/_generated/*.gen.ts` | same | Schema and method maps generated from Codex 0.156.1's app-server JSON schema |

Not copied: `src/replay.ts` (Enso replays at the process boundary instead, in
`test/runner/replay/codex.ts`), the package's tests and examples (they need
`@effect/vitest` and `@effect/platform-node`), and `scripts/generate.ts` (regeneration
happens upstream).

## Runtime

The files import `effect` and use `.ts` import specifiers, as upstream does; `tsconfig.json`
allows those (`rewriteRelativeImportExtensions`) and adds the ES2023 library for
`Array.prototype.findLast`, which Node 20 has. `effect` is pinned to the version upstream's
catalog uses (`4.1.2`, `runtime.effect` in `vendor.json`) as a dev dependency: the build bundles
it, with this code, into a chunk that `runner serve --provider codex` alone loads. The published
package therefore does not depend on `effect`, and other commands never load it.

Only `src/runner/codex-app-server.ts` imports these files or Effect. It is the runtime
boundary: it spawns the app-server, runs the client in one Effect scope per process, exposes
plain promises (`src/runner/codex-connection.ts`), and on `close()` lets queued writes
finish, closes that scope, ends stdin, then signals the process group with SIGTERM and
SIGKILL until the process has exited.

## Updating

1. In a checkout of Enso-Team/agent-host, pick the new revision on `enso` and read
   `git log <old>..<new> -- packages/effect-codex-app-server` and the Codex adapter
   (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`) for protocol changes.
2. Copy each file listed in `vendor.json` from `packages/effect-codex-app-server/` at that
   revision over its copy here, and the root `LICENSE`. Add a file only if a copied one
   imports it.
3. Set `effect` in `package.json` (exact version, dev dependency) to the version in
   agent-host's `pnpm-workspace.yaml` catalog, and record it as `runtime.effect`.
4. Update `revision` and each `blob` in `vendor.json`
   (`git hash-object src/vendor/effect-codex-app-server/<file>`), and the revision here, in
   `THIRD_PARTY_NOTICES.md`, and in the files that name it.
5. If a patch is unavoidable, keep it minimal, mark it `Enso:` in the file, list it under
   `patches` in `vendor.json` and in this file, and update the test that checks the hashes.
6. Run `npm run typecheck`, `npm test` (the Codex replay, transport, crash and CLI tests run
   the vendored client) and `npm run build`; check that `npm pack --dry-run` lists the
   `dist/codex-app-server-*.js` chunk. Adapted recordings in
   `test/runner/fixtures/agent-host/codex/` can be refreshed from
   `apps/server/src/orchestration-v2/testkit/fixtures/*/codex_transcript.ndjson` as their
   README describes.
