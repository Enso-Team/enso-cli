import { join } from "node:path";
import Database from "better-sqlite3";
import type { RunnerEngine } from "../../src/runner/engine.js";
import { eventSchema, type Run, type RunnerEvent, type Session } from "../../src/runner/protocol.js";
import { databaseName, RunnerStorage } from "../../src/runner/storage.js";

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
      const { providerState: _, uncertain: __, ...session } = next.sessions[index];
      next.sessions[index] = {
        ...session,
        ...(event.providerState === undefined ? {} : { providerState: event.providerState }),
        ...(event.uncertain === undefined ? {} : { uncertain: event.uncertain })
      };
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

/**
 * The committed state as an independent read-only connection sees it: the stored events folded as a client folds
 * them, once `RunnerStorage.check` has validated the store and found its rows agree with those events. Needs a history
 * retention has not expired.
 */
export function durable(directory: string): Replica {
  const { differences } = RunnerStorage.check(directory);
  if (differences.length) throw new Error(`Runner rows disagree with their events: ${JSON.stringify(differences)}`);
  const db = new Database(join(directory, databaseName), { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT sequence, event_json FROM events ORDER BY sequence").all() as { sequence: number; event_json: string }[];
    return applyEvents(empty(), rows.map(row => eventSchema.parse({ ...JSON.parse(row.event_json), sequence: row.sequence })));
  } finally { db.close(); }
}
