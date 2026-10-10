import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

import { isNewerVersion, latestVersion, notifyUpdate, updateCli } from "../src/update.js";
import { cliVersion } from "../src/version.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync), lstatSync: vi.fn(actual.lstatSync), readFileSync: vi.fn(actual.readFileSync) };
});
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
function setTTY(stream: NodeJS.WriteStream, value: boolean): void {
  Object.defineProperty(stream, "isTTY", { configurable: true, value });
}

let directory: string;
const nextVersion = "99.0.0";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "enso-update-"));
  vi.stubEnv("ENSO_CLI_CONFIG_DIR", directory);
  vi.stubEnv("CI", "");
  vi.stubEnv("ENSO_CLI_NO_UPDATE_CHECK", "");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: nextVersion })));
  execute.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, descriptor] of [[process.stdout, stdoutTTY], [process.stderr, stderrTTY]] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function terminal(): ReturnType<typeof vi.spyOn> {
  setTTY(process.stdout, true);
  setTTY(process.stderr, true);
  return vi.spyOn(process.stderr, "write").mockReturnValue(true);
}

describe("release versions", () => {
  it.each([
    ["0.8.2", "0.8.1", true], ["0.10.0", "0.9.9", true], ["1.0.0", "0.99.99", true],
    ["0.8.1", "0.8.1", false], ["0.8.1", "0.9.0", false], ["1.0.0-beta.1", "0.8.1", false],
    ["1.0.0", "1.0.0-beta.1", false], ["garbage", "0.8.1", false]
  ])("compares %s with %s", (latest, installed, expected) => {
    expect(isNewerVersion(latest, installed)).toBe(expected);
  });

  it("reports check failures for registry errors and malformed versions", async () => {
    for (const response of [new Response("busy", { status: 503 }), Response.json({ version: "bad" })]) {
      vi.mocked(fetch).mockResolvedValueOnce(response);
      await expect(latestVersion()).rejects.toMatchObject({ body: { code: "update_check_failed" } });
    }
  });
});

describe("notifications", () => {
  it("caches a successful lookup for a day and writes the notice to stderr", async () => {
    const write = terminal();
    await notifyUpdate();
    await notifyUpdate();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Run `enso update`"));
    expect(JSON.parse(fs.readFileSync(join(directory, "update-check.json"), "utf8")).latest).toBe(nextVersion);
  });

  it("rechecks stale cache entries", async () => {
    terminal();
    writeFileSync(join(directory, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 86400001, latest: cliVersion }));
    await notifyUpdate();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps network failures quiet and throttles retries", async () => {
    const write = terminal();
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await notifyUpdate();
    await notifyUpdate();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps piped output, CI, and opted-out invocations free of registry requests", async () => {
    terminal();
    setTTY(process.stdout, false);
    await notifyUpdate();
    setTTY(process.stdout, true);
    vi.stubEnv("CI", "true");
    await notifyUpdate();
    vi.stubEnv("CI", "");
    vi.stubEnv("ENSO_CLI_NO_UPDATE_CHECK", "1");
    await notifyUpdate();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("installation", () => {
  it("reports the owning update action during a version check", async () => {
    const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
    execute.mockResolvedValue({ stdout: `${directory}\n` });
    vi.spyOn(fs, "realpathSync").mockReturnValue(packageDirectory);
    vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
    expect(await updateCli(true)).toMatchObject({ updated: false, installation: { owner: "npm", automatic: true, updateCommand: "npm install -g @enso-app/cli@latest" } });
    expect(execute.mock.calls.some(([, args]) => args[0] === "install")).toBe(false);
  });
  it("updates a Bun-owned global package through Bun", async () => {
    const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
    execute.mockImplementation(async (binary, args) => {
      if (binary === "npm") throw new Error("npm unavailable");
      return { stdout: args[0] === "pm" ? "/bun/bin\n" : "" };
    });
    vi.spyOn(fs, "realpathSync").mockImplementation(path => String(path) === "/bun/bin/enso" ? "/bun/global/node_modules/@enso-app/cli/dist/index.js" : String(path) === packageDirectory ? "/bun/global/node_modules/@enso-app/cli" : String(path));
    vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ version: nextVersion }));
    expect(await updateCli(false)).toMatchObject({ updated: true, installation: { owner: "bun", automatic: true } });
    expect(execute).toHaveBeenLastCalledWith("bun", ["add", "--global", `@enso-app/cli@${nextVersion}`, "--registry", "https://registry.npmjs.org"], expect.objectContaining({ timeout: 120000 }));
  });
  it("checks versions independently of the Enso app", async () => {
    expect(await updateCli(true)).toMatchObject({ installedVersion: cliVersion, latestVersion: nextVersion, updateAvailable: true, updated: false });
    expect(execute.mock.calls.some(([, args]) => args[0] === "install" || args[0] === "add")).toBe(false);
  });

  it("keeps a current or higher installed version", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ version: "0.0.1" }));
    expect(await updateCli(false)).toMatchObject({ updated: false, updateAvailable: false });
    expect(execute.mock.calls.some(([, args]) => args[0] === "install" || args[0] === "add")).toBe(false);
  });

  it("asks project and linked installations to use their owning package manager", async () => {
    execute.mockResolvedValue({ stdout: `${directory}\n` });
    const realpath = vi.spyOn(fs, "realpathSync");
    realpath.mockReturnValueOnce(directory).mockReturnValueOnce("/project");
    await expect(updateCli(false)).rejects.toMatchObject({ body: { code: "update_install_location" } });
    expect(execute.mock.calls.some(([, args]) => args[0] === "install" || args[0] === "add")).toBe(false);
  });

  it("keeps npm-linked development checkouts intact", async () => {
    execute.mockResolvedValue({ stdout: `${directory}\n` });
    vi.spyOn(fs, "realpathSync").mockReturnValue(directory);
    vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => true } as fs.Stats);
    await expect(updateCli(false)).rejects.toMatchObject({ body: { code: "update_install_location" } });
    expect(execute.mock.calls.some(([, args]) => args[0] === "install" || args[0] === "add")).toBe(false);
  });

  it("installs the exact checked version and verifies its package manifest", async () => {
    const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
    execute.mockResolvedValue({ stdout: `${directory}\n` });
    vi.spyOn(fs, "realpathSync").mockReturnValue(packageDirectory);
    vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ version: nextVersion }));
    expect(await updateCli(false)).toMatchObject({ installedVersion: nextVersion, updated: true });
    expect(execute).toHaveBeenLastCalledWith("npm", ["install", "--global", `@enso-app/cli@${nextVersion}`, "--registry", "https://registry.npmjs.org", "--engine-strict"], expect.objectContaining({ timeout: 120000 }));
  });

  it("reports npm failures with an actionable command", async () => {
    const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
    execute.mockResolvedValueOnce({ stdout: `${directory}\n` }).mockRejectedValue(new Error("EACCES"));
    vi.spyOn(fs, "realpathSync").mockReturnValue(packageDirectory);
    vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
    await expect(updateCli(false)).rejects.toMatchObject({ body: { code: "update_failed", details: { hint: expect.stringContaining("npm install -g") } } });
  });
});
