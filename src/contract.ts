import { EnsoCliError } from "./errors.js";

// Every bridge request speaks contract 3, which requires an explicit canvasTarget on canvas-scoped routes.
export const contractVersion = 3;
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
  if (app < contractVersion) {
    throw new EnsoCliError("app_outdated", `This CLI requires Enso bridge contract ${contractVersion}; the app speaks contract ${app}`, {
      ...details,
      hint: "Update the Enso app, then retry. This CLI never runs canvas commands on an implicit active canvas"
    });
  }
}
