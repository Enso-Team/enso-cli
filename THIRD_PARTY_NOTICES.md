# Third-party notices

## Enso T3 Code fork (agent-host)

`src/runner/claude-sdk.ts` adapts Claude Agent SDK handling (permission results,
AskUserQuestion input, terminal-result classification, result attribution and
conversation identity) from Enso's fork of T3 Code. The test transcripts in
`test/runner/fixtures/agent-host/` are copied from the same revision. Each file
names its original paths.

- Source: https://github.com/Enso-Team/agent-host (branch `enso`)
- Revision: `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`
- Original file: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`

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

## Claude Agent SDK

The Claude provider loads `@anthropic-ai/claude-agent-sdk`, an optional dependency
installed separately from this package's code and subject to Anthropic's terms
(https://code.claude.com/docs/en/legal-and-compliance). It is not bundled.
