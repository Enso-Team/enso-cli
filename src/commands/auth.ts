import { Command } from "commander";
import { defaultBridgeUrl, readConfig, removeConfig } from "../config.js";
import { BridgeClient } from "../client.js";
import { discoverAndLink } from "../discovery.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";

function formatAuthStatus(data: { status: string; linked: boolean; bridgeUrl: string; linkedAt?: string }): string {
  if (data.status === "unlinked") return "Enso CLI is not linked to the Enso app.";
  if (data.status === "configured") return "Enso CLI credentials are configured, but the Enso app is unavailable.";
  if (data.status === "invalid") return "Enso CLI credentials are invalid.";

  const lines = [
    "Enso CLI is linked to the Enso app.",
    "",
    `Bridge: ${data.bridgeUrl}`
  ];
  if (data.linkedAt) lines.push(`Linked at: ${data.linkedAt}`);
  return lines.join("\n");
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Pair this CLI with the Enso app");

  auth.command("link").action(async (): Promise<EnsoEnvelope> => {
    const existing = readConfig();
    if (existing) {
      try {
        const status = await new BridgeClient(existing.bridgeUrl).request("/v1/status");
        if (status.ok) {
          // A stale stored token relinks inside that request, so the config on
          // disk is the pairing this status came from.
          const current = readConfig() ?? existing;
          const relinked = current.token !== existing.token || current.linkedAt !== existing.linkedAt;
          return {
            ok: true,
            data: {
              status: "linked",
              ...(relinked ? { message: "Enso CLI is linked to the Enso app" } : {}),
              alreadyLinked: !relinked,
              linked: true,
              bridgeUrl: current.bridgeUrl,
              linkedAt: current.linkedAt
            }
          };
        }
      } catch {
        // An unavailable or invalid existing configuration does not block a fresh pairing attempt.
      }
    }
    // The app provisions a token file and names it on /v1/health. Reading it is
    // the whole link.
    const discovered = await discoverAndLink();
    if (!discovered) {
      throw new EnsoCliError("link_failed", "Could not link to the Enso app", {
        hint: "Open the Enso app, turn on Local agent access in its Settings, then run `enso auth link` again"
      });
    }
    return {
      ok: true,
      data: {
        status: "linked",
        message: "Enso CLI is linked to the Enso app",
        alreadyLinked: false,
        linked: true,
        bridgeUrl: discovered.bridgeUrl,
        linkedAt: discovered.linkedAt
      }
    };
  });

  auth.command("status").action(async (): Promise<EnsoEnvelope> => {
    const config = readConfig();
    if (!config) {
      const data = { status: "unlinked", linked: false, bridgeUrl: defaultBridgeUrl };
      return { ok: true, text: formatAuthStatus(data), data };
    }
    let status: "linked" | "configured" | "invalid";
    try {
      const response = await new BridgeClient(config.bridgeUrl).request("/v1/status");
      status = response.ok ? "linked" : "invalid";
    } catch (error) {
      // A stale token the app could not replace through its token file is invalid, not
      // unreachable, and an app that refuses agent access says so itself.
      if (error instanceof EnsoCliError && error.body.code === "access_disabled") throw error;
      status = error instanceof EnsoCliError && error.body.code === "invalid_token" ? "invalid" : "configured";
    }
    const data = {
      status,
      linked: status === "linked",
      bridgeUrl: config.bridgeUrl,
      linkedAt: config.linkedAt
    };
    return {
      ok: true,
      text: formatAuthStatus(data),
      data
    };
  });

  auth.command("unlink").action(async (): Promise<EnsoEnvelope> => {
    removeConfig();
    return {
      ok: true,
      text: "Enso CLI is no longer linked to the Enso app.",
      data: {
        status: "unlinked",
        message: "Enso CLI is no longer linked to the Enso app",
        linked: false
      }
    };
  });
}
