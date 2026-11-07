import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configPath, writeConfig } from "../../src/config.js";
import { readBridgeInstance, readBridgeToken } from "../../src/runner/bridge.js";

let server: Server;
let directory: string;
let bridgeUrl: string;
let health: Record<string, unknown>;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "enso-runner-pairing-"));
  vi.stubEnv("ENSO_CLI_CONFIG_DIR", directory);
  health = {};
  server = createServer((_, response) => { response.end(JSON.stringify({ ok: true, data: health })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  bridgeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

it("reads a session's pairing token from the token file its app names, for that app's origin only, and writes nothing", async () => {
  const tokenPath = join(directory, "token.json");
  health = { contractVersion: 3, tokenPath };
  writeFileSync(tokenPath, JSON.stringify({ token: "file-token", bridgeUrl }));
  expect(await readBridgeToken(`${bridgeUrl}/`)).toBe("file-token");
  expect(existsSync(configPath())).toBe(false);
  // A token file for another origin is not this bridge's pairing; the CLI's stored pairing is, when it names this origin.
  writeFileSync(tokenPath, JSON.stringify({ token: "other-app", bridgeUrl: "http://127.0.0.1:17651" }));
  expect(await readBridgeToken(bridgeUrl)).toBeUndefined();
  writeConfig({ bridgeUrl, token: "stored-token" });
  expect(await readBridgeToken(bridgeUrl)).toBe("stored-token");
  writeConfig({ bridgeUrl: "http://127.0.0.1:17651", token: "stored-for-another" });
  expect(await readBridgeToken(bridgeUrl)).toBeUndefined();
});

it("finds no token, rather than failing the turn, when the bridge does not answer", async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  writeConfig({ bridgeUrl, token: "stored-token" });
  expect(await readBridgeToken(bridgeUrl)).toBe("stored-token");
  rmSync(configPath());
  expect(await readBridgeToken(bridgeUrl)).toBeUndefined();
  await expect(readBridgeInstance(bridgeUrl)).rejects.toMatchObject({ body: { code: "app_unavailable", details: { bridgeUrl } } });
  server = createServer(); server.listen(0, "127.0.0.1");
});

it("pins only an instance ID that is safe to send back as a header", async () => {
  health = { contractVersion: 3, bridgeInstanceID: "bad id\r\nX-Injected: 1" };
  await expect(readBridgeInstance(bridgeUrl)).rejects.toMatchObject({ body: { code: "bridge_instance_unavailable" } });
  health = { contractVersion: 3, bridgeInstanceID: "8E1C1F0A-5B9E-4F7C-9C1D-2A3B4C5D6E7F" };
  expect(await readBridgeInstance(bridgeUrl)).toBe("8E1C1F0A-5B9E-4F7C-9C1D-2A3B4C5D6E7F");
});
