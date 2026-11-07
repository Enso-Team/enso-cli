import { readFileSync } from "node:fs";
import { z } from "zod/v3";
import { assertBridgeAllowed, envelopeSchema, isLoopbackBridgeUrl } from "./client.js";
import { assertExpectedBridgeInstance, bridgeInstanceHeader, expectedBridgeInstance } from "./bridge-binding.js";
import { writeConfig, type EnsoConfig } from "./config.js";
import { assertCompatibleContract } from "./contract.js";
import { EnsoCliError } from "./errors.js";

export const tokenFileSchema = z.object({
  token: z.string().min(1),
  bridgeUrl: z.string().url().optional()
});

// The app writes its bridge token to a file inside its own container and names
// the path on /v1/health, which needs no auth. Linking is reading that file and
// verifying the token against /v1/status. The per-user container is the trust
// boundary, so there is no prompt and no callback server.
// With `stay`, a candidate links only to itself: a token file or health payload
// that names another origin is not followed. The heal in the client uses it so a
// stale pairing is replaced on the same app and never moves on its own.
export async function discoverAndLink(
  candidates: string[] = candidateBridgeUrls(),
  { stay = false }: { stay?: boolean } = {}
): Promise<EnsoConfig | null> {
  assertBridgeAllowed();
  const instance = expectedBridgeInstance();
  for (const bridgeUrl of candidates) {
    if (!isLoopbackBridgeUrl(bridgeUrl)) continue;
    const config = await tryLink(bridgeUrl, stay, instance);
    if (config) return config;
  }
  return null;
}

function candidateBridgeUrls(): string[] {
  const urls: string[] = [];
  const explicit = process.env.ENSO_BRIDGE_URL;
  if (explicit && isLoopbackBridgeUrl(explicit)) urls.push(explicit);
  for (const url of ["http://127.0.0.1:17650", "http://127.0.0.1:17651"]) {
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

async function tryLink(bridgeUrl: string, stay: boolean, instance: string | undefined): Promise<EnsoConfig | null> {
  const health = await fetchEnvelope(new URL("/v1/health", bridgeUrl), undefined, instance);
  const data =
    health?.ok === true
      ? (health.data as { tokenPath?: unknown; agentAccess?: unknown; bridgeUrl?: unknown; contractVersion?: unknown })
      : undefined;
  if (health?.ok === true) assertExpectedBridgeInstance(data, bridgeUrl, instance);
  if (data) assertCompatibleContract(data.contractVersion, bridgeUrl);
  if (data?.agentAccess === "disabled") {
    throw new EnsoCliError("access_disabled", "Local agent access is turned off in Enso's Settings", {
      bridgeUrl,
      hint: "Turn on Local agent access in Enso's Settings, then retry"
    });
  }
  const tokenPath = data?.tokenPath;
  if (typeof tokenPath !== "string" || tokenPath.length === 0) return null;

  let tokenFile: z.infer<typeof tokenFileSchema>;
  try {
    tokenFile = tokenFileSchema.parse(JSON.parse(readFileSync(tokenPath, "utf8")));
  } catch {
    return null;
  }

  const discoveredBridgeUrl =
    typeof tokenFile.bridgeUrl === "string" && isLoopbackBridgeUrl(tokenFile.bridgeUrl)
      ? tokenFile.bridgeUrl
      : typeof data?.bridgeUrl === "string" && isLoopbackBridgeUrl(data.bridgeUrl)
        ? data.bridgeUrl
        : bridgeUrl;
  if (stay && new URL(discoveredBridgeUrl).origin !== new URL(bridgeUrl).origin) return null;

  // A token file may name another bridge origin. Check that destination too before sending it any credentials.
  if (instance !== undefined && new URL(discoveredBridgeUrl).origin !== new URL(bridgeUrl).origin) {
    const destination = await fetchEnvelope(new URL("/v1/health", discoveredBridgeUrl), undefined, instance);
    if (destination?.ok !== true) return null;
    assertExpectedBridgeInstance(destination.data, discoveredBridgeUrl, instance);
  }
  const status = await fetchEnvelope(new URL("/v1/status", discoveredBridgeUrl), tokenFile.token, instance);
  if (status?.ok !== true) return null;

  const config: EnsoConfig = {
    bridgeUrl: discoveredBridgeUrl,
    token: tokenFile.token,
    linkedAt: new Date().toISOString()
  };
  writeConfig(config);
  return config;
}

async function fetchEnvelope(url: URL, token?: string, instance?: string): Promise<{ ok?: unknown; data?: unknown } | null> {
  let envelope: { ok?: unknown; data?: unknown };
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (instance !== undefined) headers[bridgeInstanceHeader] = instance;
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers });
    envelope = (await response.json()) as { ok?: unknown; data?: unknown };
  } catch {
    return null;
  }
  // In particular, do not hide a mismatch if the app restarts between the health check and token verification.
  if (instance !== undefined) {
    const parsed = envelopeSchema.safeParse(envelope);
    if (parsed.success && !parsed.data.ok) {
      throw new EnsoCliError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
    }
  }
  return envelope;
}
