import { EnsoCliError } from "./errors.js";

// Contract 3 requires explicit canvasTarget on every canvas-scoped request.
// Discovery and noncanvas routes retain contract 2 for inspection and upgrade guidance.
export const contractVersion = 3;
export const oldestSupportedContractVersion = 2;
export const contractHeader = "Enso-Contract-Version";

// An app whose health names no contract predates the field, which is contract 1.
export function assertCompatibleContract(reported: unknown, bridgeUrl: string): void {
  const app = typeof reported === "number" && Number.isInteger(reported) ? reported : 1;
  const details = { bridgeUrl, appContractVersion: app, cliContractVersion: contractVersion };
  if (app > contractVersion) {
    throw new EnsoCliError("cli_outdated", "The Enso app speaks a newer bridge contract than this CLI", {
      ...details,
      hint: "Update the CLI: npm install -g @enso-app/cli@latest"
    });
  }
  if (app < oldestSupportedContractVersion) {
    throw new EnsoCliError("app_outdated", "The Enso app speaks an older bridge contract than this CLI serves", {
      ...details,
      hint: "Update the Enso app"
    });
  }
}

export function assertTargetingContract(reported: unknown, bridgeUrl: string): void {
  assertCompatibleContract(reported, bridgeUrl);
  if (typeof reported !== "number" || reported < contractVersion) {
    throw new EnsoCliError("app_outdated", "Canvas targeting requires Enso bridge contract 3", {
      bridgeUrl, appContractVersion: reported, cliContractVersion: contractVersion,
      hint: "Update Enso to a build containing bridge contract 3, then retry. Implicit active-canvas execution is disabled."
    });
  }
}
