import { Command, InvalidArgumentError } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeClient, type RequestOptions } from "../client.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";
import { passageSelection, requireExcerptSupport } from "../excerpt-model.js";
import { noteMatches } from "../note-identity.js";
import { indexedNoteID } from "../vault-index.js";

type PlacementOptions = { x?: number; y?: number; width?: number; fontSize?: number; align?: string; dryRun?: boolean };
type CreateOptions = PlacementOptions & { note?: string; noteId?: string; link?: string; text: string; occurrence?: number };
type NoteNode = { id: string; kind?: string; title?: string; displayTitle?: string; ref?: string | null; noteID?: string | null };

const ALIGNMENTS = ["left", "center", "right", "justified"];

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) throw new InvalidArgumentError("must be a finite number of World points");
  return parsed;
}

function parseWidth(value: string): number {
  const width = parseNumber(value);
  if (width <= 0) throw new InvalidArgumentError("width must be a positive number of World points");
  return width;
}

function parseFontSize(value: string): number {
  const size = parseNumber(value);
  if (size < 8 || size > 96) throw new InvalidArgumentError("font size must be from 8 through 96 World points");
  return size;
}

function parseAlignment(value: string): string {
  if (!ALIGNMENTS.includes(value)) throw new InvalidArgumentError(`alignment must be ${ALIGNMENTS.join(", ")}`);
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUUID(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new InvalidArgumentError("note id must be a UUID");
  return value;
}

function parseOccurrence(value: string): number {
  const occurrence = Number(value);
  if (!Number.isInteger(occurrence) || occurrence < 1) throw new InvalidArgumentError("occurrence must be a positive integer");
  return occurrence;
}

function request(pathname: string, options: RequestOptions = {}): Promise<EnsoEnvelope> {
  return new BridgeClient().request(pathname, options).then(requireExcerptSupport);
}

function mutate(pathname: string, method: "POST" | "PUT" | "DELETE", body: Record<string, unknown>, dryRun?: boolean) {
  return request(pathname, { method, body: { ...body, dryRun: Boolean(dryRun) }, dryRun: Boolean(dryRun) });
}

function excerptPath(id: string, suffix = ""): string {
  return `/v1/excerpts/${encodeURIComponent(id)}${suffix}`;
}

function placementBody(options: PlacementOptions): Record<string, unknown> {
  if ((options.x === undefined) !== (options.y === undefined)) throw new InvalidArgumentError("pass --x and --y together");
  return {
    ...(options.x !== undefined ? { x: options.x, y: options.y } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.fontSize !== undefined ? { fontSize: options.fontSize } : {}),
    ...(options.align !== undefined ? { textAlignment: options.align } : {})
  };
}

function unwrap<T>(envelope: EnsoEnvelope): T {
  if (!envelope.ok) throw new EnsoCliError(envelope.error.code, envelope.error.message, envelope.error.details ?? {});
  return envelope.data as T;
}

/** The note node on the open Canvas that `selector` names. Its Note supplies the passage and the link. */
async function noteNode(selector: string): Promise<NoteNode> {
  const { nodes } = unwrap<{ nodes: NoteNode[] }>(await request("/v1/nodes"));
  const matches = nodes.filter(node => node.kind === "note" && noteMatches({ ...node, ref: node.ref ?? undefined }, selector));
  if (matches.length === 0) {
    throw new EnsoCliError("node_not_found", `No note node on the open canvas matches '${selector}'`, {
      hint: "Place the note first with `enso node place <note>`, so the excerpt has a node to link from"
    });
  }
  if (matches.length > 1) {
    throw new EnsoCliError("ambiguous_selector", `${matches.length} note nodes match '${selector}'`, {
      nodes: matches.map(node => ({ id: node.id, ref: node.ref })),
      hint: "Pass the note's vault-relative path or the node id"
    });
  }
  return matches[0];
}

async function createFromNote(options: CreateOptions): Promise<EnsoEnvelope> {
  if (options.x === undefined || options.y === undefined) throw new InvalidArgumentError("--note requires --x and --y");
  if (options.width !== undefined || options.fontSize !== undefined || options.align !== undefined) {
    throw new InvalidArgumentError("set width, font size, and alignment with `enso excerpt update` after creating");
  }
  const node = await noteNode(options.note!);
  if (!node.ref) throw new EnsoCliError("invalid_input", "The note node has no file in the vault", { node: node.id });
  const { path: vault } = unwrap<{ path: string }>(await request("/v1/vault/current"));
  const noteID = node.noteID ?? options.noteId ?? indexedNoteID(vault, node.ref);
  if (!noteID) {
    throw new EnsoCliError("app_outdated", "The Enso app does not report the note's id", {
      node: node.id,
      hint: "Update the Enso app, or pass --note-id with the noteID that `enso excerpt list` shows for an excerpt of this note"
    });
  }
  const markdown = readFileSync(join(vault, node.ref), "utf8");
  const selection = passageSelection(noteID, markdown, options.text, options.occurrence);
  const result = await mutate("/v1/excerpts", "POST", { selection, x: options.x, y: options.y }, options.dryRun);
  if (!result.ok && result.error.code === "stale_selection") {
    result.error.details = { ...result.error.details, hint: "The app holds a newer version of the note than its file. Let Enso save the note, then retry" };
  }
  return result;
}

function placementOptions(command: Command, positionHelp: string): Command {
  return command
    .option("--x <number>", `${positionHelp} x`, parseNumber)
    .option("--y <number>", `${positionHelp} y`, parseNumber)
    .option("--width <points>", "wrap width in World points", parseWidth)
    .option("--font-size <points>", "text size in World points, 8 through 96", parseFontSize)
    .option("--align <alignment>", `text alignment: ${ALIGNMENTS.join(", ")}`, parseAlignment)
    .option("--dry-run", "validate without mutating");
}

export function registerExcerpt(program: Command): void {
  const excerpt = program.command("excerpt").description(
    "Manage Excerpts: a span of a Note's text placed on the open Canvas, linked from the Note's node. Editing an Excerpt edits the Note."
  );

  excerpt
    .command("list")
    .description("List Excerpts on the open Canvas")
    .action(async () => request("/v1/excerpts"));
  excerpt
    .command("get")
    .argument("<excerpt-id>")
    .action(async (id: string) => request(excerptPath(id)));
  placementOptions(
    excerpt
      .command("create")
      .description(
        "Place a passage of a Note on the open Canvas, linked from the Note's node. With --link, write new text into the Note at a dangling link's end instead."
      )
      .option("--note <selector>", "note node title, vault-relative path, or node id whose Note holds the passage")
      .option("--note-id <uuid>", "the Note's app id, for an app whose nodes do not report it", parseUUID)
      .option("--link <link-id>", "dangling link from a note node; the text is added to that Note")
      .requiredOption("--text <markdown>", "with --note, the passage exactly as the file holds it; with --link, the new text")
      .option("--occurrence <n>", "which appearance of the passage to use when the Note repeats it, from 1", parseOccurrence),
    "World-space top-left"
  ).action(async (options: CreateOptions) => {
    if (Boolean(options.note) === Boolean(options.link)) throw new InvalidArgumentError("pass exactly one of --note or --link");
    if (options.note) return createFromNote(options);
    if (options.occurrence !== undefined || options.noteId !== undefined) throw new InvalidArgumentError("--occurrence and --note-id apply to --note");
    if (options.text.trim().length === 0) throw new InvalidArgumentError("excerpt text must contain a nonblank character");
    return mutate("/v1/excerpts", "POST", { link: options.link, text: options.text, ...placementBody(options) }, options.dryRun);
  });
  excerpt
    .command("move")
    .description("Move an Excerpt on the open Canvas")
    .argument("<excerpt-id>")
    .requiredOption("--x <number>", "World-space top-left x", parseNumber)
    .requiredOption("--y <number>", "World-space top-left y", parseNumber)
    .option("--dry-run", "validate without mutating")
    .action(async (id: string, options: PlacementOptions) =>
      mutate(excerptPath(id), "PUT", { x: options.x, y: options.y }, options.dryRun)
    );
  placementOptions(
    excerpt
      .command("update")
      .description("Change an Excerpt's position, wrap width, font size, or alignment. Formatting needs a typed Excerpt.")
      .argument("<excerpt-id>"),
    "World-space top-left"
  ).action(async (id: string, options: PlacementOptions) => {
    const body = placementBody(options);
    if (Object.keys(body).length === 0) throw new InvalidArgumentError("excerpt update requires --x and --y, --width, --font-size, or --align");
    return mutate(excerptPath(id), "PUT", body, options.dryRun);
  });
  excerpt
    .command("connect")
    .argument("<excerpt-id>")
    .argument("<node>", "node title, ref, or app UUID")
    .description("Draw a link from another node to the Excerpt")
    .option("--dry-run", "validate without mutating")
    .action(async (id: string, node: string, options: { dryRun?: boolean }) =>
      mutate(excerptPath(id, "/connect"), "POST", { node }, options.dryRun)
    );
  excerpt
    .command("source")
    .argument("<excerpt-id>")
    .description("Show the Note that owns the Excerpt and its markdown. With --text, replace the passage in the Note.")
    .option("--text <markdown>", "replacement passage, written into the Note")
    .option("--dry-run", "validate without mutating")
    .action(async (id: string, options: { text?: string; dryRun?: boolean }) => {
      if (options.text === undefined) {
        if (options.dryRun) throw new InvalidArgumentError("--dry-run applies to --text");
        return request(excerptPath(id, "/source"));
      }
      if (options.text.trim().length === 0) throw new InvalidArgumentError("excerpt text must contain a nonblank character");
      return mutate(excerptPath(id, "/source"), "PUT", { text: options.text }, options.dryRun);
    });
  excerpt
    .command("remove-from-note")
    .argument("<excerpt-id>")
    .description("Delete the passage from its Note. The Excerpt stays on the Canvas, marked as removed from the Note.")
    .option("--dry-run", "validate without mutating")
    .action(async (id: string, options: { dryRun?: boolean }) =>
      mutate(excerptPath(id, "/remove-from-note"), "POST", {}, options.dryRun)
    );
  excerpt
    .command("delete")
    .argument("<excerpt-id>")
    .description("Remove the Excerpt and its links from the Canvas. The Note keeps the passage.")
    .option("--dry-run", "validate without mutating")
    .action(async (id: string, options: { dryRun?: boolean }) => mutate(excerptPath(id), "DELETE", {}, options.dryRun));
}
