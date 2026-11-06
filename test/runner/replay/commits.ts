import { terminal, type Change, type Run } from "../../../src/runner/protocol.js";
import type { RunnerStorage } from "../../../src/runner/storage.js";

/** One persisted run transition, in commit order: what a client following events would see. */
export type Transition = { requestID: string; status: Run["status"]; pending?: string; native: boolean };

/**
 * Observes every durable commit on `storage`, so a test waits for the exact transaction it means rather than polling:
 * `reached` resolves once the commit putting the run in that status has returned. A run that finishes in another status
 * rejects the wait with the run's error, which carries a replay divergence when that is what ended it.
 */
export function observeCommits(storage: RunnerStorage) {
  const changes: Change[] = [];
  const listeners = new Set<() => void>();
  const commit = storage.commit.bind(storage);
  storage.commit = (batch: Change[]) => {
    commit(batch);
    changes.push(...batch);
    for (const listener of [...listeners]) listener();
  };

  /** With `pendingID`, waits for that pending request specifically. */
  function reached(requestID: string, status: Run["status"], pendingID?: string): Promise<Run> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const run = storage.run(requestID);
        if (run?.status === status && (pendingID === undefined || run.pending?.id === pendingID)) { listeners.delete(check); resolve(run); }
        else if (run && terminal(run.status)) {
          listeners.delete(check);
          reject(new Error(`Run ${requestID} ended ${run.status}, not ${status}: ${JSON.stringify(run.error ?? run.result ?? null)}`));
        }
      };
      listeners.add(check);
      check();
    });
  }

  /** The run's persisted transitions so far. */
  function transitions(requestID: string): Transition[] {
    return changes.flatMap((change): Transition[] => {
      if (change.type === "run_accepted" && change.run.request.requestID === requestID) return [{ requestID, status: change.run.status, native: false }];
      if (change.type !== "run_updated" || change.requestID !== requestID) return [];
      return [{ requestID, status: change.status, native: change.native !== undefined, ...(change.pending ? { pending: change.pending.id } : {}) }];
    });
  }

  return { changes, reached, transitions };
}
export type Commits = ReturnType<typeof observeCommits>;
