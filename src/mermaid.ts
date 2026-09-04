import { safeTitle } from "./canvas-intent.js";
import { buildCanvasSpec, compareStrings, type CanvasSpec, type DirectionHint } from "./canvas-spec.js";
import { EnsoCliError } from "./errors.js";
import type { LinkDirection } from "./link-model.js";

// A mermaid flowchart or state diagram is a canvas spec in different clothing: nodes are
// members, edges are Links, subgraphs and composite states are clusters, and the header
// direction is the direction hint. The text parser covers that subset and nothing else.

export const MERMAID_DIAGRAMS = ["flowchart", "stateDiagram"] as const;

type Statement = { text: string; line: number };
type Graph = {
  direction: DirectionHint;
  members: string[];
  edges: Array<{ from: string; to: string; label?: string; direction: LinkDirection }>;
  clusters: Array<{ name: string; members: string[] }>;
};

/** Compile mermaid text into the graph model `enso layout` lays out. */
export function parseMermaid(source: string, canvas?: string): CanvasSpec {
  const { title, statements } = readStatements(source);
  const header = statements[0];
  if (!header) throw mermaidError("Mermaid input carries no diagram statements", "mermaid");
  const graph = diagramKind(header) === "flowchart"
    ? readFlowchart(header, statements.slice(1))
    : readStateDiagram(statements.slice(1));
  return buildCanvasSpec(
    { canvas: canvas ?? title ?? "current", ...graph },
    mermaidError,
    "mermaid"
  );
}

export function mermaidError(message: string, path: string, expected?: string): EnsoCliError {
  return new EnsoCliError("invalid_input", message, {
    path,
    expected: expected ?? "a mermaid flowchart or stateDiagram in the documented subset",
    hint: "Run `enso layout --schema` for the machine-readable mermaid contract"
  });
}

function atLine(message: string, line: number, expected?: string): EnsoCliError {
  return mermaidError(`${message} (line ${line})`, `mermaid:${line}`, expected);
}

// Statement reading ---------------------------------------------------------

const FRONTMATTER_TITLE = /^title:\s*(.+)$/;

function readStatements(source: string): { title?: string; statements: Statement[] } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;
  let title: string | undefined;
  if (lines[0]?.trim() === "---") {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closing === -1) throw mermaidError("Mermaid frontmatter is never closed with `---`", "mermaid:1");
    for (const line of lines.slice(1, closing)) {
      const match = FRONTMATTER_TITLE.exec(line.trim());
      if (match) title = unquote(match[1].trim());
    }
    cursor = closing + 1;
  }
  const statements: Statement[] = [];
  for (let index = cursor; index < lines.length; index++) {
    const line = index + 1;
    for (const piece of splitTop(stripComment(lines[index].replace(/\t/g, " ")), ";")) {
      const text = piece.trim();
      if (text !== "") statements.push({ text, line });
    }
  }
  return { title, statements };
}

const FLOWCHART_HEADER = /^(?:flowchart|graph)(?:\s|$)/;
const STATE_HEADER = /^stateDiagram(?:-v2)?(?:\s|$)/;

function diagramKind(header: Statement): "flowchart" | "stateDiagram" {
  if (FLOWCHART_HEADER.test(header.text)) return "flowchart";
  if (STATE_HEADER.test(header.text)) return "stateDiagram";
  const found = /^[A-Za-z][A-Za-z0-9_-]*/.exec(header.text)?.[0] ?? header.text;
  throw new EnsoCliError("unsupported_diagram", `Mermaid diagram type '${found}' has no canvas mapping`, {
    path: `mermaid:${header.line}`,
    found,
    supported: [...MERMAID_DIAGRAMS],
    expected: `a diagram opening with one of: ${MERMAID_DIAGRAMS.join(", ")}`,
    hint: "Redraw the diagram as a flowchart or stateDiagram, or author a canvas spec manifest"
  });
}

const DIRECTIONS: Record<string, DirectionHint> = { TB: "TB", TD: "TB", LR: "LR" };

function readDirection(value: string, line: number): DirectionHint {
  const hint = DIRECTIONS[value.trim().toUpperCase()];
  if (hint) return hint;
  throw atLine(
    `Direction '${value.trim()}' has no canvas direction hint`,
    line,
    "TB, TD, or LR"
  );
}

// Flowchart -----------------------------------------------------------------

const UNSUPPORTED_FLOWCHART = /^(?:classDef|class|style|linkStyle|click|accTitle|accDescr)\b/;

function readFlowchart(header: Statement, statements: Statement[]): Graph {
  const rest = header.text.replace(/^(?:flowchart|graph)\s*/, "").trim();
  const builder = new GraphBuilder(rest === "" ? "TB" : readDirection(rest, header.line));
  const open: string[] = [];
  for (const statement of statements) {
    if (statement.text === "end") {
      if (open.pop() === undefined) throw atLine("`end` closes a subgraph that was never opened", statement.line);
      continue;
    }
    if (/^subgraph(?:\s|$)/.test(statement.text)) {
      if (open.length > 0) throw atLine("Nested subgraphs have no canvas mapping; flatten them into sibling subgraphs", statement.line);
      open.push(builder.openCluster(subgraphName(statement), statement.line));
      continue;
    }
    if (/^direction(?:\s|$)/.test(statement.text)) continue;
    if (UNSUPPORTED_FLOWCHART.test(statement.text)) {
      throw atLine(`Statement '${statement.text}' styles the diagram and has no canvas mapping`, statement.line);
    }
    readChain(statement, builder, open[0]);
  }
  if (open.length > 0) throw atLine(`Subgraph '${open[0]}' is never closed with \`end\``, statements[statements.length - 1]?.line ?? header.line);
  return builder.graph();
}

function subgraphName(statement: Statement): string {
  const rest = statement.text.replace(/^subgraph\s*/, "").trim();
  if (rest === "") throw atLine("A subgraph needs a name", statement.line);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\s*[[({>]/.test(rest)) return unquote(rest);
  const node = readNodeSpec(rest, statement.line);
  return node.label ?? node.id;
}

/** Split one flowchart statement into node parts and the connectors between them. */
function readChain(statement: Statement, builder: GraphBuilder, cluster: string | undefined): void {
  const { parts, connectors } = tokenizeChain(statement.text, statement.line);
  const groups = parts.map((part) => splitTop(part, "&")
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "")
    .map((piece) => builder.declare(readNodeSpec(piece, statement.line), statement.line, cluster)));
  for (const group of groups) {
    if (group.length === 0) throw atLine("A connector is missing an endpoint", statement.line);
  }
  connectors.forEach((connector, index) => {
    // A left-only arrow head points back up the chain, so the Link runs the other way.
    const [sources, targets] = connector.reversed
      ? [groups[index + 1], groups[index]]
      : [groups[index], groups[index + 1]];
    for (const from of sources) {
      for (const to of targets) {
        builder.connect(from, to, connector, statement.line);
      }
    }
  });
}

type Connector = { direction: LinkDirection; reversed: boolean; label?: string };

const CONNECTOR = new RegExp(
  "(<|o|x)?" +
  "(?:" +
    "(?:(?:--|==|-\\.)[ ]+(.+?)[ ]+(?:-{2,}|={2,}|\\.-+))" +
    "|(?:-{2,}|={2,}|-\\.+-|~{3,})" +
  ")" +
  "(>|o|x)?" +
  "(?:[ ]*\\|([^|]*)\\|)?",
  "y"
);

function tokenizeChain(text: string, line: number): { parts: string[]; connectors: Connector[] } {
  const scan = scanTopLevel(text);
  if (!scan.balanced) throw atLine("Unbalanced brackets or quotes", line);
  const parts: string[] = [];
  const connectors: Connector[] = [];
  let start = 0;
  for (const { index } of scan.positions) {
    if (index < start) continue;
    CONNECTOR.lastIndex = index;
    const match = CONNECTOR.exec(text);
    if (!match) continue;
    parts.push(text.slice(start, index));
    connectors.push({ ...arrowOf(match[1], match[3]), ...labelOf(match[4] ?? match[2]) });
    start = CONNECTOR.lastIndex;
  }
  parts.push(text.slice(start));
  return { parts, connectors };
}

/**
 * Mermaid puts the arrow head on the end it points at. A head on the right is the
 * ordinary forward Link, a head on the left points back at the left node, and a head on
 * both ends is bidirectional.
 */
function arrowOf(left: string | undefined, right: string | undefined): { direction: LinkDirection; reversed: boolean } {
  if (left && right) return { direction: "bidirectional", reversed: false };
  if (right) return { direction: "directed", reversed: false };
  if (left) return { direction: "directed", reversed: true };
  return { direction: "undirected", reversed: false };
}

function labelOf(value: string | undefined): { label?: string } {
  const label = value === undefined ? "" : unquote(value.trim());
  return label === "" ? {} : { label };
}

const SHAPES: Array<[string, string]> = [
  ["(((", ")))"],
  ["[[", "]]"],
  ["[(", ")]"],
  ["((", "))"],
  ["([", "])"],
  ["{{", "}}"],
  ["[/", "/]"],
  ["[/", "\\]"],
  ["[\\", "\\]"],
  ["[\\", "/]"],
  [">", "]"],
  ["[", "]"],
  ["(", ")"],
  ["{", "}"]
];

const NODE_ID = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)/;

function readNodeSpec(text: string, line: number): { id: string; label?: string } {
  const trimmed = text.trim();
  const match = NODE_ID.exec(trimmed);
  if (!match) throw atLine(`'${trimmed}' is not a node identifier`, line, "an alphanumeric node id, optionally followed by a shaped label");
  const id = match[1];
  const shaped = trimmed.slice(id.length).trim();
  if (shaped === "") return { id };
  for (const [open, close] of SHAPES) {
    if (shaped.length > open.length + close.length && shaped.startsWith(open) && shaped.endsWith(close)) {
      return { id, label: unquote(shaped.slice(open.length, shaped.length - close.length).trim()) };
    }
  }
  throw atLine(`Node '${id}' carries a shape this parser does not read`, line, "a bracketed label such as A[Title], A(Title), or A{Title}");
}

// State diagram -------------------------------------------------------------

const STATE_ALIAS = /^state\s+("[^"]*"|'[^']*')\s+as\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)$/;
const COMPOSITE_STATE = /^state\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\{$/;
const TRANSITION = /^(\[\*\]|[A-Za-z0-9_][A-Za-z0-9_.-]*)\s*-->\s*(\[\*\]|[A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(?::\s*(.*))?$/;
const DESCRIPTION = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s*(.+)$/;

function readStateDiagram(statements: Statement[]): Graph {
  const builder = new GraphBuilder("TB");
  const open: string[] = [];
  for (const statement of statements) {
    const text = statement.text;
    if (text === "}") {
      if (open.pop() === undefined) throw atLine("`}` closes a composite state that was never opened", statement.line);
      continue;
    }
    const directionMatch = /^direction\s+(\S+)$/.exec(text);
    if (directionMatch) {
      builder.direction = readDirection(directionMatch[1], statement.line);
      continue;
    }
    const composite = COMPOSITE_STATE.exec(text);
    if (composite) {
      if (open.length > 0) throw atLine("Nested composite states have no canvas mapping; flatten them into sibling states", statement.line);
      open.push(builder.openCluster(composite[1], statement.line));
      continue;
    }
    const alias = STATE_ALIAS.exec(text);
    if (alias) {
      builder.declare({ id: alias[2], label: unquote(alias[1]) }, statement.line, open[0]);
      continue;
    }
    const transition = TRANSITION.exec(text);
    if (transition) {
      const [, from, to, label] = transition;
      if (from === "[*]" || to === "[*]") {
        const state = from === "[*]" ? to : from;
        if (state !== "[*]") builder.declare({ id: state }, statement.line, open[0]);
        continue;
      }
      const source = builder.declare({ id: from }, statement.line, open[0]);
      const target = builder.declare({ id: to }, statement.line, open[0]);
      builder.connect(source, target, { direction: "directed", reversed: false, ...labelOf(label) }, statement.line);
      continue;
    }
    const description = DESCRIPTION.exec(text);
    if (description) {
      builder.declare({ id: description[1], label: description[2].trim() }, statement.line, open[0]);
      continue;
    }
    if (/^state\s/.test(text)) {
      throw atLine(`State statement '${text}' has no canvas mapping`, statement.line, "state \"Description\" as id, or state id {");
    }
    throw atLine(`Statement '${text}' has no canvas mapping`, statement.line, "a transition, a state declaration, or a state description");
  }
  if (open.length > 0) throw atLine(`Composite state '${open[0]}' is never closed with \`}\``, statements[statements.length - 1]?.line ?? 1);
  return builder.graph();
}

// Graph assembly ------------------------------------------------------------

/**
 * Mermaid identifies nodes by id and shows a label; the canvas identifies a Note by
 * title. Titles win where a label exists, and every reference to the id resolves to it.
 *
 * The self-edge, duplicate, and duplicate-cluster checks here repeat invariants
 * buildCanvasSpec owns. They earn their place by naming the mermaid line at fault, which
 * a spec-shaped error cannot.
 */
class GraphBuilder {
  direction: DirectionHint;
  private readonly labels = new Map<string, string | undefined>();
  private readonly order: string[] = [];
  private readonly clusterOf = new Map<string, string>();
  private readonly clusters: string[] = [];
  private readonly connections = new Map<string, Connection>();
  private readonly declaredAt = new Map<string, number>();

  constructor(direction: DirectionHint) {
    this.direction = direction;
  }

  openCluster(name: string, line: number): string {
    if (this.clusters.includes(name)) throw atLine(`Cluster '${name}' is declared more than once`, line);
    this.clusters.push(name);
    return name;
  }

  declare(node: { id: string; label?: string }, line: number, cluster: string | undefined): string {
    if (!this.labels.has(node.id)) {
      this.labels.set(node.id, node.label);
      this.order.push(node.id);
      this.declaredAt.set(node.id, line);
    } else if (node.label !== undefined) {
      const existing = this.labels.get(node.id);
      if (existing !== undefined && existing !== node.label) {
        throw atLine(`Node '${node.id}' carries two labels: '${existing}' and '${node.label}'`, line);
      }
      this.labels.set(node.id, node.label);
    }
    if (cluster !== undefined && !this.clusterOf.has(node.id)) this.clusterOf.set(node.id, cluster);
    return node.id;
  }

  /**
   * A canvas Link is one unordered pair, so a cycle drawn as two opposite arrows lands as
   * a single bidirectional Link. Drawing the same arrow twice is the duplicate.
   */
  connect(from: string, to: string, connector: Connector, line: number): void {
    if (from === to) throw atLine(`Node '${from}' links to itself`, line);
    const pair = [from, to].sort(compareStrings).join("\u0000");
    const orientation = connector.direction === "directed" ? forward(from, to) : connector.direction;
    const existing = this.connections.get(pair);
    if (existing === undefined) {
      this.connections.set(pair, { from, to, orientations: [orientation], label: connector.label, line });
      return;
    }
    if (existing.orientations.includes(orientation)) {
      throw atLine(`Nodes '${from}' and '${to}' are connected the same way twice (first on line ${existing.line})`, line);
    }
    if (existing.label !== undefined && connector.label !== undefined && existing.label !== connector.label) {
      throw atLine(
        `Nodes '${from}' and '${to}' compile to one Link, which cannot carry both '${existing.label}' and '${connector.label}'`,
        line,
        "one label across the connectors between a pair of nodes"
      );
    }
    existing.orientations.push(orientation);
    existing.label = existing.label ?? connector.label;
  }

  graph(): Graph {
    const titles = new Map<string, string>();
    const owners = new Map<string, string>();
    for (const id of this.order) {
      const title = this.labels.get(id) ?? id;
      const line = this.declaredAt.get(id)!;
      const checked = safeTitle.safeParse(title);
      if (!checked.success) {
        throw atLine(`Node title '${title}' is not a usable Note title: ${checked.error.issues[0]?.message}`, line);
      }
      const owner = owners.get(title);
      if (owner !== undefined) throw atLine(`Nodes '${owner}' and '${id}' both resolve to the title '${title}'`, line);
      owners.set(title, id);
      titles.set(id, title);
    }
    return {
      direction: this.direction,
      members: this.order.map((id) => titles.get(id)!),
      edges: [...this.connections.values()].map((connection) => {
        const edge = foldConnection(connection);
        return { ...edge, from: titles.get(edge.from)!, to: titles.get(edge.to)! };
      }),
      clusters: this.clusters.flatMap((name) => {
        const members = this.order.filter((id) => this.clusterOf.get(id) === name).map((id) => titles.get(id)!);
        return members.length === 0 ? [] : [{ name, members }];
      })
    };
  }
}

type Connection = { from: string; to: string; orientations: string[]; label?: string; line: number };

function forward(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** Fold every connector between one pair into the single Link the canvas holds. */
function foldConnection(connection: Connection): { from: string; to: string; label?: string; direction: LinkDirection } {
  const { from, to, orientations } = connection;
  const both = orientations.includes("bidirectional")
    || (orientations.includes(forward(from, to)) && orientations.includes(forward(to, from)));
  const direction: LinkDirection = both
    ? "bidirectional"
    : orientations.some((orientation) => orientation !== "undirected")
      ? "directed"
      : "undirected";
  const reversed = direction === "directed" && orientations.includes(forward(to, from));
  return {
    from: reversed ? to : from,
    to: reversed ? from : to,
    direction,
    ...(connection.label === undefined ? {} : { label: connection.label })
  };
}

// Helpers -------------------------------------------------------------------

/**
 * The one place that reads mermaid's nesting. Every character outside quotes and outside
 * a shape's brackets comes back with its index, so comments, separators, and connectors
 * are found in label text's absence rather than inside it.
 */
function scanTopLevel(text: string): { positions: Array<{ index: number; character: string }>; balanced: boolean } {
  const positions: Array<{ index: number; character: string }> = [];
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') quoted = !quoted;
    else if (quoted) continue;
    else if ("[({".includes(character)) depth += 1;
    else if ("])}".includes(character)) depth -= 1;
    else if (depth === 0) positions.push({ index, character });
  }
  return { positions, balanced: depth === 0 && !quoted };
}

/** Mermaid comments run from a top-level `%%` to the end of the line, directives included. */
function stripComment(text: string): string {
  const start = scanTopLevel(text).positions
    .find((position) => position.character === "%" && text[position.index + 1] === "%");
  return start === undefined ? text : text.slice(0, start.index);
}

function unquote(value: string): string {
  const match = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return match ? match[1] : value;
}

/** Split on a separator that sits outside quotes and brackets. */
function splitTop(text: string, separator: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (const position of scanTopLevel(text).positions) {
    if (position.character !== separator) continue;
    pieces.push(text.slice(start, position.index));
    start = position.index + 1;
  }
  pieces.push(text.slice(start));
  return pieces;
}

export const mermaidContract = {
  input: "a mermaid flowchart or stateDiagram file, passed as `enso layout --from-mermaid <graph.mmd>`",
  supported: [...MERMAID_DIAGRAMS],
  mapping: {
    nodes: "members, titled by the node label where it carries one and by the node id otherwise",
    edges: "Links, where the arrow head sets directed, undirected, or bidirectional, the end the head touches sets which way the Link runs, and the edge text sets the label",
    subgraphs: "clusters, one region each; composite states map the same way",
    direction: "the direction hint, where TB and TD compile to TB and LR compiles to LR"
  },
  canvas: "the frontmatter `title`, or `--canvas <name>`, or `current`",
  resolution: "every title goes through the vault tree and vault search; a title either surface holds is placed as that Note, and the rest become stub Notes for the agent to fill. A vault listing the app refuses to return stops the compile",
  limits: [
    "BT and RL reverse the flow and have no direction hint",
    "nested subgraphs and nested composite states",
    "styling statements: classDef, class, style, linkStyle, click",
    "the [*] start and end pseudostate, which carries no Note and is dropped",
    "the same arrow drawn twice, and an edge from a node to itself",
    "two labels across the connectors between one pair, which compile to one Link"
  ],
  reciprocal: "opposite arrows between one pair compile to a single bidirectional Link, which is the Link the canvas holds",
  determinism: "identical mermaid input yields byte-identical geometry; vault state moves which members are placed and which are stubbed, never a coordinate",
  example: [
    "flowchart LR",
    "  subgraph Edge",
    "    Gateway[API Gateway] -->|routes| Router",
    "  end",
    "  Router --> Store[(Object Store)]"
  ].join("\n")
} as const;
