import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliVersion } from "../../src/version.js";
import { calls, run, setupCliTest } from "../support/cli-harness.js";

setupCliTest();

const manifestVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

describe("version", () => {
  it("reads the version from the package manifest", () => {
    expect(cliVersion).toBe(manifestVersion);
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  for (const flag of ["--version", "-v"]) {
    it(`prints the manifest version for ${flag} without contacting the bridge`, async () => {
      const result = await run([flag]);
      expect(result.stdout.trim()).toBe(manifestVersion);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(calls).toHaveLength(0);
    });
  }
});
