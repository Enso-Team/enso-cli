import { EnsoCliError, type EnsoEnvelope } from "./errors.js";

// An Excerpt places a span of a Note's text on the Canvas. The Note owns the text, so the
// app addresses the span by the Note's id and a range of its markdown source.

/** The span the app anchors an Excerpt to. Matches the Codable `NoteExcerptSelection` in EnsoCore. */
export type NoteExcerptSelection = {
  noteID: string;
  /** `[location, length]` in UTF-16 code units of the whole file, which is how Foundation encodes `NSRange`. */
  rawRange: [number, number];
  capturedMarkdown: string;
  selectedMarkdown: string;
};

/**
 * UTF-16 offset where the body starts, after a frontmatter block. Mirrors
 * `DocumentIdentity.frontmatterBodyRange`: a first line of `---` closed by a later `---` line.
 */
export function bodyOffset(markdown: string): number {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return 0;
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) return 0;
  const offset = lines.slice(0, closing + 1).reduce((sum, line) => sum + line.length + 1, 0);
  return Math.min(offset, markdown.length);
}

/** UTF-16 offsets of every occurrence of `passage` in the Note body. */
export function passageOffsets(markdown: string, passage: string): number[] {
  const offsets: number[] = [];
  let index = markdown.indexOf(passage, bodyOffset(markdown));
  while (index !== -1) {
    offsets.push(index);
    index = markdown.indexOf(passage, index + 1);
  }
  return offsets;
}

/**
 * Selection for the `occurrence`th (1-based) appearance of `passage` in the Note body. The
 * passage is the markdown exactly as the file holds it.
 */
export function passageSelection(noteID: string, markdown: string, passage: string, occurrence?: number): NoteExcerptSelection {
  if (passage.trim().length === 0) throw new EnsoCliError("invalid_input", "Excerpt text must contain a nonblank character");
  const offsets = passageOffsets(markdown, passage);
  if (offsets.length === 0) {
    throw new EnsoCliError("passage_not_found", "The note body does not contain that text", {
      hint: "Quote the passage exactly as the markdown file holds it, including markup such as ** or [[ ]]"
    });
  }
  if (occurrence === undefined && offsets.length > 1) {
    throw new EnsoCliError("ambiguous_passage", `The note contains that text ${offsets.length} times`, {
      occurrences: offsets.length,
      hint: "Quote a longer passage, or pass --occurrence <n> to pick one"
    });
  }
  const index = (occurrence ?? 1) - 1;
  if (index >= offsets.length) {
    throw new EnsoCliError("invalid_input", `The note contains that text ${offsets.length} times`, { occurrences: offsets.length });
  }
  return { noteID, rawRange: [offsets[index], passage.length], capturedMarkdown: passage, selectedMarkdown: passage };
}

/**
 * An app that predates Excerpt routes answers them with its generic missing-route error. A
 * missing Excerpt or Node carries its own message and passes through.
 */
export function requireExcerptSupport(envelope: EnsoEnvelope): EnsoEnvelope {
  if (!envelope.ok && envelope.error.code === "not_found" && envelope.error.message === "Bridge route not found") {
    throw new EnsoCliError("app_outdated", "The Enso app does not support Excerpts yet", {
      ...(envelope.error.details ?? {}),
      hint: "Update the Enso app"
    });
  }
  return envelope;
}
