import { EnsoCliError } from "./errors.js";
import { parseTarget, type CanvasTarget } from "./targeting.js";

/**
 * How the local runner hands a session's bridge binding to the agent it runs, and how the `enso` CLI reads it back.
 * `ENSO_RUNNER_BRIDGE` is `bound` for a session with a pinned bridge instance and `disabled` for one without; unset
 * outside the runner.
 */
export const runnerBridgeEnv = "ENSO_RUNNER_BRIDGE";
export const bridgeUrlEnv = "ENSO_BRIDGE_URL";
export const bridgeTokenEnv = "ENSO_BRIDGE_TOKEN";
export const bridgeInstanceEnv = "ENSO_BRIDGE_INSTANCE_ID";
export const vaultEnv = "ENSO_VAULT_ID";
export const canvasEnv = "ENSO_CANVAS_ID";
/** Every variable that carries a binding. The runner clears them all before setting a session's own. */
export const bindingEnvNames = [runnerBridgeEnv, bridgeUrlEnv, bridgeTokenEnv, bridgeInstanceEnv, vaultEnv, canvasEnv] as const;

/** Sent with the expected instance on every bridge request; an app that advertises `bridgeInstanceID` refuses a mismatch. */
export const bridgeInstanceHeader = "Enso-Bridge-Instance";
/** Opaque, and safe to send as a header value: visible ASCII without spaces. */
const instancePattern = /^[\x21-\x7e]{1,256}$/;
export function isBridgeInstanceID(value: unknown): value is string {
  return typeof value === "string" && instancePattern.test(value);
}

/** The instance a `/v1/health` payload advertises, if any. */
export function advertisedInstance(health: unknown): string | undefined {
  const id = (health as { bridgeInstanceID?: unknown } | null | undefined)?.bridgeInstanceID;
  return isBridgeInstanceID(id) ? id : undefined;
}

/** The bridge instance every request of this process must reach, when one is expected. */
export function expectedBridgeInstance(): string | undefined {
  const value = process.env[bridgeInstanceEnv];
  if (value === undefined || value === "") return undefined;
  if (!isBridgeInstanceID(value)) {
    throw new EnsoCliError("invalid_input", `${bridgeInstanceEnv} must be the bridge instance ID the Enso app advertises on /v1/health`);
  }
  return value;
}

/** Refuses an app that cannot prove the expected instance before credentials or work are sent to it. */
export function assertExpectedBridgeInstance(health: unknown, bridgeUrl: string, expected: string | undefined): void {
  if (expected === undefined) return;
  const actual = advertisedInstance(health);
  if (actual === undefined) {
    throw new EnsoCliError("bridge_instance_unavailable", "The Enso app at this bridge address advertises no bridge instance, so it cannot be checked against the expected one", {
      bridgeUrl, expectedInstanceID: expected
    });
  }
  if (actual !== expected) {
    throw new EnsoCliError("bridge_instance_mismatch", "A different Enso app instance answers at this bridge address than the one this invocation is bound to", {
      bridgeUrl, expectedInstanceID: expected, instanceID: actual
    });
  }
}

export type RunnerBridge = { bridgeUrl: string; instanceID: string; target: CanvasTarget; token?: string };

/**
 * The binding of a runner session whose bridge is bound, or undefined outside one (and in a disabled one, which
 * `assertBridgeAllowed` refuses outright). A bound session missing any part of its binding is refused, never completed
 * from the CLI's own configuration or discovery.
 */
export function runnerBridge(): RunnerBridge | undefined {
  if (process.env[runnerBridgeEnv] !== "bound") return undefined;
  const bridgeUrl = process.env[bridgeUrlEnv];
  const instanceID = process.env[bridgeInstanceEnv];
  const vaultID = process.env[vaultEnv], canvasID = process.env[canvasEnv];
  let origin: string | undefined;
  try { if (bridgeUrl) origin = new URL(bridgeUrl).origin; } catch { /* refused below */ }
  if (!origin || !isBridgeInstanceID(instanceID) || !vaultID || !canvasID) {
    throw new EnsoCliError("runner_binding_required", "This runner session's bridge binding is incomplete, so the CLI refuses every bridge request", {
      required: [bridgeUrlEnv, bridgeInstanceEnv, vaultEnv, canvasEnv],
      hint: "Stop and tell the user. Do not set or change ENSO_* variables to work around it; the runner sets the session's binding"
    });
  }
  const token = process.env[bridgeTokenEnv];
  return { bridgeUrl: origin, instanceID, target: parseTarget({ vaultID, canvasID }), ...(token ? { token } : {}) };
}
