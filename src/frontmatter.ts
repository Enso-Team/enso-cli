// The YAML-subset frontmatter reader behind every authored file in an `enso/` folder:
// canvas manifests and Note frontmatter alike. It reports the offending line so callers
// can point at it, and hands back the body with its line offset so nobody re-derives the fence.

export class FrontmatterError extends Error {
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(message);
    this.name = "FrontmatterError";
    this.line = line;
  }
}

export type ParsedFrontmatter = {
  value: unknown;
  /** Body text after the closing fence, newlines normalized. */
  body: string;
  /** Lines consumed by the frontmatter block, so body line N is `bodyOffset + N`. */
  bodyOffset: number;
};

export function hasFrontmatterFence(source: string): boolean {
  return source.replace(/\r\n/g, "\n").split("\n", 1)[0]?.trim() === "---";
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") throw new FrontmatterError("File must open with a `---` frontmatter fence");
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) throw new FrontmatterError("Frontmatter is never closed with `---`");
  const block = toSpecLines(lines.slice(1, closing), 2);
  if (block.length === 0) throw new FrontmatterError("Frontmatter is empty");
  return { value: parseBlock(block), body: lines.slice(closing + 1).join("\n"), bodyOffset: closing + 1 };
}

type SpecLine = { indent: number; text: string; line: number };

function toSpecLines(raw: string[], firstLineNumber: number): SpecLine[] {
  const lines: SpecLine[] = [];
  raw.forEach((value, index) => {
    const line = index + firstLineNumber;
    if (value.includes("\t")) throw new FrontmatterError("Tabs are not allowed in frontmatter", line);
    const text = value.trim();
    if (text === "" || text.startsWith("#")) return;
    lines.push({ indent: value.length - value.trimStart().length, text, line });
  });
  return lines;
}

function parseBlock(lines: SpecLine[]): unknown {
  return isSequenceItem(lines[0].text) ? parseSequence(lines) : parseMapping(lines);
}

function parseMapping(lines: SpecLine[]): Record<string, unknown> {
  const result = new Map<string, unknown>();
  const indent = lines[0].indent;
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) throw new FrontmatterError("Inconsistent indentation", line.line);
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line.text);
    if (!match) throw new FrontmatterError("Expected a `key: value` entry", line.line);
    const key = match[1];
    if (result.has(key)) throw new FrontmatterError(`Duplicate key '${key}'`, line.line);
    const inline = (match[2] ?? "").trim();
    const children: SpecLine[] = [];
    cursor += 1;
    while (cursor < lines.length && lines[cursor].indent > indent) {
      children.push(lines[cursor]);
      cursor += 1;
    }
    if (inline === "") {
      if (children.length === 0) throw new FrontmatterError(`Key '${key}' has no value; indent its block underneath`, line.line);
      result.set(key, parseBlock(children));
    } else {
      if (children.length > 0) throw new FrontmatterError(`Key '${key}' has both an inline value and an indented block`, line.line);
      result.set(key, parseScalar(inline, line.line));
    }
  }
  return Object.fromEntries(result);
}

function parseSequence(lines: SpecLine[]): unknown[] {
  const items: unknown[] = [];
  const indent = lines[0].indent;
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) throw new FrontmatterError("Inconsistent indentation", line.line);
    if (!isSequenceItem(line.text)) throw new FrontmatterError("Expected a `- ` sequence item", line.line);
    const inline = line.text.slice(1).trim();
    const children: SpecLine[] = [];
    cursor += 1;
    while (cursor < lines.length && lines[cursor].indent > indent) {
      children.push(lines[cursor]);
      cursor += 1;
    }
    const base = children.length > 0 ? Math.min(...children.map((child) => child.indent)) : indent + 2;
    if (inline === "") {
      if (children.length === 0) throw new FrontmatterError("Sequence item has no value", line.line);
      items.push(parseBlock(children));
    } else if (/^[A-Za-z][A-Za-z0-9_-]*:(\s|$)/.test(inline)) {
      items.push(parseMapping([{ indent: base, text: inline, line: line.line }, ...children]));
    } else {
      if (children.length > 0) throw new FrontmatterError("Sequence item has both an inline value and an indented block", line.line);
      items.push(parseScalar(inline, line.line));
    }
  }
  return items;
}

function parseScalar(value: string, line: number): unknown {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  if (quoted) return quoted[1];
  if (/^[[{]/.test(value)) throw new FrontmatterError("Inline collections are not supported; write an indented block", line);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}
