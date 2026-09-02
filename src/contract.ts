import { EnsoCliError } from "./errors.js";

// The bridge contract is one integer that both sides name. It moves only when
// a change breaks the other side, so an additive field leaves it alone.
//
// 1: prompt-and-callback pairing, the 1.3.1 app.
// 2: the app provisions a token file and names it on /v1/health.
//
// /v1/health reports the app's number, checked at link time. Every request
// carries this CLI's number in the header, and the app refuses one outside the
// range it serves, naming which side to update.
export const contractVersion = 2;
export const oldestSupportedContractVersion = 1;
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
