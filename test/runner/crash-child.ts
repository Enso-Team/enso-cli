// A separate process is killed at actual durable-write boundaries, not a simulated restart.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeProvider, type Execution } from "../../src/runner/provider.js";
import { startRunner } from "../../src/runner/service.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import type { State } from "../../src/runner/protocol.js";

const directory = process.argv[2];
const boundary = process.argv[3];
const originalWrite = RunnerStorage.prototype.write;
RunnerStorage.prototype.write = function (name, value) {
  const state = value as State;
  const last = name === "state.json" ? state.runs.at(-1) : undefined;
  if (boundary === "before_completed" && last?.status === "completed") process.kill(process.pid, "SIGKILL");
  originalWrite.call(this, name, value);
  if ((boundary === "accepted" && last?.status === "accepted") ||
      (boundary === "running" && last?.status === "running") ||
      (boundary === "completed" && last?.status === "completed") ||
      (boundary === "waiting_input" && last?.status === "waiting_input") ||
      (boundary === "stopping" && last?.status === "stopping")) process.kill(process.pid, "SIGKILL");
};
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
