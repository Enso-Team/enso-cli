# Third-party notices

## Enso T3 Code fork (agent-host)

`src/runner/claude-sdk.ts` adapts Claude Agent SDK handling (permission results,
AskUserQuestion input, terminal-result classification, result attribution and
conversation identity) from Enso's fork of T3 Code. The provider replay harness in
`test/runner/replay/` adapts the fork's replay transcript format, replay gates and
Claude replay query runner, and the test transcripts in
`test/runner/fixtures/agent-host/` are adapted from recordings at the same revision.
Each file names its original paths.

The Codex provider's app-server client in `src/vendor/effect-codex-app-server/` is the
fork's `packages/effect-codex-app-server` package, copied unmodified (its `VENDOR.md` and
`vendor.json` list each file and original path); the published CLI bundles it into
`dist/codex-app-server-*.js`. `test/runner/replay/codex.ts` adapts the package's replay
client, and the transcripts in `test/runner/fixtures/agent-host/codex/` are adapted from the
fork's Codex recordings.

- Source: https://github.com/Enso-Team/agent-host (branch `enso`)
- Revision: `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`
- Original files: `packages/effect-codex-app-server/src/{client,protocol,errors,schema,rpc}.ts`,
  `packages/effect-codex-app-server/src/_internal/{shared,stdio}.ts`,
  `packages/effect-codex-app-server/src/_generated/{meta,namespaces,schema}.gen.ts`,
  `packages/effect-codex-app-server/src/replay.ts`,
  `apps/server/src/orchestration-v2/testkit/fixtures/*/codex_transcript.ndjson`,
  `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`,
  `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts`,
  `packages/provider-testing/src/replayTranscript.ts`,
  `packages/provider-testing/src/replayGate.ts`,
  `packages/contracts/src/orchestrationV2.ts` (replay entry schema), and
  `apps/server/src/orchestration-v2/testkit/fixtures/*/claude_transcript.ndjson`

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Effect

The published CLI bundles the parts of `effect` 4.1.2 (https://github.com/Effect-TS/effect)
that the Codex app-server client uses into `dist/codex-app-server-*.js`.

```
MIT License

Copyright (c) 2023 Effectful Technologies Inc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Codex CLI

The Codex provider runs the user's own `codex` executable (`codex app-server`), installed
separately and subject to its own license and terms. It is not bundled.

## Claude Agent SDK

The Claude provider loads `@anthropic-ai/claude-agent-sdk`, an optional dependency
installed separately from this package's code and subject to Anthropic's terms
(https://code.claude.com/docs/en/legal-and-compliance). It is not bundled.
