import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The Mac app keeps each Vault's Note identities in `Vaults/<vaultID>/index.json` inside its
// sandbox container. The CLI reads it to learn a Note's id. The app owns the file, so the CLI
// never writes it.

type IndexEntry = { path?: unknown; kind?: unknown; uuid?: unknown };
type VaultIndex = { vaultRootPath?: unknown; entries?: unknown };

export function defaultVaultIndexRoot(): string {
  return process.env.ENSO_VAULT_INDEX_ROOT
    ?? join(homedir(), "Library/Containers/com.kaungzinye.enso/Data/Library/Application Support/Enso/Vaults");
}

function readIndex(file: string): VaultIndex | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as VaultIndex;
  } catch {
    return undefined;
  }
}

/**
 * The id the app's index records for the Note at `notePath`, relative to `vaultRoot`. When
 * several indexes name the same Vault root, the most recently written one wins.
 */
export function indexedNoteID(vaultRoot: string, notePath: string, indexRoot = defaultVaultIndexRoot()): string | undefined {
  let folders: string[];
  try {
    folders = readdirSync(indexRoot);
  } catch {
    return undefined;
  }
  const root = resolve(vaultRoot);
  const indexes = folders
    .map(folder => join(indexRoot, folder, "index.json"))
    .flatMap(file => {
      const modified = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
      return modified === undefined ? [] : [{ file, modified }];
    })
    .sort((a, b) => b.modified - a.modified);
  for (const { file } of indexes) {
    const index = readIndex(file);
    if (typeof index?.vaultRootPath !== "string" || resolve(index.vaultRootPath) !== root || !Array.isArray(index.entries)) continue;
    const entry = (index.entries as IndexEntry[]).find(item => item.kind === "note" && item.path === notePath);
    if (typeof entry?.uuid === "string") return entry.uuid;
  }
  return undefined;
}
