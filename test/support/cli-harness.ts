import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { writeConfig } from "../../src/config.js";
import { buildProgram, isCommanderInfoExit } from "../../src/index.js";

export type FetchCall = {
  url: string;
  init: RequestInit;
};

export const nativeFetch = globalThis.fetch.bind(globalThis);
export const calls: FetchCall[] = [];
export let tempDir = "";

export function setupCliTest(): void {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "enso-cli-"));
    process.env.ENSO_CLI_CONFIG_DIR = tempDir;
    process.env.ENSO_CLI_OPEN = "0";
    calls.length = 0;
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({ ok: true, data: { url: String(url), method: init?.method ?? "GET" } });
      })
    );
    writeConfig({ bridgeUrl: "http://127.0.0.1:17650", token: "test-token" });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ENSO_CLI_CONFIG_DIR;
    delete process.env.ENSO_CLI_OPEN;
    delete process.env.ENSO_CLI_PAIRING_URL_FILE;
    delete process.env.ENSO_CLI_PAIRING_LOCK_STALE_MS;
    delete process.env.ENSO_CLI_SKILL_INSTALLER_BIN;
    delete process.env.MOCK_NPX_ARGS_FILE;
    vi.unstubAllGlobals();
  });
}

export async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    try {
      await buildProgram().parseAsync(["node", "enso", ...args], { from: "node" });
    } catch (error) {
      if (!isCommanderInfoExit(error)) throw error;
      process.exitCode = 0;
    }
    return { stdout: stdout.join(""), stderr: stderr.join(""), code: process.exitCode };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = originalExitCode;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
