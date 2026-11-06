# Enso-authored Claude replay transcripts

No agent-host recording covers these exchanges, so they were written by hand. Their frames
follow the shapes of the recorded transcripts in `../agent-host/` and the Claude Agent SDK
0.3.318 types; the values are invented, and no model produced them. Each header's
`metadata.synthetic` says so, and `metadata.covers` names the behavior under test.

| Transcript | Covers |
| --- | --- |
| `ask_user_question.ndjson` | AskUserQuestion as runner input, and the captured selection in the prompt |
| `concurrent_callbacks.ndjson` | a permission and a question arriving together |
| `withdrawn_callbacks.ndjson` | the CLI withdrawing a queued callback and a pending one |
| `late_frames.ndjson` | results for other turns, and frames, a callback and a result after this turn's result |

Before relying on one of these for a behavior change, compare it with a live recording.
