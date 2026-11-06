# Provider replay

Tests drive the real provider adapter against a transcript of its runtime's protocol, at the
boundary the adapter already injects (`ClaudeQuery` for Claude). Nothing is spawned, and no
model is called.

A transcript is NDJSON: a `transcript_start` header with `format: "enso-provider-replay/1"`,
then entries in order.

- `expect_outbound`: the adapter must send this frame next. Frames are compared exactly
  (key order aside). `<workspace>` stands for the test's working directory. An optional
  `reply` says how the runtime answers.
- `emit_inbound`: the runtime delivers this frame next.
- `runtime_exit`: the runtime's stream ends, with `success` or `error` (and its message, and
  for a system error such as a missing binary, its errno `code`).

Playback fails with a `ReplayError` on an outbound frame the transcript does not expect next
(`unexpected_outbound`), a different frame (`mismatch`), an operation after the last entry
(`exhausted`), and, from `complete()`, entries never played (`incomplete`). Tests call
`complete()` after shutting the runner down.

To synchronize, tests use `Replay.hold(label)` to stop playback before an inbound entry,
`Replay.arrival(label)` to wait until playback reaches an entry, and `observeCommits(storage)`
to wait for the durable commit that puts a run in a given status.

- `transcript.ts`: the format, the playback cursor, gates, errors. Provider-neutral.
- `commits.ts`: waits on durable runner commits. Provider-neutral.
- `claude.ts`: the Claude Agent SDK boundary (`query.open`, `prompt.offer`,
  `permission.request`/`permission.response`, `permission.withdraw`, `query.interrupt`,
  `query.close`).

A Codex boundary needs only its own counterpart to `claude.ts`, one that plays app-server
JSON-RPC frames through the same `Replay`. agent-host's Codex recordings
(`apps/server/src/orchestration-v2/testkit/fixtures/*/codex_transcript.ndjson`) use the same
entry types; adapting one takes the `format` header field and Enso's expected requests.
