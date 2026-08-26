// The `enso/` folder linter. It reads files and nothing else: no writes, no bridge calls.
// Every rule states a folder convention. Notes are markdown files with frontmatter, links are
// prose lines carrying a wikilink, and a canvas is a `*.canvas.md` manifest.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import {
  canvasSpecFromFrontmatter,
  canvasSpecIssues,
  compareStrings,
  type CanvasSpec
} from "./canvas-spec.js";
import { EnsoCliError } from "./errors.js";
import { FrontmatterError, hasFrontmatterFence, parseFrontmatter } from "./frontmatter.js";

export const MANIFEST_SUFFIX = ".canvas.md";

export type CheckFinding = {
  code: string;
  file: string;
  message: string;
  details?: Record<string, unknown>;
};

export type CheckReport = {
  root: string;
  checked: { notes: number; outlines: number; manifests: number };
  violations: CheckFinding[];
  warnings: CheckFinding[];
};

type Prose = { body: string; bodyOffset: number };

type NoteFile = Prose & {
  file: string;
  title: string;
  uuid?: string;
  generated: boolean;
};

type ManifestFile = Prose & {
  file: string;
  spec: CanvasSpec;
};

export function checkEnsoFolder(root: string): CheckReport {
  const violations: CheckFinding[] = [];
  const notes: NoteFile[] = [];
  const manifests: ManifestFile[] = [];

  for (const path of markdownFiles(root)) {
    const file = relative(root, path).split(sep).join("/");
    const source = readFileSync(path, "utf8");
    if (file.endsWith(MANIFEST_SUFFIX)) {
      const read = readManifest(file, source);
      if (read.manifest) manifests.push(read.manifest);
      violations.push(...read.violations);
      continue;
    }
    const read = readNote(file, source);
    if (read.note) notes.push(read.note);
    violations.push(...read.violations);
  }

  const byTitle = new Map<string, NoteFile[]>();
  for (const note of notes) byTitle.set(note.title, [...(byTitle.get(note.title) ?? []), note]);

  violations.push(...duplicateUuids(notes));
  violations.push(...duplicateTitles(byTitle));
  violations.push(...unresolvedWikilinks([...notes, ...manifests], byTitle));
  violations.push(...manifestMembers(manifests, byTitle));

  const outlines = notes.filter((note) => note.generated).length;
  return {
    root,
    checked: { notes: notes.length - outlines, outlines, manifests: manifests.length },
    violations,
    warnings: missingUuids(notes)
  };
}

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of [...readEntries(root)].sort((a, b) => compareStrings(a.name, b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(path));
      continue;
    }
    if (entry.isSymbolicLink() && !isFile(path)) continue;
    if (extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

function readEntries(root: string) {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new EnsoCliError("invalid_input", `Folder '${root}' cannot be read: ${error instanceof Error ? error.message : "unknown error"}`, {
      path: "folder",
      expected: "a readable folder of authoring files",
      hint: "check lints files on disk; it does not inspect live canvases. After bridge authoring (layout --apply), verify with `enso context --vision` instead."
    });
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Frontmatter and structural rules are independent, so a manifest reports all of both. */
function readManifest(file: string, source: string): { manifest?: ManifestFile; violations: CheckFinding[] } {
  let frontmatter: ReturnType<typeof parseFrontmatter>;
  try {
    frontmatter = parseFrontmatter(source);
  } catch (error) {
    return { violations: [findingFromError("frontmatter_invalid", file, error, "Canvas manifest frontmatter is invalid")] };
  }
  let spec: CanvasSpec;
  try {
    spec = canvasSpecFromFrontmatter(frontmatter.value);
  } catch (error) {
    return { violations: [findingFromError("frontmatter_invalid", file, error, "Canvas manifest frontmatter is invalid")] };
  }
  return {
    manifest: { file, spec, body: frontmatter.body, bodyOffset: frontmatter.bodyOffset },
    violations: canvasSpecIssues(spec).map((issue) => ({
      code: issue.code,
      file,
      message: issue.message,
      details: { canvas: spec.canvas, path: issue.path }
    }))
  };
}

// A Note's title is its filename stem, the same identity `enso layout` resolves members by.
function readNote(file: string, source: string): { note?: NoteFile; violations: CheckFinding[] } {
  const title = file.slice(file.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  if (!hasFrontmatterFence(source)) {
    return { note: { file, title, generated: false, body: source.replace(/\r\n/g, "\n"), bodyOffset: 0 }, violations: [] };
  }
  let frontmatter: ReturnType<typeof parseFrontmatter>;
  try {
    frontmatter = parseFrontmatter(source);
  } catch (error) {
    return { violations: [findingFromError("frontmatter_invalid", file, error, "Note frontmatter is invalid")] };
  }
  const { value, body, bodyOffset } = frontmatter;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      violations: [{ code: "frontmatter_invalid", file, message: "Note frontmatter must be a `key: value` mapping", details: { path: "frontmatter" } }]
    };
  }
  const fields = value as Record<string, unknown>;
  const uuid = fields.uuid;
  if (uuid !== undefined && (typeof uuid !== "string" || uuid.trim() === "")) {
    return {
      violations: [{ code: "frontmatter_invalid", file, message: "Note frontmatter `uuid` must be a non-empty string", details: { path: "uuid" } }]
    };
  }
  return {
    note: {
      file,
      title,
      uuid: typeof uuid === "string" ? uuid.trim() : undefined,
      generated: fields.generated === true,
      body,
      bodyOffset
    },
    violations: []
  };
}

function findingFromError(code: string, file: string, error: unknown, fallback: string): CheckFinding {
  const body = error instanceof EnsoCliError ? error.body : undefined;
  const line = error instanceof FrontmatterError ? error.line : typeof body?.details?.line === "number" ? body.details.line : undefined;
  const path = typeof body?.details?.path === "string" ? body.details.path : "frontmatter";
  return {
    code,
    file,
    message: error instanceof Error ? error.message : fallback,
    details: { path, ...(line === undefined ? {} : { line }) }
  };
}

function duplicateUuids(notes: NoteFile[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const [uuid, group] of groupBy(notes, (note) => note.uuid)) {
    if (group.length < 2) continue;
    const files = group.map((note) => note.file).sort(compareStrings);
    for (const file of files) {
      findings.push({
        code: "duplicate_uuid",
        file,
        message: `UUID '${uuid}' is claimed by ${files.join(", ")}`,
        details: { uuid, files }
      });
    }
  }
  return findings;
}

// Wikilinks and canvas members resolve by title, so two files sharing one is a broken
// reference rather than a tie to break.
function duplicateTitles(byTitle: Map<string, NoteFile[]>): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const [title, group] of byTitle) {
    if (group.length < 2) continue;
    const files = group.map((note) => note.file).sort(compareStrings);
    for (const file of files) {
      findings.push({
        code: "duplicate_title",
        file,
        message: `Title '${title}' is claimed by ${files.join(", ")}`,
        details: { title, files }
      });
    }
  }
  return findings;
}

// A missing UUID reports as a warning and the folder still passes; UUID presence becomes a
// violation once the app reads folders directly. Duplicates always fail.
function missingUuids(notes: NoteFile[]): CheckFinding[] {
  return notes
    .filter((note) => !note.generated && note.uuid === undefined)
    .map((note) => ({
      code: "missing_uuid",
      file: note.file,
      message: "Note frontmatter carries no `uuid`",
      details: { hint: "Add a stable `uuid` so renames and moves keep the Note's identity" }
    }));
}

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

function unresolvedWikilinks(files: Array<Prose & { file: string; generated?: boolean }>, byTitle: Map<string, NoteFile[]>): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const source of files) {
    if (source.generated) continue;
    let fenced = false;
    source.body.split("\n").forEach((text, index) => {
      if (/^\s*(```|~~~)/.test(text)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      for (const match of text.matchAll(WIKILINK_PATTERN)) {
        const target = wikilinkTarget(match[1]);
        if (target === "" || byTitle.has(target)) continue;
        findings.push({
          code: "unresolved_wikilink",
          file: source.file,
          message: `Wikilink [[${target}]] resolves to no Note in the folder`,
          details: { target, line: source.bodyOffset + index + 1 }
        });
      }
    });
  }
  return findings;
}

function wikilinkTarget(raw: string): string {
  return raw.split("|")[0].split("#")[0].trim();
}

function manifestMembers(manifests: ManifestFile[], byTitle: Map<string, NoteFile[]>): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const manifest of manifests) {
    for (const member of manifest.spec.members) {
      const matches = byTitle.get(member.title) ?? [];
      if (matches.length === 0) {
        findings.push({
          code: "missing_canvas_member",
          file: manifest.file,
          message: `Canvas member '${member.title}' matches no Note in the folder`,
          details: { canvas: manifest.spec.canvas, member: member.title }
        });
        continue;
      }
      // An ambiguous title already reports as duplicate_title; only an unambiguously
      // generated target is an outline reference.
      if (!matches.every((note) => note.generated)) continue;
      findings.push({
        code: "generated_outline_referenced",
        file: manifest.file,
        message: `Canvas member '${member.title}' is a generated outline at ${matches[0].file}`,
        details: { canvas: manifest.spec.canvas, member: member.title, outline: matches[0].file }
      });
    }
  }
  return findings;
}

function groupBy<T, K>(items: T[], key: (item: T) => K | undefined): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const value = key(item);
    if (value === undefined) continue;
    groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return groups;
}
