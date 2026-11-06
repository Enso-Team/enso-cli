// A runner whose Codex provider plays a replay transcript, killed at a durable-write boundary of a Codex run.
import { writeSync } from "node:fs";
import type { CodexNative } from "../../src/runner/codex.js";
import { CodexProvider } from "../../src/runner/codex.js";
import type { Change } from "../../src/runner/protocol.js";
import { startRunner } from "../../src/runner/service.js";
import { kill, killAroundCommit } from "./crash-boundary.js";
import { codexReplay, codexTranscript } from "./replay/codex.js";

const [directory, boundary, fixture, workspace] = process.argv.slice(2);
const updates = (changes: Change[]) => changes.flatMap(change => change.type === "run_updated" ? [change] : []);
/**
 * Which boundary a commit crosses: the dispatch marker, the identifiers recorded before the app-server starts, once
 * Codex names the thread, once it names the turn, a pending request, or the outcome.
 */
function crosses(changes: Change[]): string | undefined {
  for (const update of updates(changes)) {
    if (update.status === "completed") return "completed";
    if (update.status === "waiting_permission") return "waiting_permission";
    if (update.status === "running") {
      const native = update.native as CodexNative | undefined;
      if (!native) return "dispatched";
      return native.turnID ? "turn" : native.threadID && !native.resume ? "thread" : "recorded";
    }
  }
  return undefined;
}
killAroundCommit(
  // The provider confirmed completion, but its commit never happened.
  changes => boundary === "before_completed" && crosses(changes) === "completed",
  changes => crosses(changes) === boundary
);

const codex = codexReplay(codexTranscript(fixture, workspace));
// A run that never reaches its boundary: the parent asks where playback stopped, and why, before it is killed.
process.on("SIGTERM", () => {
  const [replay] = codex.replays;
  const at = `entry ${replay.cursor + 1} of ${replay.transcript.entries.length}${replay.entry?.label ? ` (${replay.entry.label})` : ""}`;
  writeSync(2, `Replay of ${fixture} stopped at ${at}${replay.failure ? `: ${replay.failure.message}` : ""}\n`);
  kill();
});
await startRunner({ directory, provider: new CodexProvider(codex.connect, { executable: "codex", approvalPolicy: "on-request", sandbox: "workspace-write" }, { stopTimeoutMs: 50, exitGraceMs: 50 }) });
process.stdout.write("ready\n");
