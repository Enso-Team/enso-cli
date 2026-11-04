import { storageVersion, terminal, type Run, type RunnerEvent, type Session, type Snapshot } from "./protocol.js";

/** In-memory runner state. Records are never mutated in place, so retained events and served copies stay valid.
 * `busy` maps each session to its single non-terminal run and is derived by apply(). */
export type State = { sequence: number; sessions: Map<string, Session>; runs: Map<string, Run>; busy: Map<string, string> };

export function restore(snapshot: Snapshot): State {
  const state: State = { sequence: snapshot.sequence, sessions: new Map(), runs: new Map(), busy: new Map() };
  for (const session of snapshot.sessions) {
    if (state.sessions.has(session.id)) throw new Error("Duplicate session");
    state.sessions.set(session.id, session);
  }
  for (const run of snapshot.runs) {
    const { requestID, sessionID } = run.request;
    if (state.runs.has(requestID) || !state.sessions.has(sessionID)) throw new Error("Duplicate run or unknown session");
    state.runs.set(requestID, run);
    if (terminal(run.status)) continue;
    if (state.busy.has(sessionID)) throw new Error("Two active runs in one session");
    state.busy.set(sessionID, requestID);
  }
  return state;
}

export function toSnapshot(state: State): Snapshot {
  return { storageVersion, sequence: state.sequence, sessions: [...state.sessions.values()], runs: [...state.runs.values()] };
}

/** The only state transition, used live after each transaction and when replaying the log. Throws on invariant failure. */
export function apply(state: State, event: RunnerEvent): void {
  if (event.sequence !== state.sequence + 1) throw new Error("Event sequence gap");
  if (event.type === "session_created") {
    if (state.sessions.has(event.session.id)) throw new Error("Duplicate session");
    state.sessions.set(event.session.id, event.session);
  } else if (event.type === "session_updated") {
    const session = state.sessions.get(event.sessionID);
    if (!session) throw new Error("Unknown session");
    const { providerState: _, ...rest } = session;
    state.sessions.set(session.id, event.providerState === undefined ? rest : { ...rest, providerState: event.providerState });
  } else if (event.type === "run_accepted") {
    const { requestID, sessionID } = event.run.request;
    if (event.run.status !== "accepted" || state.runs.has(requestID) || !state.sessions.has(sessionID) || state.busy.has(sessionID)) {
      throw new Error("Invalid run acceptance");
    }
    state.runs.set(requestID, event.run);
    state.busy.set(sessionID, requestID);
  } else {
    const { sequence: _, type: __, requestID, status, updatedAt, ...fields } = event;
    const run = state.runs.get(requestID);
    // Terminal records are immutable, so replacing the mutable fields never discards a result.
    if (!run || terminal(run.status) || status === "accepted") throw new Error("Invalid run update");
    state.runs.set(requestID, { request: run.request, status, createdAt: run.createdAt, updatedAt, ...fields });
    if (terminal(status)) state.busy.delete(run.request.sessionID);
  }
  state.sequence = event.sequence;
}

/** Applies one transaction all-or-nothing: if any event or `persist` throws, the state is restored. */
export function transact(state: State, events: RunnerEvent[], persist: () => void = () => {}): void {
  const sequence = state.sequence;
  const undo: Array<() => void> = [];
  const save = <V>(map: Map<string, V>, key: string) => {
    const value = map.get(key);
    undo.push(() => { if (value === undefined) map.delete(key); else map.set(key, value); });
  };
  try {
    for (const event of events) {
      if (event.type === "session_created" || event.type === "session_updated") {
        save(state.sessions, event.type === "session_created" ? event.session.id : event.sessionID);
      } else {
        const run = event.type === "run_accepted" ? event.run : state.runs.get(event.requestID);
        save(state.runs, event.type === "run_accepted" ? event.run.request.requestID : event.requestID);
        if (run) save(state.busy, run.request.sessionID);
      }
      apply(state, event);
    }
    persist();
  } catch (error) {
    for (const step of undo.reverse()) step();
    state.sequence = sequence;
    throw error;
  }
}
