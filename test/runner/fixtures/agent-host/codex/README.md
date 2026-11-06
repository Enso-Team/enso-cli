# Codex app-server replay transcripts from agent-host

Recorded Codex app-server exchanges from Enso's T3 Code fork, adapted to Enso's replay
format (`test/runner/replay/`) so the Codex provider, the transport and the vendored
client run against real app-server frames without authentication, network calls or paid
turns.

- Source: https://github.com/Enso-Team/agent-host (branch `enso`)
- Revision: `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`
- Recorded with: Codex 0.156.1
- License: MIT, Copyright (c) 2026 T3 Tools Inc. (see `../LICENSE`)

| Transcript | Source (`apps/server/src/orchestration-v2/testkit/fixtures/`) | Covers |
| --- | --- | --- |
| `simple.ndjson` | `simple/codex_transcript.ndjson` | start, completion |
| `provider_thread_resume.ndjson` | `provider_thread_resume/codex_transcript.ndjson` | resume in a new app-server process |
| `tool_call_read_only_on_request.ndjson` | `tool_call_read_only_on_request/codex_transcript.ndjson` | command approval |
| `tool_call_restricted_granular.ndjson` | `tool_call_restricted_granular/codex_transcript.ndjson` | file change approval |
| `plan_questions.ndjson` | `plan_questions/codex_transcript.ndjson` | `requestUserInput` |
| `subagent_v2_approval.ndjson` | `subagent_v2_approval/codex_transcript.ndjson` | a subagent's approval and turn end |
| `turn_interrupt.ndjson` | `turn_interrupt/codex_transcript.ndjson` | confirmed interrupt |
| `turn_interrupt_mid_tool.ndjson` | `turn_interrupt_mid_tool/codex_transcript.ndjson` | confirmed interrupt during a command (background terminal termination dropped) |

Inbound frames (`emit_inbound`) are the recorded frames, except that string values equal
to the recording's workspace path read `<workspace>`, which the harness replaces with the
test's directory (the provider checks the directory Codex reports). The outbound
expectations were rewritten for Enso: each process starts with `process.spawn`,
`initialize`, `thread/start`, `thread/resume` and `turn/start` carry Enso's parameters
(`<cli-version>` and `<runner-instructions>` are filled in per test), and the runner's
`stdin.close` precedes the recorded exit. Request ids are the recorded ones: Enso sends
the same requests in the same order. Each file's header lists its source and every
adaptation under `metadata.sources` and `metadata.adaptation`.

Variants that need no new recording (failures, refusals, races, malformed output,
process loss) are derived from these in `test/runner/codex.test.ts`.
