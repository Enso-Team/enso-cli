import { Command, InvalidArgumentError } from "commander";
import { BridgeClient, type RequestOptions } from "../client.js";
import { parseWorldPoint, type WorldPoint } from "../link-model.js";
import { MARK_DEFAULT_FONT_SIZE, markFontSizeSchema, parseMarkTextRuns, requireMarkSupport, runsOutsideText, type MarkTextRun } from "../mark-model.js";

type MarkWriteOptions = { at?: WorldPoint; width?: number; fontSize?: number; resetSize?: boolean; runs?: MarkTextRun[]; dryRun?: boolean };

function parseAt(value: string): WorldPoint {
  try {
    return parseWorldPoint(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : "Invalid position");
  }
}

function parseFontSize(value: string): number {
  const parsed = markFontSizeSchema.safeParse(Number(value));
  if (!parsed.success) throw new InvalidArgumentError("font size must be 8–96 finite world points");
  return parsed.data;
}

function parseWidth(value: string): number {
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0) throw new InvalidArgumentError("width must be a positive number of World points");
  return width;
}

function parseRuns(value: string): MarkTextRun[] {
  try {
    return parseMarkTextRuns(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : "Invalid formatting");
  }
}

function markBody(text: string | undefined, options: MarkWriteOptions): Record<string, unknown> {
  if (text !== undefined && text.trim().length === 0) throw new InvalidArgumentError("mark text must contain a nonblank character");
  if (text !== undefined && options.runs && runsOutsideText(text, options.runs)) {
    throw new InvalidArgumentError("formatting ranges must lie inside the text");
  }
  if (options.resetSize && options.fontSize !== undefined) throw new InvalidArgumentError("Choose font-size or reset-size");
  return {
    ...(options.resetSize ? { fontSize: MARK_DEFAULT_FONT_SIZE } : options.fontSize !== undefined ? { fontSize: options.fontSize } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(options.at ? { x: options.at.x, y: options.at.y } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.runs ? { textRuns: options.runs } : {}),
    dryRun: Boolean(options.dryRun)
  };
}

function request(pathname: string, options: RequestOptions = {}) {
  return new BridgeClient().request(pathname, options).then(requireMarkSupport);
}

function nodeAction(path: string) {
  return (id: string, node: string, options: { dryRun?: boolean }) =>
    request(`/v1/marks/${encodeURIComponent(id)}/${path}`, {
      method: "POST",
      body: { node, dryRun: Boolean(options.dryRun) },
      dryRun: Boolean(options.dryRun)
    });
}

export function registerMark(program: Command): void {
  const mark = program.command("mark").description(
    "Manage Marks: canvas-owned text that labels, decorates, or comments on the open Canvas without becoming a Note"
  );

  mark
    .command("list")
    .description("List Marks on the open Canvas, typed and handwritten. Handwriting carries an interpretation with its approval.")
    .action(async () => request("/v1/marks"));
  mark
    .command("get")
    .argument("<mark-id>")
    .action(async (id: string) => request(`/v1/marks/${encodeURIComponent(id)}`));
  mark
    .command("create")
    .description("Write typed text on the open Canvas")
    .argument("<text>", "the Mark's text; newlines break lines")
    .requiredOption("--at <x,y>", "World-space top-left of the text block", parseAt)
    .option("--width <points>", "wrap width in World points; omit for natural width up to 420", parseWidth)
    .option("--font-size <points>", "Text size in world points, 8–96", parseFontSize)
    .option("--runs <json>", "formatting as [{location, length, styles}] with bold, italic, highlight, strikethrough, or code", parseRuns)
    .option("--dry-run", "validate without mutating")
    .action(async (text: string, options: MarkWriteOptions) =>
      request("/v1/marks", { method: "POST", body: markBody(text, options), dryRun: Boolean(options.dryRun) })
    );
  mark
    .command("update")
    .description("Edit a typed Mark's text, position, width, or formatting. Handwritten Marks belong to the person who drew them.")
    .argument("<mark-id>")
    .option("--reset-size", "Reset text size to 17 world points, retaining wrap width")
    .option("--text <text>", "replacement text")
    .option("--at <x,y>", "World-space top-left of the text block", parseAt)
    .option("--width <points>", "wrap width in World points", parseWidth)
    .option("--font-size <points>", "Text size in world points, 8–96", parseFontSize)
    .option("--runs <json>", "replacement formatting as [{location, length, styles}]; [] clears it", parseRuns)
    .option("--dry-run", "validate without mutating")
    .action(async (id: string, options: MarkWriteOptions & { text?: string }) => {
      if (options.text === undefined && !options.at && options.width === undefined && options.fontSize === undefined && !options.resetSize && !options.runs) {
        throw new InvalidArgumentError("mark update requires --text, --at, --width, --font-size, --reset-size, or --runs");
      }
      return request(`/v1/marks/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: markBody(options.text, options),
        dryRun: Boolean(options.dryRun)
      });
    });
  mark
    .command("delete")
    .argument("<mark-id>")
    .description("Delete a Mark and its connections")
    .option("--dry-run", "validate without mutating")
    .action(async (id: string, options: { dryRun?: boolean }) =>
      request(`/v1/marks/${encodeURIComponent(id)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
  mark
    .command("connect")
    .argument("<mark-id>")
    .argument("<node>", "Node title, ref, or app UUID")
    .description("Draw a connection from a Node to the Mark, so the Mark comments on that Node. Several Nodes can connect to one Mark.")
    .option("--dry-run", "validate without mutating")
    .action(nodeAction("connect"));
  mark
    .command("add-to-note")
    .argument("<mark-id>")
    .argument("<note-node>", "Note Node title, ref, or app UUID")
    .description("Move the Mark's writing into the Note. It stays on the Canvas as an Excerpt the Note owns.")
    .option("--dry-run", "validate without mutating")
    .action(nodeAction("add-to-note"));
  mark
    .command("drop-to-note")
    .argument("<mark-id>")
    .argument("<note-node>", "Note Node title, ref, or app UUID")
    .description("Append the Mark's writing to the Note and remove the Mark from the Canvas")
    .option("--dry-run", "validate without mutating")
    .action(nodeAction("drop-to-note"));
}

export function registerExcerpt(program: Command): void {
  const excerpt = program.command("excerpt").description("Inspect and size note-owned canvas writing");
  excerpt.command("list").action(async () => request("/v1/excerpts"));
  excerpt.command("get").argument("<excerpt-id>").action(async (id: string) => request(`/v1/excerpts/${encodeURIComponent(id)}`));
  excerpt.command("update").argument("<excerpt-id>")
    .option("--font-size <points>", "Placement text size in world points, 8–96", parseFontSize)
    .option("--reset-size", "Reset placement text size to 17 world points, retaining wrap width")
    .option("--width <points>", "Wrap width in world points", parseWidth)
    .option("--at <x,y>", "World-space top-left", parseAt)
    .option("--dry-run", "validate without mutating")
    .action(async (id: string, options: MarkWriteOptions) => {
      if (options.fontSize === undefined && !options.resetSize && options.width === undefined && !options.at) throw new InvalidArgumentError("Provide font-size, reset-size, width, or at");
      return request(`/v1/excerpts/${encodeURIComponent(id)}`, { method: "PUT", body: markBody(undefined, options), dryRun: Boolean(options.dryRun) });
    });
}
