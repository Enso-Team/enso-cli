# Claude Agent SDK replay transcripts

Recorded Claude Agent SDK exchanges, copied unchanged from Enso's T3 Code fork so the
Claude provider is tested against real SDK frames without paid agent calls.

- Source: https://github.com/Enso-Team/agent-host (branch `enso`)
- Revision: `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`
- `claude_idle_resume.ndjson` ← `apps/server/src/orchestration-v2/testkit/fixtures/claude_idle_resume/claude_transcript.ndjson`
- `claude_result_is_error.ndjson` ← `apps/server/src/orchestration-v2/testkit/fixtures/claude_result_is_error/claude_transcript.ndjson`
- License: MIT, Copyright (c) 2026 T3 Tools Inc. (see `LICENSE` in this directory)

`test/runner/claude-exchange.ts` replays them: each `query.open` starts a query, its
`emit_inbound` frames are delivered in order, and the recorded query identity
(`sessionId` or `resume`) is compared with what the provider sent.
