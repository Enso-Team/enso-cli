import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunner, type RunnerService } from "../../src/runner/service.js";

let directory: string;
let service: RunnerService | undefined;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "enso-durability-")); });
afterEach(async () => { await service?.stop(); service = undefined; rmSync(directory, { recursive: true, force: true }); });

describe("commit durability", () => {
  it("keeps the database and its WAL private and persistently in WAL mode", async () => {
    service = await startRunner({ directory });
    service.engine.createSession({ binding: { bridgeUrl: "http://127.0.0.1:17650", workingDirectory: directory, canvasTarget: {
      vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
    } } });
    for (const name of ["runner.sqlite", "runner.sqlite-wal", "runner.sqlite-shm"]) expect(statSync(join(directory, name)).mode & 0o777, name).toBe(0o600);
    const reader = new Database(join(directory, "runner.sqlite"), { readonly: true });
    try { expect(reader.pragma("journal_mode", { simple: true })).toBe("wal"); } finally { reader.close(); }
  });

  const compiler = process.platform === "darwin" && spawnSync("cc", ["--version"]).status === 0;
  // Counts the F_FULLFSYNC calls a real runner process makes. Each commit must issue at least one: plain fsync (or
  // synchronous=NORMAL, which syncs only at checkpoints) leaves acknowledged commits in the drive's volatile cache.
  it.runIf(compiler)("issues F_FULLFSYNC for every commit on macOS", () => {
    const library = join(directory, "fullfsync-count.dylib");
    execFileSync("cc", ["-dynamiclib", "-o", library, "test/runner/fixtures/fullfsync-count.c"]);
    const fullfsyncs = (commits: number) => {
      const store = mkdtempSync(join(directory, "store-"));
      const child = spawnSync(process.execPath, ["--import", "tsx", "test/runner/durability-child.ts", store, String(commits)], {
        env: { ...process.env, DYLD_INSERT_LIBRARIES: library }, encoding: "utf8"
      });
      expect(child.status, child.stderr).toBe(0);
      const counted = /F_FULLFSYNC=(\d+)/.exec(child.stderr);
      expect(counted, "interposer did not load").not.toBeNull();
      return Number(counted![1]);
    };
    const baseline = fullfsyncs(0);
    expect(fullfsyncs(25) - baseline).toBeGreaterThanOrEqual(25);
  }, 30_000);
});
