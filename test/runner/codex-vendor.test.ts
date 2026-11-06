import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vendor = join(root, "src/vendor/effect-codex-app-server");
type Manifest = { revision: string; license: { file: string; blob: string }; files: Record<string, { source: string; blob: string }>; patches: unknown[]; runtime: { effect: string } };
const manifest = JSON.parse(readFileSync(join(vendor, "vendor.json"), "utf8")) as Manifest;
/** The git blob hash, which `git rev-parse <revision>:<source>` in agent-host prints for the original. */
const blob = (path: string) => {
  const content = readFileSync(path);
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
};
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [relative(vendor, join(directory, entry.name))]);

it("keeps every vendored file byte-for-byte as the manifest's upstream revision has it", () => {
  for (const [file, { blob: expected }] of Object.entries(manifest.files)) expect(blob(join(vendor, file)), file).toBe(expected);
  expect(blob(join(vendor, manifest.license.file))).toBe(manifest.license.blob);
  expect(manifest.patches).toEqual([]);
});

it("holds only the manifest's files, its license and its records", () => {
  expect(walk(vendor).sort()).toEqual([...Object.keys(manifest.files), manifest.license.file, "VENDOR.md", "vendor.json"].sort());
});

it("pins the Effect version upstream builds the vendored client with", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { devDependencies: Record<string, string>; dependencies: Record<string, string> };
  expect(pkg.devDependencies.effect).toBe(manifest.runtime.effect);
  // Bundled into the Codex chunk rather than installed with the CLI.
  expect(pkg.dependencies.effect).toBeUndefined();
  expect(JSON.parse(readFileSync(join(root, "node_modules/effect/package.json"), "utf8")).version).toBe(manifest.runtime.effect);
});

it("names the same revision everywhere the vendored code and its derived files cite it", () => {
  for (const file of ["THIRD_PARTY_NOTICES.md", "src/vendor/effect-codex-app-server/VENDOR.md", "test/runner/replay/codex.ts", "test/runner/fixtures/agent-host/codex/README.md"]) {
    expect(readFileSync(join(root, file), "utf8"), file).toContain(manifest.revision);
  }
});
