import type { CanvasSpec } from "./canvas-spec.js";
import { BridgeClient } from "./client.js";
import type { EnsoEnvelope } from "./errors.js";

export type VaultResolution =
  | { members: CanvasSpec["members"]; reused: string[]; stubs: string[] }
  | { envelope: EnsoEnvelope };

/**
 * A graph that names its members by title says nothing about which of them the vault
 * already holds. Two surfaces answer that. The vault tree is the complete listing, so a
 * title it misses is genuinely absent rather than ranked off a page of search results;
 * search covers the same ground the apply preflight covers. A title either surface holds
 * is placed as that Note, and only a title both miss becomes a stub for the agent to fill.
 * A vault tree the app refuses to return stops the compile, because guessing here costs a
 * duplicate Note.
 */
export async function resolveAgainstVault(spec: CanvasSpec): Promise<VaultResolution> {
  const client = new BridgeClient();
  const tree = await client.request("/v1/vault/tree");
  if (!tree.ok) return { envelope: tree };
  const listed = new Set(vaultNoteTitles(tree.data));
  const titles = spec.members.map((member) => member.title);
  const unlisted = titles.filter((title) => !listed.has(title));
  const searches = await Promise.all(unlisted.map((title) => client.request("/v1/search", { query: { q: title } })));
  const found = new Set(listed);
  for (const [index, search] of searches.entries()) {
    if (!search.ok) return { envelope: search };
    if (noteNames(search.data).includes(unlisted[index])) found.add(unlisted[index]);
  }
  const reused: string[] = [];
  const stubs: string[] = [];
  const members: CanvasSpec["members"] = titles.map((title) => {
    const exists = found.has(title);
    (exists ? reused : stubs).push(title);
    return { title, mode: exists ? "reuse" : "create" };
  });
  return { members, reused, stubs };
}

const TITLE_KEYS = new Set(["path", "name", "title", "file"]);

/** Every Note title the vault tree lists, whatever shape the app nests them in. */
export function vaultNoteTitles(data: unknown): string[] {
  const titles: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") {
        if (TITLE_KEYS.has(key) && /\.md$/i.test(item)) titles.push(item.split("/").pop()!.replace(/\.md$/i, ""));
        continue;
      }
      visit(item);
    }
  };
  visit(data);
  return titles;
}

/** Every name a search result offers for the Note behind it. */
export function noteNames(data: unknown): string[] {
  if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) return [];
  const names: string[] = [];
  for (const result of (data as { results: unknown[] }).results) {
    if (!result || typeof result !== "object") continue;
    const item = result as { path?: unknown; node?: unknown };
    if (typeof item.path === "string") {
      names.push(item.path);
      const filename = item.path.split("/").pop();
      if (filename) names.push(filename.replace(/\.md$/i, ""));
    }
    if (item.node && typeof item.node === "object") {
      const node = item.node as { title?: unknown; displayTitle?: unknown; ref?: unknown };
      for (const value of [node.title, node.displayTitle, node.ref]) if (typeof value === "string") names.push(value);
    }
  }
  return names;
}
