# Local runner protocol v3

`enso runner serve --provider <fake|claude>` runs a foreground service independent
of the Enso app. It needs Node 20+ and is intended for macOS. It does not launch
Enso, navigate, import project configuration, or attach to a terminal. Its only
bridge request is the health read that pins a Claude session's bridge instance;
the bridge operations a Claude session makes are its agent's `enso` CLI calls,
bound to the session (see Bridge). Two providers exist: `fake`, a deterministic test provider, and
`claude`, which runs each prompt through the Claude Agent SDK (see Claude provider).
One runner serves one provider; restart it to switch. Keep the service running in
its own terminal or arrange supervision separately.

Protocol 3 adds the bridge instance a session pins, `binding.bridgeInstanceID`
(see Bridge). Clients must send `Enso-Runner-Version: 3`; a protocol 2 client is
refused with `incompatible_runner_version`, since the sessions it reads may carry
a field it does not know. A protocol 3 runner opens protocol 2 stores (the same
`runner/v2/` directory and SQLite schema version 2) without changing them: their
sessions have no pinned instance and keep the bridge disabled. A protocol 2 runner
refuses a store that holds a pinned session (`invalid_runner_storage`) and leaves
it unchanged.

Protocol 2 was incompatible with protocol 1: it added Claude sessions, provider
execution identifiers recorded on runs, session uncertainty with explicit recovery,
and structured input requests. A protocol 1 store is refused rather than migrated.

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
# or, with Claude Code signed in (or ANTHROPIC_API_KEY set):
node dist/index.js runner serve --provider claude [--claude-model <model>] \
  [--claude-permission-mode default|acceptEdits|plan|auto] [--claude-executable <path>]
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

The fake provider does not require an app or an existing vault, and pins no bridge
instance. UUIDs above only exercise identity validation. A Claude runner pins the
session's bridge instance, so creating a Claude session needs the Enso app running
at `bridgeUrl` (see Bridge). A real client must use the identities discovered
by bridge contract 3, and capture context in the app before submission. The
runner preserves the captured text; it never rereads notes to replace it.

## Discovery, authentication and compatibility

Default private directory:
`~/Library/Application Support/Enso CLI/runner/v2/`, named for its storage
format, which protocols 2 and 3 share (protocol 1 used `runner/v1/`; neither
opens the other's store).
`ENSO_CLI_CONFIG_DIR` changes the parent CLI directory. Every runner command also
accepts `--directory /absolute/private/path` to select a separate runner store.
Use a runner-owned directory outside the vault and codebase. macOS Unix socket
paths must fit in 103 bytes; choose a shorter directory if needed.

A live runner atomically publishes `connection.json`:

```json
{"protocolVersion":3,"socketPath":"/absolute/private/path/control.sock","token":"<secret>","pid":12345}
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
Enso-Runner-Version: 3
Content-Type: application/json
```

Content-Type is required when a route consumes JSON. JSON bodies have a 1 MiB
limit; a larger body is read and discarded, then rejected with HTTP 413
`payload_too_large`. Browser Origin headers are rejected; CORS is not enabled.
Missing/wrong authentication returns HTTP 401 `unauthorized` before checking
version. Missing or incompatible version returns HTTP 426
`incompatible_runner_version` with `details.supportedVersions: [3]`. Responses
include `Enso-Runner-Version: 3` and `Cache-Control: no-store`. This protocol
version is independent of the bridge contract version (3) and the CLI package
version.
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
| POST `/v1/sessions` | `{binding, provider?}` | Created session (HTTP 201); a Claude runner pins its bridge instance first (see Bridge) |
| GET `/v1/sessions/:sessionID` | — | Persisted session |
| POST `/v1/prompts` | Prompt below | Existing or newly accepted run (HTTP 200) |
| GET `/v1/runs/:requestID` | — | Full run, including persisted terminal result/error |
| GET `/v1/snapshot` | — | `{sessions, runs, cursor}` |
| GET `/v1/events?after=N` | — | `{events, cursor}`, one page; poll to observe changes (HTTP 410 `cursor_expired`: take a new snapshot) |
| POST `/v1/runs/:requestID/cancel` | — | Current cancelled/stopping/terminal run |
| POST `/v1/runs/:requestID/respond` | `{pendingID, value}` | Run after accepting response |
| POST `/v1/shutdown` | — | `{stopped:true}` after active providers confirm outcomes |

A session contains `id` (runner-generated UUID), `binding`, `provider` (`"fake"` or
`"claude"`: the runner's provider when the session was created), `createdAt` (ISO
timestamp), optional opaque `providerState` (JSON, the provider's conversation
checkpoint), and optional `uncertain` (see Uncertain sessions). Route paths keep
their `/v1/` prefix; the protocol version is the header. Creating a session with
`provider` naming another provider than the runner's fails with HTTP 409
`provider_mismatch`; so does a prompt for a session of another provider.
`binding` is immutable and contains:

- `bridgeUrl`: exact loopback HTTP origin, normalized with URL.origin; no
  credentials, path, query, or fragment. No fallback app discovery is performed.
- `canvasTarget`: exactly `vaultID` and `canvasID` UUIDs, normalized uppercase by
  the existing CLI target parser. Names, refs, active canvas, and paths are not
  identity substitutes.
- `workingDirectory`: a separate existing absolute codebase directory,
  canonicalized with realpath at session creation and retained across restarts.
  It is never inferred from the vault, and the runner does not change its own cwd.
- `bridgeInstanceID` (protocol 3): the bridge instance the session is pinned to,
  an opaque string of 1 to 256 visible ASCII characters without spaces. The
  runner reads it from the bridge when it creates the session; a client may send
  it to assert which instance it expects (see Bridge). Absent on sessions that
  pinned none: fake sessions, and every session created before protocol 3. Their
  bridge stays disabled; the runner never adds a pin to an existing session.

Prompt shape:

```json
{
  "requestID": "client-chosen-id",
  "sessionID": "<session UUID>",
  "text": "Prompt text",
  "context": {
    "selectedNodes": [{"nodeID":"node identity","noteID":"optional note identity","content":"captured note content"}]
  },
  "fake": {"scenario":"success","delayMs":20},
  "recovery": {"after":"<uncertain requestID>","mode":"resume"}
}
```

Request and node IDs are nonempty opaque strings, at most 128 characters;
pending IDs allow up to 256 characters.
`context` is required; an empty selection is `{selectedNodes:[]}`. Node identity
is required for each item; note identity is optional for nodes without a Note.
The payload is captured data, not instructions to look up the current selection.

`fake` is accepted only for fake sessions (`invalid_input` otherwise), and the runner
stores its default for them, so omitting it and sending the default are equivalent
submissions. `recovery` is required exactly while the session is uncertain.

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
run before busy checks, including terminal and interrupted runs, until retention
deletes it (see Retention); after that the ID is free and a submission is new. A different
payload or session under the same ID returns HTTP 409 `request_conflict`.
Concurrent calls obey the same rule. Different IDs compete for the single active
slot in a session: losers receive HTTP 409 `session_busy`. There is no queue or
live steering. Different sessions can run concurrently.

Run shape: `{request, status, createdAt, updatedAt, pending?, result?, error?,
providerState?, native?}`. `native` holds the provider's execution identifiers
(for Claude: conversation, prompt uuid, whether it resumed, model, permission
mode). The provider commits them before it starts anything that could use them,
and every later update of the run keeps them, so an interrupted run always names
what may have run. Timestamps are informational; sequence numbers define ordering.
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

For input requests, `kind` is `input` and choices are omitted. A pending request
may also carry `details` (JSON, such as the tool name, its input and the
provider's reason) and, for input, structured `questions`:
`[{id, header, question, options:[{label, description}], multiSelect}]`.
Responses use `{pendingID, value}`. `value` is a string, one of `choices` when
there are choices; for structured questions it is an object answering every
question id with a string or a list of strings (a single question may also be
answered with a string). Options are suggestions, not limits. A stale or
already-resolved pending ID returns HTTP 409 `pending_not_found`; an invalid value
returns `invalid_input`. A provider can withdraw a request it no longer needs: the
run returns to `running` (or stays `stopping`) durably, and an answer to it then
returns `pending_not_found`.
Pending is removed durably before the response is delivered to the provider.
A crash at that boundary becomes interrupted rather than re-asking/replaying the
answer. Responses themselves are not idempotent submissions: after an ambiguous
response, inspect the run instead of assuming it is still waiting.

## Snapshot/event ordering and reconnect

Every durable change is an event with a `sequence` and a `type`. Sequences are
monotonic and retained across restarts, and gap-free after any cursor that has
not expired: retention deletes events only below the expired cursor. One transaction (a shutdown
cancelling several runs, restart recovery, or a completed turn together with its
session checkpoint) commits all of its events or none of them. Events are deltas:

| `type` | Other fields | Apply to the local copy |
| --- | --- | --- |
| `session_created` | `session` | Add the session |
| `session_updated` | `sessionID`, `providerState?`, `uncertain?` | Replace the session's `providerState` and `uncertain`; an absent field is removed |
| `run_accepted` | `run` (full run, status `accepted`) | Add the run |
| `run_updated` | `requestID`, `status`, `updatedAt`, `pending?`, `result?`, `error?`, `providerState?`, `native?` | Replace the run's `status`, `updatedAt`, `pending`, `result`, `error`, `providerState` and `native` with the event's; an absent field is removed |
| `runs_deleted` | `requestIDs` | Remove those runs (retention deleted them, finished); ignore IDs you do not hold |

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
uncommitted change. Repeating an event query is safe. Without retention the
runner keeps every event and never returns `cursor_expired`. With retention, a
cursor below the last event it deleted returns `cursor_expired`, since replaying
from it would miss changes; a snapshot's cursor never has. A cursor ahead of the durable history,
negative/noninteger cursor, or omitted cursor returns `invalid_cursor`; get a new
snapshot if the store was replaced. There is no subscription socket to keep alive.

## Persistence, restart, and crash uncertainty

Storage is runner-owned and never writes notes, Canvas records, CRDT data, or
vault metadata. It is one SQLite database, `runner.sqlite`, identified by
`PRAGMA application_id` (`0x456E736F`, "Enso") and schema version 2
(`PRAGMA user_version`):

- `events`: every event above, keyed by `sequence`, with the session or run it
  belongs to. Events are the record: each payload (captured context, result,
  error, pending request, checkpoint) is stored once, in its event. A trigger
  refuses any insert that is not the next sequence, and events are never updated;
  only retention deletes them.
- `sessions` and `runs`: one row per session and per accepted request (keyed by
  the global `requestID`), indexing its events: the event that created it, its
  latest event, and the keys and run status the constraints need. A row reads as
  its first event with its latest event applied. Triggers let a row be created or
  changed only in the transaction that appends its event, and only as that event
  says; terminal runs cannot change, and a partial unique index allows at most
  one non-terminal run per session.
- `retention`: the expired cursor, which only advances.

Every state change is one `BEGIN IMMEDIATE` transaction that appends its events
and applies them to the session/run rows. It commits before any reply or dispatch
depends on it; if any statement fails it rolls back entirely. Acceptance
commits before dispatch, the `running` dispatch marker commits before the provider
is called, and a completed result commits together with its session checkpoint.
A transaction carries only its own changes: a run update never repeats the request
or its context (only `run_accepted` carries the captured context, stored once).

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
version, `PRAGMA quick_check`, a gap-free event sequence above the expired
cursor, foreign keys, the schema of every event, and that every row points at the
right events (its creating event, its latest event and its status) and every
event at a row.

`enso runner check [--directory]` goes further: it runs the startup checks, then
rebuilds every session and run from the event history alone, applying events as a
client does, and compares the result with what the rows read. It catches history
the rows hide, such as an update to a finished run. It is read-only and runs in
one read transaction, so it is safe beside a live runner. It reports
`{cursor, expiredThrough, events, sessions, runs}`, or fails with
`invalid_runner_storage` and up to 50 `details.differences`. It refuses what
startup refuses beside the database (pre-SQLite files, orphaned `-wal`/`-shm`),
and reports an empty `runner.sqlite`, which startup initializes, as an empty
store with `empty: true`. With no store in the
directory, or a file where the directory should be, it fails with
`runner_storage_not_found`, and creates nothing; a store it cannot reach (an
unsearchable directory, a dangling symlink) fails with `runner_storage_failure`
instead.

Only these checks failing on the store's contents refuse it (`invalid_runner_storage`):
any other error while judging or initializing it, such as I/O, is reported as a
`runner_storage_failure` with its cause.

Once its checks pass, startup recovers terminal records unchanged, dispatches
only accepted work for the runner's provider (none if `serve` received SIGINT or
SIGTERM while starting: shutdown cancels that provider's work instead), and
converts all previous running, waiting, or stopping work
to durable `interrupted` records with `error.code: "restart_uncertain"`, marking
each one's session uncertain, in one transaction. A crash part way through a
transaction leaves no trace of it. In particular:

- Crash after acceptance, before the dispatch marker: safe to dispatch once.
- Crash after the marker, even before execute was actually called: uncertain.
- Provider finished, but result transaction was not durable: uncertain.
- Result transaction durable, but client never received it: recover that result.

There is no exactly-once claim for external effects. No automatic
replay/reconciliation of potentially executed work occurs. Retrying its request ID
returns the interrupted record.

Accepted prompts for another provider stay unchanged, including when this runner
shuts down. Restart with their matching provider to execute them, or cancel them
explicitly through the run's `/cancel` endpoint.

### Uncertain sessions

Every transition to `interrupted` (a restart, a provider that could not confirm an
outcome, an unconfirmed stop) also sets the session's `uncertain` to
`{requestID, native?}`: the uncertain run and the identifiers it recorded. While it
is set, a prompt without `recovery`, or whose `recovery.after` names another run,
fails with HTTP 409 `session_uncertain` and `details: {requestID, modes:["resume","fresh"]}`.
The client decides, preferably with the user, how to continue:

- `resume`: continue the provider conversation the uncertain run used, with
  whatever it did. For Claude, the conversation it recorded (if it recorded none,
  it never started a query, and the session's checkpoint is used).
- `fresh`: start a new provider conversation; the earlier history is not carried.

A `completed` turn clears `uncertain`, and so does a `failed` or `cancelled` one
whose outcome updates or clears `providerState`: the recovery has then settled
which conversation continues (for example, a `fresh` turn that created its new
conversation and then hit an API error). A recovery prompt that fails or is
cancelled without touching the checkpoint, or is itself interrupted, leaves the
session uncertain (an interrupted one names itself), so the next prompt must
acknowledge it again. A `recovery` on a session that is not uncertain is
`invalid_input`. `failed` and `cancelled` are confirmed and do not make a session
uncertain; their outcome may still update `providerState` (a confirmed turn can
have created or advanced the conversation) or clear it (a provider outcome of
`providerState: null`).

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
- `runner.sqlite-wal` or `-shm` with no `runner.sqlite`, or beside an empty one:
  refused, listing them in `details.journalFiles`. They belong to a store that
  was moved or deleted, and SQLite would discard the commits they hold. Move
  them back beside their store, or delete them to start empty. A
  `runner.sqlite-journal` beside an empty file is left by a crash while
  initializing it; SQLite discards it and the file is initialized.
- `state.json`, `log.jsonl` or their `.tmp` files from the earlier, unreleased JSONL
  store: startup fails with `invalid_runner_storage`,
  listing them in `details.legacyFiles`. They are not migrated, modified, or
  shadowed by a new database. Keep them with the runner build that wrote them,
  or move them out of the directory to start empty.
- A file that is not SQLite, another application's database, a runner database
  of a different version, or a damaged runner database: refused. An existing
  file is judged through a read-only connection, so the database and any
  `-wal` left by a crash stay byte-for-byte unchanged (SQLite may rebuild the
  `-shm` index).

### Retention

By default the store retains every session, run and event, including captured
context and results, without bounds. `enso runner serve --retain-days N` deletes
finished runs (`completed`, `failed`, `cancelled`, `interrupted`) whose last update
is more than N days old, in a pass that starts once the runner is ready and then
hourly; startup does not wait for it, and stopping ends it. Each deletion is one
transaction, of at most 500 runs, that appends a `runs_deleted` event naming them,
advances the expired cursor to their last event, and deletes the run rows and all
their events. The same transaction deletes each session's `session_updated`
checkpoints at or below the expired cursor except its latest: each replaces every
mutable field, so only an expired cursor could need the older ones. `runs_deleted`
events are kept. Passes serve requests between transactions. Once at least 256
pages (1 MiB at SQLite's default 4 KiB page) are free, a pass then releases them
all (`auto_vacuum = INCREMENTAL`) in steps of 2048 pages (8 MiB), serving
requests between them; less is left for later writes to reuse. In WAL mode the
file shrinks at the next checkpoint, which an open `runner check` read
transaction can hold back. A pass goes by the pages actually
free, not by what it deleted, so space left by a pass that shutdown stopped is
returned by the next; meanwhile later writes reuse it. A failure while releasing
pages stops the runner like any failed durable write (`runner_storage_failure`);
the deletions it follows are already committed. Sessions, and runs that are still active, are
never deleted.
After deletion, the run's `requestID` is unknown (`run_not_found`) and free for a
new submission. Pagination of snapshots needs a later design.

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

## Claude provider

`--provider claude` runs each prompt as one Claude Agent SDK query
(`@anthropic-ai/claude-agent-sdk`, an optional dependency loaded only by this
command; without it, startup fails with `runner_provider_unavailable` before any
runner file is touched). The SDK starts Claude Code with the user's own
authentication and settings (user and project settings, CLAUDE.md, skills, as the
CLI does). Every turn is a paid agent call.

- **Directory and context.** The query runs with `cwd` set to the session's stored
  working directory. If that directory no longer exists the run fails with
  `working_directory_unavailable` without starting anything; no other directory
  is substituted. The prompt is the captured `text` plus the captured
  `selectedNodes` (node and note identities and content), sent as submitted
  except that `<enso_node` and `</enso_node` in content are escaped as `&lt;`, so
  content cannot break out of its node's framing; the canvas is never reread.
- **Conversations.** A session's `providerState` is `{conversationID}`. A turn
  continues it with the SDK's `resume`; a session without one starts a new
  conversation under a runner-allocated UUID (`sessionId`). Before the query
  starts, the run records `native: {conversationID, resume, promptUUID, model,
  permissionMode}`. A result is attributed to the turn only when the CLI echoes
  that prompt uuid, or (from CLIs that do not echo) when it is not marked as
  another origin, such as a background task. If Claude Code no longer has the
  conversation (its transcript was cleaned up or deleted), the turn is `failed`
  with `conversation_not_found`, whose message tells the user the history is lost
  and the next prompt starts a new conversation; the session's `providerState`
  (and any `uncertain` marker) is cleared, so it continues without recovery.
- **Configuration.** `--claude-permission-mode` is always passed explicitly
  (default `default`, so tools Claude Code would ask about become runner pending
  requests); `bypassPermissions` and `dontAsk` are not offered. `--claude-model`
  and `--claude-executable` select the model and a Claude Code executable (the
  path is resolved against the directory `serve` runs in and must be an
  executable file). These are runner settings, not session settings: a restart
  with other settings applies them to resumed conversations too.
- **Permissions and input.** Each permission callback becomes a `permission`
  request with ID `<requestID>:<toolUseID>`, choices `allow`, `allow_session`
  (grants Claude's suggested rule, or the tool, for the rest of that turn: each turn is a new Claude Code process) and
  `deny`, and `details: {toolName, toolUseID, input, reason?, blockedPath?, agentID?}`
  (input over 32 KiB is replaced by a preview). `allow_session` is omitted when
  Claude Code forbids a standing grant. `AskUserQuestion` becomes an `input`
  request with structured `questions`; the answers are returned to Claude keyed by
  question text, lists joined with `, `. A denial is returned to Claude as a
  denied tool call and the turn continues; the result lists denials in
  `permissionDenials`.
- **Concurrent callbacks.** Claude can ask about several parallel tool calls at
  once. The provider queues them in arrival order and shows one at a time: only
  the pending request is persisted, and the next one becomes pending once it is
  answered. A request Claude withdraws (its tool call was cancelled) is removed
  durably if it was pending, and silently denied if it was still queued; a late
  answer to it returns `pending_not_found`.
- **Outcomes.** Only the turn's result frame confirms an outcome. A success
  result is `completed` with `result: {text, conversationID, promptUUID, numTurns,
  durationMs, totalCostUSD, stopReason, terminalReason, permissionDenials}`. Error
  results (API errors such as `api_error_429`, `error_max_turns`, an abort the
  runner did not request, ...) are `failed`, keeping the conversation when Claude
  reported it. A stream that fails (`claude_disconnected`) or ends without that
  result (`claude_ended_without_result`) is `interrupted`, never failed or
  cancelled. The exception is Claude Code failing to start (a missing or
  unexecutable binary, before any frame): nothing ran, so the turn is `failed`
  with `claude_unavailable` (`cancelled` if a stop was already requested).
- **Cancellation.** Cancelling requests `interrupt()` and waits up to 20 seconds
  for the CLI to acknowledge it and report the turn's end. A pending or queued
  permission is denied with `interrupt`. An aborted or `error_during_execution`
  result after the request confirms `cancelled`; a success result that arrives
  first is `completed`. No confirmation in time, a refused interrupt, or a stream
  that ends without a result is `interrupted` with `cancel_unconfirmed` and
  `details.interrupt` (`pending`, `acknowledged` or `failed`). The query is closed
  in every case, which ends the CLI process and any background shell it started.
- **Bridge.** See Bridge below. The system prompt names the session's canvas,
  says it cannot navigate, and tells Claude to stop and report a
  `target_not_active`, `bridge_instance_mismatch` or other binding refusal rather
  than retry or work around it. A session with no pinned instance is told the
  bridge is unavailable.

## Bridge

The runner pins a Claude session to one app bridge instance, vault and canvas for
the session's whole life, and gives Claude's process tree an `enso` CLI bound to
them. The pin is never changed, re-read or migrated.

**Pinning at creation.** For a runner whose provider gives its agent the bridge
(`claude`), `POST /v1/sessions` validates the request, then reads
`GET <bridgeUrl>/v1/health` (3 second timeout, no credentials) and stores the
`bridgeInstanceID` it advertises in the binding, all before committing anything.
If the instance cannot be pinned, no session is created:

| Code | HTTP | When |
| --- | --- | --- |
| `app_unavailable` | 503 | Nothing answers at `bridgeUrl` |
| `invalid_response` | 502 | The health reply is not a bridge envelope |
| `access_disabled` | 409 | Local agent access is off in Enso's Settings |
| `app_outdated` | 409 | The app speaks a bridge contract below 3 (no explicit canvas targets) |
| `bridge_instance_unavailable` | 409 | The app advertises no valid `bridgeInstanceID` |
| `bridge_instance_mismatch` | 409 | The request's `binding.bridgeInstanceID` differs from the advertised one (`details: {bridgeUrl, expectedInstanceID, instanceID}`) |

Creation fails rather than creating a session with the bridge disabled because a
binding never changes: such a session could never use the bridge, and a client
would have to notice that to recover. The client retries creation once the app is
available. A native client should send the instance it knows it is (its own
`bridgeInstanceID`), so the runner cannot pin another process that answers at the
address. `binding.bridgeInstanceID` on a fake runner's session is `invalid_input`.

**The agent's environment.** Each Claude turn starts with the runner's own
environment minus every binding variable, then, for a pinned session:

| Variable | Value |
| --- | --- |
| `ENSO_RUNNER_BRIDGE` | `bound` |
| `ENSO_BRIDGE_URL` | The binding's `bridgeUrl` |
| `ENSO_BRIDGE_INSTANCE_ID` | The binding's `bridgeInstanceID` |
| `ENSO_VAULT_ID`, `ENSO_CANVAS_ID` | The binding's `canvasTarget` |
| `ENSO_BRIDGE_TOKEN` | The bridge pairing token, when the runner finds one |

A session without a pinned instance gets only `ENSO_RUNNER_BRIDGE=disabled`.

The pairing token is looked up for each turn, in the token file the app at
`bridgeUrl` names on `/v1/health` (accepted only if it names no other origin), then
in the CLI's stored pairing if it is for the same origin. It is passed only in
the environment: it is not written to the runner's state, events, snapshots,
results or output, and the runner neither links the CLI nor changes its stored
pairing. Claude can read its own environment, so it can repeat the token; the
provider replaces it with `[redacted]` in pending requests and outcomes before the
runner commits them. Claude's own transcript, which Claude Code keeps, is outside
the runner and is not redacted.

**What the bound CLI does.** With `ENSO_RUNNER_BRIDGE=bound` the `enso` CLI uses
only that bridge and token (no configuration file, discovery or relinking), and:

- Reads `/v1/health` once per invocation, before any other request, and refuses
  the invocation unless the advertised `bridgeInstanceID` is the expected one
  (`bridge_instance_mismatch`, or `bridge_instance_unavailable` when none is
  advertised), so an app that would not enforce the header gets nothing.
- Sends `Enso-Bridge-Instance: <bridgeInstanceID>` on every request, so the app
  can refuse a mismatch in the same request that does the work. The CLI does the
  same whenever `ENSO_BRIDGE_INSTANCE_ID` is set, inside the runner or not.
- Binds every canvas request to the session's `canvasTarget` (bridge contract 3).
  The app refuses it with `target_not_active` when the user has another canvas
  open, and `wrong_vault` for another vault.
- Refuses before contacting the bridge: navigation (opening, creating or deleting
  canvases, opening vaults or portals, vault changes) with
  `explicit_navigation_required`; linking, unlinking and pairing
  (`explicit_navigation_required` for the commands, `runner_bridge_refused` for
  discovery); `--canvas` selectors, other `--vault-id`/`--canvas-id` values, or a
  request to another origin with `target_conflict`; and a request without the
  session's binding (`ENSO_VAULT_ID`/`ENSO_CANVAS_ID` unset, or any binding
  variable missing) with `runner_binding_required`. A missing token is
  `auth_required`.
- Reports every refusal, the app's included, with its code, message and details
  unchanged, and adds a `details.hint` (when the app gave none) telling the agent
  to stop and tell the user. Nothing is navigated, retargeted, re-pinned or
  retried.

With `ENSO_RUNNER_BRIDGE` set to anything else (`disabled`), the CLI refuses
every bridge request, linking included, with `bridge_unavailable`.

These checks guard against mistakes. A same-user process that rewrites its own
environment, or calls the bridge without the CLI, is not stopped by them; the
app's token and access rules still apply.

**Outcomes.** A canvas operation, successful or refused, is a tool call within the
turn. It never ends the turn by itself: the outcome still comes only from the
turn's result frame (or its absence, which is `interrupted`). Canvas changes made
before a refusal or an interrupted turn stay made; the runner does not inspect or
undo them.

**Expected bridge contract.** The runner and CLI rely on the app to advertise
`bridgeInstanceID` on `/v1/health`, to change it when a different app process
answers at the address (at least once per app launch), and, when it advertises
one, to refuse any request whose `Enso-Bridge-Instance` header names another
instance with `bridge_instance_mismatch`, in the request itself and without doing
the work. The CLI treats the advertised field as the capability; it does not
require a newer bridge contract version. These names are the CLI's side of that
contract, and must match the app's.

## Remaining prerequisites

- The app must advertise and enforce the bridge instance (see Expected bridge
  contract). Until an app build does, Claude sessions cannot be created against
  it (`bridge_instance_unavailable`). The app bridge is not in this repository.
- The native client should create sessions with explicit UUIDs, its own
  `bridgeInstanceID`, and a separately chosen codebase directory, handle the
  pinning errors above, capture selected node content before submitting,
  generate and retain request IDs before sending, and recover via snapshot plus
  cursor polling. A disconnected UI is not a stopped turn. It should render
  pending requests (including `details` and `questions`) from the run, stop by
  requesting cancellation and observing terminal confirmation, show interrupted
  outcomes as uncertain with their error details, and ask the user to choose
  `resume` or `fresh` for an uncertain session rather than choosing silently.
- Recovery does not inspect Claude's transcript: `resume` continues whatever the
  conversation holds, including a partial turn.
