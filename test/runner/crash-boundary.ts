// Kills a crash child's runner at a durable-write boundary of RunnerStorage.commit.
import type BetterSqlite3 from "better-sqlite3";
import type { Change } from "../../src/runner/protocol.js";
import { RunnerStorage } from "../../src/runner/storage.js";

export const kill = () => process.kill(process.pid, "SIGKILL");

/** Kills before a commit whose changes match `before`, or once it is written when `after` returns true. */
export function killAroundCommit(
  before: (changes: Change[]) => boolean,
  after: (changes: Change[], db: BetterSqlite3.Database) => boolean
): void {
  const storage = RunnerStorage.prototype as unknown as { commit(changes: Change[]): void };
  const commit = storage.commit;
  storage.commit = function (changes) {
    if (before(changes)) kill();
    commit.call(this, changes);
    if (after(changes, (this as unknown as { db: BetterSqlite3.Database }).db)) kill();
  };
}
