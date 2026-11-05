// A separate process is killed at actual durable-write boundaries, not a simulated restart.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { FakeProvider, type Execution } from "../../src/runner/provider.js";
import type { Change, RunnerEvent } from "../../src/runner/protocol.js";
import { startRunner } from "../../src/runner/service.js";
import { RunnerStorage } from "../../src/runner/storage.js";

const directory = process.argv[2];
const boundary = process.argv[3];
const kill = () => process.kill(process.pid, "SIGKILL");
const statuses = (changes: Change[]) => changes.map(change => change.type === "run_accepted" ? change.run.status : change.type === "run_updated" ? change.status : undefined);
const storage = RunnerStorage.prototype as unknown as {
  commit(changes: Change[]): void;
  apply(db: BetterSqlite3.Database, event: RunnerEvent): void;
};
const commit = storage.commit;
storage.commit = function (changes) {
  if (boundary === "before_completed" && statuses(changes).includes("completed")) kill();
  commit.call(this, changes);
  if (boundary === "checkpointed" && statuses(changes).includes("completed")) {
    // Move the commit from the WAL into the main database file first.
    (this as unknown as { db: BetterSqlite3.Database }).db.pragma("wal_checkpoint(TRUNCATE)");
    kill();
  }
  if (statuses(changes).includes(boundary as never)) kill();
};
const apply = storage.apply;
storage.apply = function (db, event) {
  apply.call(this, db, event);
  // Inside the open completion transaction: the result is written, its session checkpoint is not, nothing is committed.
  if (boundary === "mid_completed" && event.type === "run_updated" && event.status === "completed") kill();
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
