import { readFileSync } from "node:fs";
import { advertisedInstance, bindingEnvNames, bridgeInstanceEnv, bridgeTokenEnv, bridgeUrlEnv, canvasEnv, runnerBridgeEnv, vaultEnv } from "../bridge-binding.js";
import { envelopeSchema, isLoopbackBridgeUrl } from "../client.js";
import { readConfig } from "../config.js";
import { assertTargetingContract } from "../contract.js";
import { tokenFileSchema } from "../discovery.js";
import { EnsoCliError } from "../errors.js";
import type { Binding } from "./protocol.js";

/** Reads the bridge instance at `bridgeUrl` for a new session to pin. */
export type BridgeInstanceReader = (bridgeUrl: string) => Promise<string>;
/** The pairing token for a session's bridge, resolved at each turn and never stored; undefined when none is found. */
export type BridgeTokenReader = (bridgeUrl: string) => Promise<string | undefined>;

const healthTimeoutMs = 3000;

async function health(bridgeUrl: string): Promise<unknown> {
  let response: Response;
  try { response = await fetch(new URL("/v1/health", bridgeUrl), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(healthTimeoutMs) }); }
  catch {
    throw new EnsoCliError("app_unavailable", "The Enso app bridge at the session's bridgeUrl did not answer, so the session cannot pin its bridge instance", {
      bridgeUrl, hint: "Launch Enso with Local agent access on, then create the session again"
    });
  }
  let parsed;
  try { parsed = envelopeSchema.safeParse(await response.json()); } catch { parsed = undefined; }
  if (!parsed?.success) throw new EnsoCliError("invalid_response", "The bridge returned an invalid /v1/health reply", { bridgeUrl });
  if (!parsed.data.ok) throw new EnsoCliError(parsed.data.error.code, parsed.data.error.message, { ...parsed.data.error.details, bridgeUrl });
  return parsed.data.data;
}

/**
 * The instance a session pins at creation. An app that does not answer, refuses agent access, predates canvas targeting
 * (contract 3), or advertises no instance fails creation: a session's binding never changes, so one created without a
 * pin could never use the bridge.
 */
export const readBridgeInstance: BridgeInstanceReader = async bridgeUrl => {
  const data = await health(bridgeUrl) as { agentAccess?: unknown; contractVersion?: unknown } | undefined;
  if (data?.agentAccess === "disabled") {
    throw new EnsoCliError("access_disabled", "Local agent access is turned off in Enso's Settings", { bridgeUrl, hint: "Turn on Local agent access in Enso's Settings, then create the session again" });
  }
  assertTargetingContract(data?.contractVersion, bridgeUrl);
  const instance = advertisedInstance(data);
  if (instance === undefined) {
    throw new EnsoCliError("bridge_instance_unavailable", "The Enso app at the session's bridgeUrl advertises no bridge instance, so the session cannot pin one", {
      bridgeUrl, hint: "Update Enso to a build whose /v1/health reports bridgeInstanceID, then create the session again"
    });
  }
  return instance;
};

/**
 * The token file the app at `bridgeUrl` names on its health route, then the CLI's stored pairing, each only for that
 * origin. Writes nothing: the runner neither links the CLI nor stores the token. Any failure is no token; the agent's
 * CLI then reports `auth_required`.
 */
export const readBridgeToken: BridgeTokenReader = async bridgeUrl => {
  const origin = new URL(bridgeUrl).origin;
  const sameOrigin = (value: string | undefined) => {
    try { return value !== undefined && isLoopbackBridgeUrl(value) && new URL(value).origin === origin; } catch { return false; }
  };
  try {
    const tokenPath = (await health(origin) as { tokenPath?: unknown } | undefined)?.tokenPath;
    if (typeof tokenPath === "string" && tokenPath) {
      const file = tokenFileSchema.parse(JSON.parse(readFileSync(tokenPath, "utf8")));
      if (file.bridgeUrl === undefined || sameOrigin(file.bridgeUrl)) return file.token;
    }
  } catch { /* fall back to the stored pairing */ }
  const config = readConfig();
  return config && sameOrigin(config.bridgeUrl) ? config.token : undefined;
};

/**
 * The environment of an agent the runner runs for a session. The runner's own binding variables are cleared first. A
 * session with a pinned instance gets its bridge origin, instance, canvas target and (when found) pairing token; any
 * other is marked disabled, and the CLI refuses every bridge request in it.
 */
export function bridgeEnvironment(binding: Readonly<Binding>, token?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of bindingEnvNames) delete env[name];
  if (binding.bridgeInstanceID === undefined) return { ...env, [runnerBridgeEnv]: "disabled" };
  return {
    ...env, [runnerBridgeEnv]: "bound", [bridgeUrlEnv]: binding.bridgeUrl, [bridgeInstanceEnv]: binding.bridgeInstanceID,
    [vaultEnv]: binding.canvasTarget.vaultID, [canvasEnv]: binding.canvasTarget.canvasID,
    ...(token ? { [bridgeTokenEnv]: token } : {})
  };
}
