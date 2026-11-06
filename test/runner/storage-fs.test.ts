import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Fails the next call of the named fs function with `code`; the module is mocked so storage sees the fault. */
const faults = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const faulty = <K extends "readdirSync" | "openSync">(name: K) => ((...args: unknown[]) => {
    const code = faults.get(name);
    if (code) { faults.delete(name); throw Object.assign(new Error(`${code}: injected`), { code }); }
    return (fs[name] as (...args: unknown[]) => unknown)(...args);
  }) as typeof fs[K];
  return { ...fs, readdirSync: faulty("readdirSync"), openSync: faulty("openSync") };
});

const { startRunner } = await import("../../src/runner/service.js");

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "enso-storage-fs-")); });
afterEach(() => { faults.clear(); rmSync(directory, { recursive: true, force: true }); });

describe("runner storage file system failures", () => {
  it.each([
    ["readdirSync", "EIO"],
    ["openSync", "EROFS"],
    ["openSync", "ENOSPC"]
  ])("reports %s failing with %s as a storage failure, not invalid input", async (name, code) => {
    faults.set(name, code);
    await expect(startRunner({ directory })).rejects.toMatchObject({ body: {
      code: "runner_storage_failure", details: { cause: { code } }
    } });
    expect(() => lstatSync(join(directory, "owner"))).toThrow();
  });
});
