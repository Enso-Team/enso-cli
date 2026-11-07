import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { run, setupCliTest, tempDir } from "../support/cli-harness.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});

setupCliTest();

it("adopts a vault folder another process makes between the check and mkdir", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.mkdirSync).mockImplementationOnce((path) => {
    actual.mkdirSync(path);
    throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
  });
  vi.mocked(fetch).mockResolvedValue(Response.json({ ok: false, error: { code: "vault_name_taken", message: "A vault named Research exists", details: {} } }));
  const folder = join(tempDir, "Research");
  const result = await run(["vault", "create", folder]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error.code).toBe("vault_name_taken");
  // Adopted, not created, so the refusal leaves it in place.
  expect(fs.statSync(folder).isDirectory()).toBe(true);
});
