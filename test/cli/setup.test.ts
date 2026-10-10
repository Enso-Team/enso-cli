import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../../src/config.js";
import { run, setupCliTest, tempDir } from "../support/cli-harness.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
setupCliTest();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => Object.defineProperty(process, "platform", { value: "darwin", configurable: true }));
afterEach(() => Object.defineProperty(process, "platform", platformDescriptor));

describe("agent setup app discovery", () => {
  it("launches the installed Mac app and pairs through its token file", async () => {
    execute.mockReset();
    execute.mockImplementation(async (command: string) => {
      if (command === "open") return { stdout: "", stderr: "" };
      if (command === "npx") return { stdout: JSON.stringify([{ name: "enso", status: "installed", path: "/skills/codex/enso" }]), stderr: "" };
      throw new Error("Manager is unavailable");
    });
    const tokenPath = join(tempDir, "app-token.json");
    writeFileSync(tokenPath, JSON.stringify({ token: "app-token", bridgeUrl: "http://127.0.0.1:17650" }));
    let unavailable = true;
    vi.mocked(fetch).mockImplementation(async () => {
      if (unavailable) { unavailable = false; throw new Error("Connection refused"); }
      return Response.json({ ok: true, data: { contractVersion: 2, tokenPath, agentAccess: "enabled", capabilities: ["mark.update"] } });
    });
    const result = await run(["setup", "--agent", "codex", "--installer", "npm"]);
    expect(result.code).toBe(0);
    expect(execute).toHaveBeenCalledWith("open", ["-a", "Enso"], { timeout: 10000 });
    expect(readConfig()?.token).toBe("app-token");
    expect(JSON.parse(result.stdout).data).toMatchObject({ pairing: "linked", ready: true });
  });

  it("returns an exact missing-app blocker when app launch fails", async () => {
    execute.mockReset();
    execute.mockRejectedValue(new Error("Application not found"));
    vi.mocked(fetch).mockRejectedValue(new Error("Connection refused"));
    const result = await run(["setup", "--agent", "codex"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "app_missing", details: { stage: "app", hint: "Install or launch Enso, then run enso setup" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports the Mac setup requirement before app launch on Linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    execute.mockReset();
    vi.mocked(fetch).mockRejectedValue(new Error("Connection refused"));
    const result = await run(["setup", "--agent", "codex"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "app_launch_required", details: { stage: "app", hint: "Run setup on the Mac that has Enso installed" }
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
