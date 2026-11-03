import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

let child: ChildProcess | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
  child = undefined; directory = undefined;
});
function start(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, ENSO_CLI_NO_UPDATE_CHECK: "1" };
  delete env.ENSO_VAULT_ID; delete env.ENSO_CANVAS_ID;
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
}
async function command(args: string[]) {
  const process = start(args);
  let stdout = "", stderr = "";
  process.stdout!.on("data", chunk => { stdout += chunk; });
  process.stderr!.on("data", chunk => { stderr += chunk; });
  const [code] = await once(process, "exit");
  return { code, stdout, stderr };
}
it("runs the standalone CLI service without an app and gracefully shuts down", async () => {
  directory = mkdtempSync(join(tmpdir(), "enso-cli-runner-"));
  child = start(["runner", "serve", "--provider", "fake", "--directory", directory]);
  let output = "", errors = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { errors += chunk; });
  await new Promise<void>((resolve, reject) => {
    child!.stdout!.once("data", () => resolve());
    child!.once("exit", () => reject(new Error(errors)));
  });
  expect(JSON.parse(output).data).toMatchObject({ ready: true, protocolVersion: 1 });
  const created = await command(["runner", "call", "POST", "/v1/sessions", "--directory", directory, "--json", JSON.stringify({ binding: {
    bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
      vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
    }, workingDirectory: directory
  } })]);
  expect(created.code).toBe(0);
  const s = JSON.parse(created.stdout).data;
  expect(s.binding.workingDirectory).toBe(realpathSync(directory));
  const submitted = await command(["runner", "call", "POST", "/v1/prompts", "--directory", directory, "--json", JSON.stringify({
    requestID: "cli-turn", sessionID: s.id, text: "CLI test", context: { selectedNodes: [] }, fake: { scenario: "input", delayMs: 0 }
  })]);
  expect(submitted.code).toBe(0);
  const result = await command(["runner", "call", "GET", "/v1/runs/cli-turn", "--directory", directory]);
  expect(JSON.parse(result.stdout).data.status).toBe("waiting_input");
  const exited = once(child, "exit");
  const stopped = await command(["runner", "shutdown", "--directory", directory]);
  expect(stopped.code).toBe(0);
  expect(JSON.parse(stopped.stdout).data).toEqual({ stopped: true });
  const [code] = await exited;
  expect(code).toBe(0);
  expect(errors).toBe("");
  expect(output).not.toContain('"token"');
  expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).runs[0].status).toBe("cancelled");
}, 15_000);

it("rejects unsupported providers with a structured CLI error", async () => {
  const result = await command(["runner", "serve", "--provider", "claude"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
});
