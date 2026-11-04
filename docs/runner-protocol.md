# Local runner protocol v1

`enso runner serve --provider fake` runs a foreground service independent of the
Enso app. It needs Node 20+ and is intended for macOS. It does not launch Enso,
navigate, perform bridge operations, import project configuration, or attach to a
terminal. Only the deterministic fake provider is implemented. Keep the service
running in its own terminal or arrange supervision separately.

From a checkout, replace `enso` with `npm run dev --`:

```sh
npm ci
npm run build
node dist/index.js runner serve --provider fake
```

In another terminal (use an existing absolute codebase directory):

```sh
enso runner call POST /v1/sessions --json '{
  "binding": {
    "bridgeUrl": "http://127.0.0.1:17650",
    "canvasTarget": {
      "vaultID": "77A94BC5-18EA-4869-AAC5-10C461601E26",
      "canvasID": "B0C38C1D-E096-42E9-BFFA-7BD04CF6F44F"
    },
    "workingDirectory": "/absolute/path/to/codebase"
  }
}'
# Substitute the returned session id below. Choose a new requestID for each turn.
enso runner call POST /v1/prompts --json '{
  "requestID": "turn-1", "sessionID": "<session UUID>",
  "text": "Explain this selection",
  "context": {"selectedNodes": [
    {"nodeID": "<stable node identity>", "noteID": "<note identity>", "content": "# Captured note\nIts content"}
  ]},
  "fake": {"scenario": "permission", "delayMs": 20}
}'
enso runner call GET /v1/runs/turn-1
enso runner call POST /v1/runs/turn-1/respond --json '{"pendingID":"turn-1:wait","value":"allow"}'
enso runner call GET /v1/snapshot
enso runner call POST /v1/runs/turn-1/cancel
enso runner shutdown
```

The fake provider does not require an app or an existing vault. UUIDs above only
exercise identity validation. A real client must use the identities discovered
by bridge contract 3, and capture context in the app before submission. The
runner preserves the captured text; it never rereads notes to replace it.

## Discovery, authentication and compatibility

Default private directory:
`~/Library/Application Support/Enso CLI/runner/v1/`.
`ENSO_CLI_CONFIG_DIR` changes the parent CLI directory. Every runner command also
accepts `--directory /absolute/private/path` to select a separate runner store.
Use a runner-owned directory outside the vault and codebase. macOS Unix socket
paths must fit in 103 bytes; choose a shorter directory if needed.

A live runner atomically publishes `connection.json`:

```json
{"protocolVersion":1,"socketPath":"/absolute/private/path/control.sock","token":"<secret>","pid":12345}
```

Native clients must read this file locally and connect with HTTP/1.1 over that
Unix domain socket. There is no TCP listener or unauthenticated discovery route.
The directory is owner-only (`0700`); the socket, connection file, snapshot and
log are `0600`. The directory must be owned by the current user and must not itself
be a symlink. The connection token is random and rotates at every startup. It
is unrelated to app bridge pairing and is never placed in runner state, returned
in normal CLI output, or logged. Same-user processes with filesystem access are
inside this trust boundary. Do not copy connection files to vaults or logs.

Every request, including reads and shutdown, requires:

```http
Authorization: Bearer <connection.json token>
Enso-Runner-Version: 1
Content-Type: application/json
```

Content-Type is required when a route consumes JSON. JSON bodies have a 1 MiB
limit; a larger body is read and discarded, then rejected with HTTP 413
`payload_too_large`. Browser Origin headers are rejected; CORS is not enabled.
Missing/wrong authentication returns HTTP 401 `unauthorized` before checking
version. Missing or incompatible version returns HTTP 426
`incompatible_runner_version` with `details.supportedVersions: [1]`. Responses
include `Enso-Runner-Version: 1` and `Cache-Control: no-store`. This protocol
version is independent of bridge contract 3 and the CLI package version.
Unsupported storage versions fail startup without migration or overwriting data.

If connection fails, reread discovery and reconnect. Do not infer anything about
execution from a disconnect, PID, HTTP error, or a missing submission response.
Query the original requestID; if absent, retry the **same ID and payload**.
The `runner call` CLI performs private discovery and opens a fresh connection
per call. It does not retry mutations automatically. It abandons a call with no
reply after 30 seconds (default) and reports `runner_timeout`; treat that like a
disconnect. `enso runner shutdown` returns only after the service process has
exited and released its owner record, so a new runner can start immediately; it
reports `runner_timeout` if that takes longer than 30 seconds.

## Request and response contract

All replies use `{ "ok": true, "data": ... }` or
`{ "ok": false, "error": { "code": "...", "message": "...", "details": {} } }`.
Error `details` may be omitted. Unknown input fields are rejected. Path IDs must
be percent-encoded when they contain reserved URL characters.

| Method and path | Body | Successful data |
| --- | --- | --- |
| POST `/v1/sessions` | `{binding}` | Created session (HTTP 201) |
| GET `/v1/sessions/:sessionID` | — | Persisted session |
| POST `/v1/prompts` | Prompt below | Existing or newly accepted run (HTTP 200) |
| GET `/v1/runs/:requestID` | — | Full run, including persisted terminal result/error |
| GET `/v1/snapshot` | — | `{sessions, runs, cursor}` |
| GET `/v1/events?after=N` | — | `{events, cursor}`; poll to observe changes (HTTP 410 `cursor_expired`: take a new snapshot) |
| POST `/v1/runs/:requestID/cancel` | — | Current cancelled/stopping/terminal run |
| POST `/v1/runs/:requestID/respond` | `{pendingID, value}` | Run after accepting response |
| POST `/v1/shutdown` | — | `{stopped:true}` after active providers confirm outcomes |

A session contains `id` (runner-generated UUID), `binding`, `provider: "fake"`,
`createdAt` (ISO timestamp), and optional opaque `providerState` (JSON).
`binding` is immutable and contains:

- `bridgeUrl`: exact loopback HTTP origin, normalized with URL.origin; no
  credentials, path, query, or fragment. No fallback app discovery is performed.
- `canvasTarget`: exactly `vaultID` and `canvasID` UUIDs, normalized uppercase by
  the existing CLI target parser. Names, refs, active canvas, and paths are not
  identity substitutes.
- `workingDirectory`: a separate existing absolute codebase directory,
  canonicalized with realpath at session creation and retained across restarts.
  It is never inferred from the vault, and the runner does not change its own cwd.

Prompt shape:

```json
{
  "requestID": "client-chosen-id",
  "sessionID": "<session UUID>",
  "text": "Prompt text",
  "context": {
    "selectedNodes": [{"nodeID":"node identity","noteID":"optional note identity","content":"captured note content"}]
  },
  "fake": {"scenario":"success","delayMs":20}
}
```

Request and node IDs are nonempty opaque strings, at most 128 characters;
pending IDs allow up to 256 characters.
`context` is required; an empty selection is `{selectedNodes:[]}`. Node identity
is required for each item; note identity is optional for nodes without a Note.
The payload is captured data, not instructions to look up the current selection.

The fake options default to `{scenario:"success",delayMs:20}`. Scenarios are
`success`, `failure`, `permission`, `input`, and `interrupted`; delayMs is an
integer in [0,60000]. A successful result echoes text, context, immutable binding,
answer (or null), and a session turn counter. Follow-ups receive the last
completed conversation checkpoint. Fake permission choices are `allow` and
`deny`; denial confirms a failed turn. Fake options are test controls for this
version, not a general provider configuration interface.

Request IDs are **global to a store**, not scoped to a session. After schema
normalization (including defaults), object key order is ignored; text and array
order must agree exactly. Equivalent resubmissions return the current original
run before busy checks, including terminal and interrupted runs. A different
payload or session under the same ID returns HTTP 409 `request_conflict`.
Concurrent calls obey the same rule. Different IDs compete for the single active
slot in a session: losers receive HTTP 409 `session_busy`. There is no queue or
live steering. Different sessions can run concurrently.

Run shape: `{request, status, createdAt, updatedAt, pending?, result?, error?,
providerState?}`. Timestamps are informational; sequence numbers define ordering.
Provider errors have `{code,message,details?}` with optional structured JSON details. Status meanings:

| Status | Meaning |
| --- | --- |
| `accepted` | Acceptance and payload are durable; execution not yet dispatched |
| `running` | Durable dispatch marker exists; provider may be executing |
| `waiting_permission` / `waiting_input` | Provider is awaiting the persisted pending request |
| `stopping` | Cancellation requested durably; provider confirmation still pending |
| `completed` | Provider confirmed completion; result/checkpoint are durable |
| `failed` | Provider confirmed failure; error is durable |
| `cancelled` | No dispatch occurred, or provider confirmed cancellation |
| `interrupted` | Execution or effects are uncertain; never automatically replayed |

The final four statuses are terminal for the runner lifecycle. `interrupted`
is **not proof that execution stopped or had no effects**. Cancellation of an
already terminal run returns it unchanged. Cancellation while running first
returns `stopping`; observe until a confirmed terminal state. A provider may
confirm completion before cancellation takes effect. The fake provider releases
all waits on cancellation and confirms `cancelled`. Shutdown cancels accepted
work and active work, releases waits, and awaits terminal persistence before
replying. SIGINT/SIGTERM follow the same graceful path. Client disconnection
changes no lifecycle status.

Pending request shape:

```json
{"id":"turn-1:wait","kind":"permission","message":"Allow this fake operation?","choices":["allow","deny"]}
```

For input requests, `kind` is `input` and choices are omitted. Responses use
`{pendingID,value}` with a string value. A stale/already-resolved pending ID
returns HTTP 409 `pending_not_found`; invalid choices return `invalid_input`.
Pending is removed durably before the response is delivered to the provider.
A crash at that boundary becomes interrupted rather than re-asking/replaying the
answer. Responses themselves are not idempotent submissions: after an ambiguous
response, inspect the run instead of assuming it is still waiting.

## Snapshot/event ordering and reconnect

Every durable change is an event with a `sequence` and a `type`. Sequences are
monotonic, gap-free, and retained across restarts. One transaction (a shutdown
cancelling several runs, restart recovery, or a completed turn together with its
session checkpoint) commits all of its events or none of them. Events are deltas:

| `type` | Other fields | Apply to the local copy |
| --- | --- | --- |
| `session_created` | `session` | Add the session |
| `session_updated` | `sessionID`, `providerState?` | Replace the session's `providerState`; absent removes it |
| `run_accepted` | `run` (full run, status `accepted`) | Add the run |
| `run_updated` | `requestID`, `status`, `updatedAt`, `pending?`, `result?`, `error?`, `providerState?` | Replace the run's `status`, `updatedAt`, `pending`, `result`, `error` and `providerState` with the event's; an absent field is removed |

Only `run_accepted` carries the request and its captured context; `request` and
`createdAt` never change afterwards, and terminal runs receive no further updates.
For example, `{"sequence":7,"type":"run_updated","requestID":"turn-1","status":"running","updatedAt":"..."}`
also clears the `pending` request that a previous `waiting_input` update set.

1. Read `/v1/snapshot`. Its sessions/runs and cursor describe one committed state.
2. Poll `/v1/events?after=<cursor>` and apply the events in sequence order.
3. Advance to the returned cursor only after applying the events. Persist the
   cursor with local client state if needed, or start with a new snapshot.
4. On HTTP 410 `cursor_expired`, discard the local copy and return to step 1.

State reads and transactions are serialized synchronously in one service process.
A transition concurrent with a snapshot is either in that snapshot, or has a
larger sequence and appears in subsequent events. Events never announce an
uncommitted change. Repeating an event query is safe. The runner retains the
events in its log (below): every event since the last compaction, preceded by the
transaction that triggered it and earlier ones within 1 MiB of log (an eighth
of the 8 MiB compaction size). The same window applies before and after a restart;
an older cursor returns `cursor_expired`. A caught-up client can therefore always
poll across a compaction; one further behind may not, so every client must
handle it. A cursor ahead of the durable history,
negative/noninteger cursor, or omitted cursor returns `invalid_cursor`; get a new
snapshot if the store was replaced. There is no subscription socket to keep alive.

## Persistence, restart, and crash uncertainty

Storage is runner-owned and never writes notes, Canvas records, CRDT data, or
vault metadata. It consists of two files:

- `log.jsonl`: one line per transaction, `{"events":[...]}` with the events
  above. A transaction is appended with `O_APPEND` and fsynced before it is
  applied in memory or any reply is sent; the directory is fsynced when the log
  is created. Each write is proportional to that transaction alone: a run update
  never repeats the request or its context.
- `state.json`: a compacted snapshot
  `{"storageVersion":2,"sequence":N,"sessions":[...],"runs":[...]}` covering
  every event through sequence N. It holds no event history; the log does.

Each state change, idempotency decision and active slot check runs without
yielding. When the log has grown by the larger of 8 MiB and the current
snapshot's size since the last compaction, the runner compacts: it writes a new
snapshot through a private temporary file, file fsync, atomic rename, and
directory fsync, then replaces the log the same way with its newest lines (the
retained event window above). Snapshot rewrites therefore cost a constant amount
per logged byte. Compaction follows a transaction that is already durable and
applied, so its failure is not that transaction's failure: the request still
succeeds, the full log is kept, and compaction is retried after the log grows by
another threshold. If the log replacement may have landed, the next append finds
the log shorter than acknowledged and fails the service closed.

Startup reads the snapshot (none means an empty store at sequence 0), then the
log. Only newline-terminated lines were ever acknowledged: a final line without
its newline is an unacknowledged, torn transaction. It is ignored and truncated
before the next append, so none of its events apply. Lines entirely at or below
the snapshot's sequence are already covered: they are not replayed, only served
as retained events. The next line must continue at the following sequence. The
remaining lines are replayed through the same reducer that applies live
transactions. A crash at any compaction step therefore recovers exactly the
acknowledged state: before the snapshot rename, the old snapshot plus the whole
log; after it, the new snapshot with the whole log covered; after the log
replacement, the new snapshot with its covered tail. A damaged complete line,
a sequence gap or overlap, a log that ends before its snapshot, or a failed store
invariant fails startup with `invalid_runner_storage`; nothing is rewritten.
`storageVersion` must be 2; earlier unreleased stores are refused, not migrated.

"Durable" here means surviving a process crash or kernel panic. It does not
cover sudden power loss on macOS: `fsync` hands data to the drive but does not
issue `F_FULLFSYNC`, so the drive's volatile cache may drop the latest
transactions. After power loss the store may roll back to an earlier valid
state, or keep a damaged log that startup refuses. A run whose `running` marker
was lost reappears as `accepted` and is dispatched again. That replay is
harmless for the fake provider. A real provider with external effects must close
this gap first (`F_FULLFSYNC`, or a store that issues it, such as SQLite with
`fullfsync`).

The store retains every session and run, including captured context and
results, without bounds. Compaction rewrites the whole snapshot synchronously, so
requests wait while it runs; pagination, streaming, and run retention need a
later design.

Startup validates schema and store invariants. It recovers terminal records
unchanged, dispatches only accepted work, and converts all previous running,
waiting, or stopping work to durable `interrupted` records with
`error.code: "restart_uncertain"`. In particular:

- Crash after acceptance, before the dispatch marker: safe to dispatch once.
- Crash after the marker, even before execute was actually called: uncertain.
- Provider finished, but result transaction was not durable: uncertain.
- Result transaction durable, but client never received it: recover that result.

There is no exactly-once claim for external effects. No automatic
replay/reconciliation of potentially executed work occurs. Retrying its request ID returns the interrupted record. A new
explicit prompt can be submitted, but a future real provider must reconcile its
external conversation/effects before continuing an uncertain session.

A persistence error fails the process closed: no further state is served or work
dispatched, active waits are aborted, and the service shuts down with an error
exit status. An HTTP error or disconnect during this failure is ambiguous;
restart and inspect state. Unsupported/damaged records fail closed and are never
reset automatically.

`owner` is an atomic PID symlink that prevents multiple service writers per
store. Startup reclaims it only after the old PID is no longer alive. PID reuse
therefore fails closed. `acquiring/` serializes startup and stale-owner recovery.
A process killed during the very short acquisition/recovery guard window can
leave that guard behind; startup returns `runner_locked`. After verifying no
runner is starting or using that directory, remove the orphaned `acquiring/`
directory and retry. Never remove an owner record for a live process. Stale
connection/socket files are replaced only after acquiring storage ownership.
Crash-left temporary snapshot files are ignored; they may be removed while the
runner is stopped. Never edit or truncate `state.json` or `log.jsonl` by hand.
No daemon/supervisor installation is included.

## Handoff to PRs 4 and 5

PR 4 should implement the small execution boundary in `src/runner/provider.ts`:
immutable session binding and captured prompt, abort signal, an awaitable
permission/input callback, explicit confirmed/uncertain outcomes, and an opaque
JSON conversation checkpoint committed atomically with a completed turn. A
provider may have at most one wait pending per run; a concurrent second wait is
rejected without affecting the first, which stays persisted and answerable. The
runner alone owns lifecycle persistence and cancellation intent. A bridge
operation succeeding is never evidence that a provider turn completed. Never
reinterpret a provider exception as a confirmed cancellation or successful turn.
Future provider-specific external execution IDs and reconciliation must be
persisted before relying on them; there is no Claude dependency or authentication
in this PR and the current protocol only selects `fake`.

Use the stored target with PR 2's immutable binding on **every** future bridge
operation. Use the exact stored bridge origin; never rediscover a different
instance, fall back to active canvas, navigate to satisfy validation, or replay
bridge mutations. PR 2 already preserves target validation errors without retry.
Provider setup must validate that the stored working directory remains available;
the runner deliberately does not resolve a replacement after restart.

Dependency gap in PRs 1/2 as visible in this repository: bridge identity is an
origin and private pairing token, with no advertised stable bridge-instance UUID
or generation. This PR persists the exact origin, which matches PR 2's instance
pinning. It cannot distinguish a replacement app process reusing that origin.
A real provider must pin/validate pairing identity or consume a coordinated
bridge instance identifier before executing after a restart. The fake never
calls the bridge, so it cannot accidentally cross that boundary. The app bridge
implementation itself is not in this repository and was not modified.

PR 5 should consume the private discovery/auth/version contract, create a session
with explicit UUIDs and a separately chosen codebase directory, capture selected
node content before submitting, generate and retain request IDs before sending,
and recover via snapshot plus cursor polling. A disconnected UI is not a stopped
turn. Display interrupted outcomes as uncertain and retain their error details;
do not generate a fresh request ID as an automatic retry. Render pending
requests from the run and stop by requesting cancellation then observing terminal
confirmation.
