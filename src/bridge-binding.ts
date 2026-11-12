import { EnsoCliError } from "./errors.js";

export const bridgeInstanceEnv = "ENSO_BRIDGE_INSTANCE_ID";
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
