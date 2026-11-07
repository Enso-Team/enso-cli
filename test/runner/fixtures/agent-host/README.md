# Claude Agent SDK replay transcripts from agent-host

Recorded Claude Agent SDK exchanges from Enso's T3 Code fork, adapted to Enso's replay
format (`test/runner/replay/`) so the Claude provider runs against real SDK frames
without authentication, network calls or paid turns.

- Source: https://github.com/Enso-Team/agent-host (branch `enso`)
- Revision: `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`
- License: MIT, Copyright (c) 2026 T3 Tools Inc. (see `LICENSE` in this directory)

| Transcript | Source (`apps/server/src/orchestration-v2/testkit/fixtures/`) |
| --- | --- |
| `simple.ndjson` | `simple/claude_transcript.ndjson` |
| `claude_idle_resume.ndjson` | `claude_idle_resume/claude_transcript.ndjson` |
| `claude_result_is_error.ndjson` | `claude_result_is_error/claude_transcript.ndjson` (first prompt's turn only) |
| `tool_call_read_only_on_request.ndjson` | `tool_call_read_only_on_request/claude_transcript.ndjson` |
| `tool_call_denied_write.ndjson` | `tool_call_denied_write/claude_transcript.ndjson` (stream events dropped) |
| `turn_interrupt_mid_tool.ndjson` | `turn_interrupt_mid_tool/claude_transcript.ndjson` |
| `turn_interrupt_confirmed.ndjson` | `turn_interrupt_mid_tool/claude_transcript.ndjson`, then the aborted result from `message_steering/claude_transcript.ndjson` |

Inbound frames (`emit_inbound`) are the recorded frames, unchanged. The outbound
expectations were rewritten for Enso: `query.open` pins the options Enso's runner sets
(including the bridge environment: these sessions pin no bridge instance, so it is
`ENSO_RUNNER_BRIDGE=disabled` alone),
`prompt.offer` uses Enso's message shape, and each query ends with an expected
`query.close`. Each file's header lists its sources and every adaptation under
`metadata.sources` and `metadata.adaptation`.

Enso-authored transcripts for exchanges with no recording (AskUserQuestion, concurrent
and withdrawn callbacks, late frames) live in `../claude/`.
