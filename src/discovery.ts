import { readFileSync } from "node:fs";
import { z } from "zod";
import { isLoopbackBridgeUrl } from "./client.js";
import { writeConfig, type EnsoConfig } from "./config.js";
import { EnsoCliError } from "./errors.js";

const tokenFileSchema = z.object({
  token: z.string().min(1),
  bridgeUrl: z.string().url().optional()
});

// The app writes its bridge token to a file inside its own container and names
// the path on /v1/health, which needs no auth. Linking is reading that file and
// verifying the token against /v1/status. The per-user container is the trust
// boundary, so there is no prompt and no callback server.
export async function discoverAndLink(): Promise<EnsoConfig | null> {
  for (const bridgeUrl of candidateBridgeUrls()) {
    const config = await tryLink(bridgeUrl);
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

async function tryLink(bridgeUrl: string): Promise<EnsoConfig | null> {
  const health = await fetchEnvelope(new URL("/v1/health", bridgeUrl));
  const data =
    health?.ok === true
      ? (health.data as { tokenPath?: unknown; agentAccess?: unknown; bridgeUrl?: unknown })
      : undefined;
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

  const status = await fetchEnvelope(new URL("/v1/status", discoveredBridgeUrl), tokenFile.token);
  if (status?.ok !== true) return null;

  const config: EnsoConfig = {
    bridgeUrl: discoveredBridgeUrl,
    token: tokenFile.token,
    linkedAt: new Date().toISOString()
  };
  writeConfig(config);
  return config;
}

async function fetchEnvelope(url: URL, token?: string): Promise<{ ok?: unknown; data?: unknown } | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers });
    return (await response.json()) as { ok?: unknown; data?: unknown };
  } catch {
    return null;
  }
}
