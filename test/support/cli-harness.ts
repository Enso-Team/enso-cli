import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { writeConfig } from "../../src/config.js";
import { buildProgram, isCommanderInfoExit } from "../../src/index.js";

export type FetchCall = {
  url: string;
  init: RequestInit;
};

export const nativeFetch = globalThis.fetch.bind(globalThis);
export const calls: FetchCall[] = [];
export const bootstrapCalls: FetchCall[] = [];
export const fixtureTarget = { vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222" };

export let tempDir = "";

export function setupCliTest(): void {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "enso-cli-"));
    process.env.ENSO_CLI_CONFIG_DIR = tempDir;
    process.env.ENSO_VAULT_INDEX_ROOT = join(tempDir, "vault-index");
    calls.length = 0;
    bootstrapCalls.length = 0;
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
    delete process.env.ENSO_VAULT_INDEX_ROOT;
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

  // Command payload/output tests share discovery fixtures. targeting.test.ts exercises
  // the complete transport, including discovery, against an HTTP server instead.
  const originalFetch = globalThis.fetch;
  const commandArgs = args.filter(arg => arg !== "--pretty");
  const targeted = ["node", "portal", "link", "primitive", "mark", "excerpt", "context", "search", "layout"].includes(commandArgs[0]) ||
    args[0] === "--pretty" && args[1] === "context" || args[0] === "canvas" && ["fit", "apply", "outline"].includes(args[1]);
  const selector = fixtureSelector(args);
  const canvas = { id: selector, name: selector, ref: `Canvases/${selector}.json`, canvasID: fixtureTarget.canvasID, vaultID: fixtureTarget.vaultID, canvasTarget: fixtureTarget };
  let listed = false;
  if (targeted) globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health" || path === "/v1/canvases/current" || path === "/v1/canvases" && !listed) {
      if (path === "/v1/canvases") listed = true;
      bootstrapCalls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, data: path === "/v1/health" ? { contractVersion: 3 } : path === "/v1/canvases" ? { canvases: [canvas] } : canvas });
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  try {
    try {
      await buildProgram().parseAsync(["node", "enso", ...args], { from: "node" });
    } catch (error) {
      if (!isCommanderInfoExit(error)) throw error;
      process.exitCode = 0;
    }
    return { stdout: stdout.join(""), stderr: stderr.join(""), code: process.exitCode };
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = originalExitCode;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixtureSelector(args: string[]): string {
  const option = args.indexOf("--canvas");
  if (option >= 0) return args[option + 1];
  if (args[0] === "canvas" && ["fit", "outline"].includes(args[1]) && args[2] && !args[2].startsWith("--")) return args[2];
  try {
    const jsonIndex = args.indexOf("--json");
    const source = jsonIndex >= 0 ? args[jsonIndex + 1] : readFileSync(args[0] === "layout" ? args[1] : args[2], "utf8");
    return JSON.parse(source).canvas ?? "current";
  } catch { return "current"; }
}

export function requestBody(call: FetchCall): Record<string, any> {
  const { canvasTarget, ...body } = JSON.parse(String(call.init.body));
  if (canvasTarget !== undefined) expect(canvasTarget).toEqual(fixtureTarget);
  return body;
}

export function requestPath(call: FetchCall): string {
  const url = new URL(call.url);
  if (url.searchParams.has("canvasTarget")) {
    expect(JSON.parse(url.searchParams.get("canvasTarget")!)).toEqual(fixtureTarget);
    url.searchParams.delete("canvasTarget");
  }
  const query = [...url.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return url.pathname + (query ? `?${query}` : "");
}
