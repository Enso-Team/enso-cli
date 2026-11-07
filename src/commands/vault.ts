import { Command } from "commander";
import { mkdirSync, rmdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { BridgeClient } from "../client.js";
import { EnsoCliError, isMissingRoute, type EnsoEnvelope } from "../errors.js";

type CreateOptions = { name?: string; sync?: boolean; team?: string; dryRun?: boolean };

export function registerVault(program: Command): void {
  const vault = program.command("vault").description("Create, open, and inspect Enso vaults");

  vault.command("current").action(async () => new BridgeClient().request("/v1/vault/current"));
  vault.command("tree").action(async () => new BridgeClient().request("/v1/vault/tree"));
  vault.command("open")
    .argument("<path>", "folder to open as a vault")
    .option("--dry-run", "validate folder access without switching vaults")
    .action(async (path: string, options: { dryRun?: boolean }) => {
      const folder = resolveVaultPath(path);
      if (!statPath(folder)?.isDirectory()) throw new EnsoCliError("invalid_input", "Vault path must be an existing folder", { path: folder });
      return new BridgeClient().request("/v1/vault/open", {
        method: "POST", body: { path: folder, dryRun: Boolean(options.dryRun) }, dryRun: Boolean(options.dryRun)
      });
    });
  vault.command("create")
    .argument("<path>", "folder to create as a vault, or an existing folder to adopt")
    .option("--name <name>", "vault name")
    .option("--sync", "sync the vault through Enso")
    .option("--team <id>", "team that owns the synced vault; requires --sync")
    .option("--dry-run", "validate the request without creating the folder or the vault")
    .action(async (path: string, options: CreateOptions) => {
      const folder = resolveVaultPath(path);
      const dryRun = Boolean(options.dryRun);
      if (options.team !== undefined && !options.sync) {
        throw new EnsoCliError("invalid_input", "--team requires --sync", { team: options.team });
      }
      const created = prepareVaultFolder(folder, dryRun);
      try {
        const envelope = await new BridgeClient().request("/v1/vault/create", {
          method: "POST",
          body: { path: folder, name: options.name, sync: Boolean(options.sync), team: options.team, dryRun },
          dryRun
        }).then(requireVaultCreateSupport);
        if (!envelope.ok && created) removeEmptyFolder(folder);
        return envelope;
      } catch (error) {
        if (created) removeEmptyFolder(folder);
        throw error;
      }
    });
}

function resolveVaultPath(path: string): string {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
}

/** A missing path is undefined; one the CLI may not read is folder_access_denied. */
function statPath(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw folderError(error, path, "Could not read the vault path");
  }
}

function folderError(error: unknown, path: string, message: string): EnsoCliError {
  const { code, message: reason } = error as NodeJS.ErrnoException;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new EnsoCliError("folder_access_denied", "The CLI does not have permission to use this folder", {
      path,
      reason,
      hint: "Choose a folder you can write to, or allow this terminal in System Settings > Privacy & Security > Files and Folders"
    });
  }
  return new EnsoCliError("invalid_input", message, { path, reason });
}

/**
 * The sandboxed app is granted only the exact folder, so the CLI creates it. Only the last
 * component is created, so a mistyped parent fails instead of building a chain of folders.
 * An existing folder passes through for the app to adopt or refuse. Returns whether this run
 * created the folder.
 */
function prepareVaultFolder(folder: string, dryRun: boolean): boolean {
  if (isExistingFolder(folder)) return false;
  const parent = dirname(folder);
  if (!statPath(parent)?.isDirectory()) {
    throw new EnsoCliError("invalid_input", "The vault folder's parent must be an existing folder", { path: folder, parent });
  }
  if (dryRun) return false;
  try {
    mkdirSync(folder);
  } catch (error) {
    // Made by another process since the check, so it is adopted like any existing folder.
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && isExistingFolder(folder)) return false;
    throw folderError(error, folder, "Could not create the vault folder");
  }
  return true;
}

function isExistingFolder(folder: string): boolean {
  const existing = statPath(folder);
  if (existing && !existing.isDirectory()) throw new EnsoCliError("invalid_input", "Vault path is a file, not a folder", { path: folder });
  return existing !== undefined;
}

/** Removes a folder this run created, unless something has already been written into it. */
function removeEmptyFolder(folder: string): void {
  try { rmdirSync(folder); } catch { /* not empty, or already gone */ }
}

/** An app that predates vault creation lacks the route. Every other refusal is the app's own. */
function requireVaultCreateSupport(envelope: EnsoEnvelope): EnsoEnvelope {
  if (!envelope.ok && isMissingRoute(envelope.error)) {
    throw new EnsoCliError("app_outdated", "The Enso app does not support creating vaults yet", {
      ...envelope.error.details,
      hint: "Update the Enso app, or create the vault from Enso's vault menu"
    });
  }
  return envelope;
}
