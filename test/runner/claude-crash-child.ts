// A runner whose Claude provider plays a replay transcript, killed at a durable-write boundary of a Claude run.
import { writeSync } from "node:fs";
import { ClaudeProvider } from "../../src/runner/claude.js";
import type { Change } from "../../src/runner/protocol.js";
import { startRunner } from "../../src/runner/service.js";
import { kill, killAroundCommit } from "./crash-boundary.js";
import { claudeReplay, claudeTranscript, nativeSessionID } from "./replay/claude.js";

const [directory, boundary, fixture, workspace] = process.argv.slice(2);
const updates = (changes: Change[]) => changes.flatMap(change => change.type === "run_updated" ? [change] : []);
/** Which boundary a commit crosses: the dispatch marker, the native identifiers, a pending request, or the outcome. */
function crosses(changes: Change[]): string | undefined {
  for (const update of updates(changes)) {
    if (update.status === "completed") return "completed";
    if (update.status === "waiting_permission") return "waiting_permission";
    if (update.status === "running") return update.native === undefined ? "dispatched" : "recorded";
  }
  return undefined;
}
killAroundCommit(
  // The provider confirmed completion, but its commit never happened.
  changes => boundary === "before_completed" && crosses(changes) === "completed",
  changes => crosses(changes) === boundary
);

const transcript = claudeTranscript(fixture, workspace);
const sdk = claudeReplay(transcript);
const first = [nativeSessionID(transcript), "00000000-0000-4000-8000-000000000001"];
// A run that never reaches its boundary: the parent asks where playback stopped, and why, before it is killed.
process.on("SIGTERM", () => {
  const [replay] = sdk.replays;
  const at = `entry ${replay.cursor + 1} of ${replay.transcript.entries.length}${replay.entry?.label ? ` (${replay.entry.label})` : ""}`;
  writeSync(2, `Replay of ${fixture} stopped at ${at}${replay.failure ? `: ${replay.failure.message}` : ""}\n`);
  kill();
});
const claude = new ClaudeProvider(sdk.query, { permissionMode: "default" }, { stopTimeoutMs: 50, newID: () => first.shift()! });
// Pins no bridge, so the recorded transcripts' bridge-disabled environment holds and no app is contacted.
await startRunner({ directory, provider: { name: claude.name, execute: execution => claude.execute(execution) } });
process.stdout.write("ready\n");
