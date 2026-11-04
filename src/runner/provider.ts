import { setTimeout as delay } from "node:timers/promises";
import type { Answer, Json, Pending, Prompt, Run, Session } from "./protocol.js";

export type ProviderOutcome =
  | { status: "completed"; result: Json; providerState?: Json }
  | { status: "failed" | "interrupted"; error: NonNullable<Run["error"]> }
  | { status: "cancelled" };
export type Execution = {
  session: Readonly<Session>;
  prompt: Readonly<Prompt>;
  signal: AbortSignal;
  wait: (pending: Pending) => Promise<Answer>;
};
/** Return only after the provider confirms completion/cancellation; uncertain effects use interrupted.
 * providerState is an opaque conversation checkpoint, committed with a completed result.
 * At most one wait() may be pending per run; a concurrent second wait() rejects and leaves the first answerable.
 * A future provider must reconcile interrupted work explicitly, never by replaying execute(). */
export interface RunnerProvider {
  readonly name: "fake";
  execute(execution: Execution): Promise<ProviderOutcome>;
}

export class FakeProvider implements RunnerProvider {
  readonly name = "fake" as const;
  async execute({ session, prompt, signal, wait }: Execution): Promise<ProviderOutcome> {
    try {
      await delay(prompt.fake.delayMs, undefined, { signal });
      let answer: Answer | undefined;
      if (prompt.fake.scenario === "permission" || prompt.fake.scenario === "input") {
        answer = await wait({
          id: `${prompt.requestID}:wait`, kind: prompt.fake.scenario,
          message: prompt.fake.scenario === "permission" ? "Allow this fake operation?" : "Enter fake input",
          ...(prompt.fake.scenario === "permission" ? { choices: ["allow", "deny"] } : {})
        });
      }
      signal.throwIfAborted();
      if (prompt.fake.scenario === "interrupted") return { status: "interrupted", error: { code: "fake_uncertain", message: "Fake provider cannot confirm execution outcome" } };
      const denied = prompt.fake.scenario === "permission" && answer?.value === "deny";
      if (prompt.fake.scenario === "failure" || denied) return { status: "failed", error: { code: "fake_failure", message: "Fake execution failed or permission was denied", details: { scenario: prompt.fake.scenario, denied } } };
      const turn = Number((session.providerState as { turn?: number } | undefined)?.turn ?? 0) + 1;
      return { status: "completed", result: {
        text: `Fake response: ${prompt.text}`, context: prompt.context,
        binding: session.binding, answer: answer?.value ?? null, turn
      }, providerState: { turn } };
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      throw error;
    }
  }
}
