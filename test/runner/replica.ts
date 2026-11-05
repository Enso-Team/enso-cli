import type { RunnerEngine } from "../../src/runner/engine.js";
import type { Run, RunnerEvent, Session } from "../../src/runner/protocol.js";
import { RunnerStorage } from "../../src/runner/storage.js";

/** What a client keeps: a snapshot advanced by events, applied exactly as docs/runner-protocol.md describes. */
export type Replica = { sessions: Session[]; runs: Run[]; cursor: number };
export const empty = (): Replica => ({ sessions: [], runs: [], cursor: 0 });

export function applyEvents(replica: Replica, events: RunnerEvent[]): Replica {
  const next = structuredClone(replica);
  for (const event of events) {
    if (event.sequence !== next.cursor + 1) throw new Error(`Expected sequence ${next.cursor + 1}, received ${event.sequence}`);
    if (event.type === "session_created") next.sessions.push(event.session);
    else if (event.type === "run_accepted") next.runs.push(event.run);
    else if (event.type === "session_updated") {
      const index = next.sessions.findIndex(session => session.id === event.sessionID);
      const { providerState: _, ...session } = next.sessions[index];
      next.sessions[index] = event.providerState === undefined ? session : { ...session, providerState: event.providerState };
    } else if (event.type === "runs_deleted") {
      next.runs = next.runs.filter(run => !event.requestIDs.includes(run.request.requestID));
    } else {
      const index = next.runs.findIndex(run => run.request.requestID === event.requestID);
      const { sequence: _, type: __, requestID: ___, ...fields } = event;
      next.runs[index] = { request: next.runs[index].request, createdAt: next.runs[index].createdAt, ...fields };
    }
    next.cursor = event.sequence;
  }
  return next;
}

/** Every event after `after`, following the paged cursor until caught up. */
export function allEvents(engine: RunnerEngine, after = 0): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  for (;;) {
    const page = engine.events(after);
    if (!page.events.length) return events;
    events.push(...page.events);
    after = page.cursor;
  }
}

/** The committed state as an independent read-only connection sees it. */
export function durable(directory: string): Replica {
  const storage = RunnerStorage.inspect(directory);
  try { return storage.snapshot(); } finally { storage.release(); }
}
