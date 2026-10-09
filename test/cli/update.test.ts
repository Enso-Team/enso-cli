import { expect, it, vi } from "vitest";
import { cliVersion } from "../../src/version.js";
import { calls, run, setupCliTest } from "../support/cli-harness.js";

setupCliTest();

it("returns the available CLI version as JSON independently of bridge auth", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: "99.0.0" })));
  const result = await run(["update", "--check", "--pretty"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: { installedVersion: cliVersion, latestVersion: "99.0.0", updateAvailable: true, updated: false } });
  expect(calls).toHaveLength(0);
});

it("returns an update check error as a single JSON envelope", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const result = await run(["update", "--check"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "update_check_failed" } });
});
