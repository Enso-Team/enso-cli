import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startRunner } from "../../src/runner/service.js";

// What a global install looks like when npm skipped better-sqlite3's install script: the module resolves, its binding does not.
vi.mock("node:module", async original => ({
  ...await original<typeof import("node:module")>(),
  createRequire: () => () => function Database() { throw new Error("Could not locate the bindings file"); }
}));

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "enso-unavailable-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

it("explains a missing native SQLite binding before creating any store file", async () => {
  await expect(startRunner({ directory })).rejects.toMatchObject({ body: {
    code: "runner_storage_unavailable", message: expect.stringContaining("--allow-scripts=better-sqlite3")
  } });
  expect(readdirSync(directory)).toEqual([]);
});
