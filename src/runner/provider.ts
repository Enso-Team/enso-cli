import { setTimeout as delay } from "node:timers/promises";
import { EnsoCliError } from "../errors.js";
import { defaultFakeOptions, type Answer, type Json, type Pending, type Prompt, type ProviderName, type Run, type Session } from "./protocol.js";

export type ProviderOutcome =
  | { status: "completed"; result: Json; providerState?: Json }
  | { status: "failed"; error: NonNullable<Run["error"]>; providerState?: Json }
  | { status: "cancelled"; providerState?: Json }
  | { status: "interrupted"; error: NonNullable<Run["error"]> };
/** Cleanup could not prove execution stopped. Fail the runner closed and retain ownership until `exited` resolves. */
export class ProviderCleanupError extends EnsoCliError {
  constructor(message: string, readonly exited: Promise<void>, details: Record<string, unknown> = {}) {
    super("runner_cleanup_failure", message, details);
  }
}
export type Execution = {
  /** The session as stored, including its working directory, conversation checkpoint and any `uncertain` marker. */
  session: Readonly<Session>;
  /** The captured prompt as accepted; the provider never rereads the canvas to replace its context. */
  prompt: Readonly<Prompt>;
  signal: AbortSignal;
  /**
   * Durably records the provider's native identifiers for this run (conversation, prompt, execution) and returns once
   * they are committed. A provider calls it before any native call that could make those identifiers meaningful, so a
   * crash after that call always leaves them in the interrupted run. Throws if the commit fails: do not proceed.
   */
  record: (native: Json) => void;
  /** Persists `pending` and resolves with its answer; rejects on cancellation, or once `withdrawn` aborts (the pending
   * request is then removed durably). */
  wait: (pending: Pending, withdrawn?: AbortSignal) => Promise<Answer>;
};
/**
 * Return only after execution processes have exited and the provider confirms an outcome; uncertain effects use
 * interrupted. If cleanup cannot confirm exit, throw ProviderCleanupError instead of releasing the active slot.
 * Any confirmed outcome may carry providerState, the opaque conversation checkpoint committed with it to the
 * session; null clears it. A confirmed
 * outcome that carries it also reconciles an uncertain session.
 * At most one wait() may be pending per run; a concurrent second wait() rejects and leaves the first answerable. A
 * provider whose native runtime asks concurrently serializes those requests itself (see ClaudeProvider).
 * Interrupted work is never replayed by calling execute() again: the runner marks its session uncertain, and the next
 * prompt must name a recovery mode, which the provider sees as `prompt.recovery` with `session.uncertain`.
 */
export interface RunnerProvider {
  readonly name: ProviderName;
  execute(execution: Execution): Promise<ProviderOutcome>;
}

export class FakeProvider implements RunnerProvider {
  readonly name = "fake" as const;
  async execute({ session, prompt, signal, wait }: Execution): Promise<ProviderOutcome> {
    const fake = prompt.fake ?? defaultFakeOptions;
    try {
      await delay(fake.delayMs, undefined, { signal });
      let answer: Answer | undefined;
      if (fake.scenario === "permission" || fake.scenario === "input") {
        answer = await wait({
          id: `${prompt.requestID}:wait`, kind: fake.scenario,
          message: fake.scenario === "permission" ? "Allow this fake operation?" : "Enter fake input",
          ...(fake.scenario === "permission" ? { choices: ["allow", "deny"] } : {})
        });
      }
      signal.throwIfAborted();
      if (fake.scenario === "interrupted") return { status: "interrupted", error: { code: "fake_uncertain", message: "Fake provider cannot confirm execution outcome" } };
      const denied = fake.scenario === "permission" && answer?.value === "deny";
      if (fake.scenario === "failure" || denied) return { status: "failed", error: { code: "fake_failure", message: "Fake execution failed or permission was denied", details: { scenario: fake.scenario, denied } } };
      const turn = Number((session.providerState as { turn?: number } | undefined)?.turn ?? 0) + 1;
      return { status: "completed", result: {
        text: `Fake response: ${prompt.text}`, context: prompt.context,
        binding: session.binding, answer: (answer?.value ?? null) as Json, turn
      }, providerState: { turn } };
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      throw error;
    }
  }
}
