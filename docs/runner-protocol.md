# Local runner protocol v1

`enso runner serve --provider fake` runs a foreground service independent of the
Enso app. It needs Node 20+ and is intended for macOS. It does not launch Enso,
navigate, perform bridge operations, import project configuration, or attach to a
terminal. Only the deterministic fake provider is implemented. Keep the service
running in its own terminal or arrange supervision separately.

The runner stores state in SQLite through the `better-sqlite3` native module, an
optional dependency loaded only by runner commands. npm 12 skips dependency install
scripts by default, which leaves the module without its binary; install with
`npm install -g @enso-app/cli --allow-scripts=better-sqlite3`. Prebuilt binaries
cover Node 22, 24, 25 and 26; other versions, including Node 20, build the module
from source (Xcode command line tools). Without it, `runner serve` fails with
`runner_storage_unavailable` before creating any file, and other commands still work.

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
The directory is owner-only (`0700`); the socket, connection file and database
(`runner.sqlite` with its `-wal`/`-shm` files) are `0600`. The directory must be owned by the current user and must not itself
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
Unsupported or unrecognized stores fail startup without migration or overwriting
data (see Persistence).

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
| GET `/v1/events?after=N` | — | `{events, cursor}`, one page; poll to observe changes (HTTP 410 `cursor_expired`: take a new snapshot) |
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

A reply is one page: events after the cursor in order, stopping before the one
that would take it past 1 MiB of UTF-8 event JSON (a page always holds at least
one event when any are newer). The returned `cursor` is the sequence of the last
event in the page, or the requested cursor when there are none, so a client that
is behind repeats the query until `events` is empty.

State reads and transactions are serialized synchronously in one service process.
A transition concurrent with a snapshot is either in that snapshot, or has a
larger sequence and appears in subsequent events. Events never announce an
uncommitted change. Repeating an event query is safe. This version keeps every
event, so it never returns `cursor_expired`; clients must still handle it, since
a later version may bound history. A cursor ahead of the durable history,
negative/noninteger cursor, or omitted cursor returns `invalid_cursor`; get a new
snapshot if the store was replaced. There is no subscription socket to keep alive.

## Persistence, restart, and crash uncertainty

Storage is runner-owned and never writes notes, Canvas records, CRDT data, or
vault metadata. It is one SQLite database, `runner.sqlite`, identified by
`PRAGMA application_id` (`0x456E736F`, "Enso") and schema version 1
(`PRAGMA user_version`):

- `events`: every event above, keyed by `sequence`. A trigger refuses any insert
  that is not the next sequence, and events are never updated or deleted.
- `sessions`: one row per session. Its identity and binding cannot change; only
  the opaque `providerState` checkpoint does.
- `runs`: one row per accepted request, keyed by the global `requestID`. The
  request and its captured context cannot change, terminal runs cannot change,
  and a partial unique index allows at most one non-terminal run per session.

Every state change is one `BEGIN IMMEDIATE` transaction that appends its events
and applies them to the session/run rows. It commits before any reply or dispatch
depends on it; if any statement fails it rolls back entirely. Acceptance
commits before dispatch, the `running` dispatch marker commits before the provider
is called, and a completed result commits together with its session checkpoint.
A transaction carries only its own changes: a run update never repeats the request
or its context (only `run_accepted` carries the captured context, once in the run
row and once in its event).

Commits are durable when they return, including across sudden power loss on
macOS, provided the drive honors `F_FULLFSYNC` (Apple internal storage does; some
external enclosures do not). The database uses `journal_mode=WAL` with `synchronous=FULL`, so every
commit syncs the write-ahead log before returning, and `fullfsync=ON` /
`checkpoint_fullfsync=ON`, so each sync is `F_FULLFSYNC`, which also flushes the
drive's volatile cache. (`synchronous=NORMAL` syncs only at checkpoints and plain
`fsync` stops at the drive cache; either would lose acknowledged commits on power
loss.) Startup reads these settings back and refuses to run (`unsafe_storage`) if
SQLite did not apply them, and a macOS test counts the `F_FULLFSYNC` calls a real
runner process makes per commit. The database file is created `0600` with a
directory fsync; SQLite gives its `-wal` and `-shm` files the same mode.

Each state change, idempotency decision and active slot check runs without
yielding, and storage calls are synchronous. SQLite's locks only serialize
statements: they do not establish service ownership (below), which is taken
before the database is opened.

Startup checks the store before serving or dispatching anything: identity and
version, `PRAGMA quick_check`, foreign keys, a gap-free event sequence, and the
schema of every event, session and run. It recovers terminal records unchanged,
dispatches only accepted work, and converts all previous running, waiting, or
stopping work to durable `interrupted` records with
`error.code: "restart_uncertain"` in one transaction. A crash part way through a
transaction leaves no trace of it. In particular:

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
exit status. A statement failure rolls its transaction back, but an I/O error
while committing can leave the transaction durable anyway; restart and inspect
state. An HTTP error or disconnect during this failure is ambiguous in the same
way. Unsupported/damaged records fail closed and are never reset
automatically.

Existing stores are handled explicitly, never discarded:

- No `runner.sqlite`: an empty store is created.
- An empty `runner.sqlite` (a crash right after creating it): initialized.
- `state.json`, `log.jsonl` or their `.tmp` files from the earlier JSONL store
  (unreleased storage version 2): startup fails with `invalid_runner_storage`,
  listing them in `details.legacyFiles`. They are not migrated, modified, or
  shadowed by a new database. Keep them with the runner build that wrote them,
  or move them out of the directory to start empty.
- A file that is not SQLite, another application's database, a runner database
  of a different version, or a damaged runner database: refused. An existing
  file is judged through a read-only connection, so the database and any
  `-wal` left by a crash stay byte-for-byte unchanged (SQLite may rebuild the
  `-shm` index).

The store retains every session, run and event, including captured context and
results, without bounds. Pagination of snapshots and run retention need a later
design.

`owner` is an atomic PID symlink that prevents multiple service writers per
store. Startup reclaims it only after the old PID is no longer alive. PID reuse
therefore fails closed. `acquiring/` serializes startup and stale-owner recovery.
A process killed during the very short acquisition/recovery guard window can
leave that guard behind; startup returns `runner_locked`. After verifying no
runner is starting or using that directory, remove the orphaned `acquiring/`
directory and retry. Never remove an owner record for a live process. Stale
connection/socket files are replaced only after acquiring storage ownership.
The database may be inspected read-only (for example with `sqlite3 -readonly`)
while the runner is live, which can leave `-wal`/`-shm` files after it stops.
Never write to it by hand. No daemon/supervisor installation is included.

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
