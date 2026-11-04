// A separate process is killed at actual durable-write boundaries, not a simulated restart.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeProvider, type Execution } from "../../src/runner/provider.js";
import { startRunner } from "../../src/runner/service.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import type { Snapshot } from "../../src/runner/protocol.js";

const directory = process.argv[2];
const boundary = process.argv[3];
const originalAppend = RunnerStorage.prototype.append;
RunnerStorage.prototype.append = function (events) {
  const statuses = events.map(event => event.type === "run_accepted" ? event.run.status : event.type === "run_updated" ? event.status : undefined);
  if (boundary === "before_completed" && statuses.includes("completed")) process.kill(process.pid, "SIGKILL");
  if (boundary === "torn_completed" && statuses.includes("completed")) {
    // Part of the (multi-event) transaction line reaches the file, but never its newline or fsync.
    appendFileSync(join(directory, "log.jsonl"), JSON.stringify({ events }).slice(0, 60));
    process.kill(process.pid, "SIGKILL");
  }
  originalAppend.call(this, events);
  if (statuses.includes(boundary as never)) process.kill(process.pid, "SIGKILL");
};
if (boundary === "compacted") {
  // Compact after every transaction; crash after the snapshot rename, before the log is emptied.
  RunnerStorage.prototype.compactionDue = () => true;
  const originalWrite = RunnerStorage.prototype.write;
  RunnerStorage.prototype.write = function (name, value) {
    const bytes = originalWrite.call(this, name, value);
    if (name === "state.json" && (value as Snapshot).runs.some(run => run.status === "completed")) process.kill(process.pid, "SIGKILL");
    return bytes;
  };
}
class CountingFake extends FakeProvider {
  override execute(execution: Execution) {
    let count = 0;
    try { count = Number(readFileSync(join(directory, "executions"), "utf8")); } catch { /* first dispatch */ }
    writeFileSync(join(directory, "executions"), String(count + 1));
    return super.execute(execution);
  }
}
await startRunner({ directory, provider: new CountingFake() });
process.stdout.write("ready\n");
