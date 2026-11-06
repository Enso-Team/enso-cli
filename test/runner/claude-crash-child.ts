// A runner whose Claude provider plays a replay transcript, killed at a durable-write boundary of a Claude run.
import { ClaudeProvider } from "../../src/runner/claude.js";
import type { Change } from "../../src/runner/protocol.js";
import { startRunner } from "../../src/runner/service.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import { claudeReplay, claudeTranscript, nativeSessionID } from "./replay/claude.js";

const [directory, boundary, fixture, workspace] = process.argv.slice(2);
const kill = () => process.kill(process.pid, "SIGKILL");
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
const storage = RunnerStorage.prototype as unknown as { commit(changes: Change[]): void };
const commit = storage.commit;
storage.commit = function (changes) {
  const crossed = crosses(changes);
  // The provider confirmed completion, but its commit never happened.
  if (boundary === "before_completed" && crossed === "completed") kill();
  commit.call(this, changes);
  if (crossed === boundary) kill();
};

const transcript = claudeTranscript(fixture, workspace);
const sdk = claudeReplay(transcript);
const first = [nativeSessionID(transcript), "00000000-0000-4000-8000-000000000001"];
await startRunner({ directory, provider: new ClaudeProvider(sdk.query, { permissionMode: "default" }, { stopTimeoutMs: 50, newID: () => first.shift()! }) });
process.stdout.write("ready\n");
