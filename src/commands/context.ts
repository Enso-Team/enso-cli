import { Command } from "commander";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { BridgeClient } from "../client.js";
import { EnsoCliError, type EnsoEnvelope } from "../errors.js";
import { markWorldBox } from "../mark-model.js";

const maxVisionImageEdge = 1568;

export function registerContext(program: Command): void {
  program
    .command("context")
    .option("--canvas <selector|current>")
    .option("--node <selector>")
    .option("--depth <n>", "node context depth", "1")
    .option("--query <query>")
    .option("--spec", "return the Canvas as members, edges, clusters, lines, marks, and excerpt owners for building from it")
    .option("--full", "return every Canvas field the app stores, including styling. Note content stays in the Vault files")
    .option("--vision", "include visual viewport context")
    .option("--diagnostics", "return only Canvas identity, viewport metadata, and visual diagnostics")
    .description("Export a Canvas view: positions by default, --spec to build from it, --full for every stored field")
    .action(async (options: ContextOptions) => {
      if ((options.spec || options.full) && (options.spec && options.full || options.vision || options.diagnostics || options.node || options.query)) {
        throw new EnsoCliError("invalid_input", "--spec and --full each stand alone", {
          path: "context", expected: "--spec or --full with an optional --canvas", hint: "Read each view in its own call"
        });
      }
      const client = new BridgeClient();
      const target = options.canvas ?? "current";
      const vision = Boolean(options.vision || options.diagnostics);
      const response = target !== "current" && !options.node && !options.query && !vision
        ? await client.request(`/v1/canvases/${encodeURIComponent(target)}/inspect`)
        : await client.request("/v1/context", {
        method: "POST",
        body: {
          canvas: options.canvas,
          node: options.diagnostics ? undefined : options.node,
          depth: Number(options.depth),
          query: options.diagnostics ? undefined : options.query,
          includeContent: !options.diagnostics && Boolean(options.node || options.query),
          vision: vision
            ? {
                enabled: true,
                scope: "viewport",
                transport: "file"
              }
            : undefined
        }
      });
      if (options.diagnostics) return diagnosticsContext(response);
      if (options.vision) await downscaleVisionImage(response);
      if (options.node || options.query || options.full) return response;
      return project(response, options.spec ? specView : positionsView);
    });
}

type ContextOptions = { canvas?: string; node?: string; depth: string; query?: string; spec?: boolean; full?: boolean; vision?: boolean; diagnostics?: boolean };

function diagnosticsContext(envelope: EnsoEnvelope): EnsoEnvelope {
  if (!envelope.ok) return envelope;
  const data = envelope.data as Record<string, unknown> | undefined;
  const vision = data?.vision as Record<string, unknown> | undefined;
  if (!vision?.diagnostics) {
    throw new EnsoCliError("diagnostics_unavailable", "Enso returns no visual diagnostics", {
      hint: "Open the intended Canvas in Enso and retry context --diagnostics",
      vision
    });
  }
  const context = data?.context as Record<string, unknown> | undefined;
  return { ok: true, data: { canvas: data?.canvas ?? context?.canvas, vision: pick(vision, ["capturedAt", "ok", "scope", "viewport", "diagnostics"]) } };
}

async function downscaleVisionImage(envelope: EnsoEnvelope): Promise<void> {
  if (process.platform !== "darwin" || !envelope.ok || !envelope.data || typeof envelope.data !== "object") return;
  const vision = (envelope.data as { vision?: { image?: { path?: unknown; width?: unknown; height?: unknown } } }).vision;
  const image = vision?.image;
  if (!image || typeof image.path !== "string" || typeof image.width !== "number" || typeof image.height !== "number") return;
  if (Math.max(image.width, image.height) <= maxVisionImageEdge || !existsSync(image.path)) return;
  const sips = promisify(execFile);
  try {
    await sips("sips", ["--resampleHeightWidthMax", String(maxVisionImageEdge), image.path]);
    const probe = await sips("sips", ["-g", "pixelWidth", "-g", "pixelHeight", image.path]);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(probe.stdout)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(probe.stdout)?.[1]);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      image.width = width;
      image.height = height;
    }
  } catch {
    // the original capture stays valid when resampling is unavailable
  }
}

function project(envelope: EnsoEnvelope, view: (data: Item) => Item): EnsoEnvelope {
  if (!envelope.ok || !isItem(envelope.data)) return envelope;
  return { ok: true, data: view(envelope.data) };
}

type Item = Record<string, unknown>;

/** What an author needs to place and repair elements: identity, meaning, and world geometry. */
function positionsView(data: Item): Item {
  const view: Item = { ...data };
  const fields: Record<string, string[]> = {
    nodes: ["id", "kind", "title", "ref", "subcanvasRef", "appearance", "position", "bounds"],
    links: ["id", "sourceNodeID", "targetNodeID", "targetPosition", "label", "displayLabel", "color", "direction", "lineStyle"],
    diagramPrimitives: ["id", "kind", "title", "color", "lineStyle", "position", "bounds", "start", "end", "x", "y", "x1", "y1", "x2", "y2", "width", "height"],
    marks: ["id", "kind", "text", "connectedNodeIDs", "position", "width"],
    excerpts: ["id", "linkedNodeID", "connectedNodeIDs", "bounds"]
  };
  for (const [key, keys] of Object.entries(fields)) if (Array.isArray(data[key])) view[key] = items(data[key]).map((item) => pick(item, keys));
  // A Mark stores no bounds, so the view adds the text block it covers, as Nodes carry theirs.
  for (const mark of items(view.marks)) {
    const { x, y } = isItem(mark.position) ? mark.position : {};
    if (typeof x !== "number" || typeof y !== "number") continue;
    const box = markWorldBox({ x, y, width: typeof mark.width === "number" ? mark.width : undefined, text: String(mark.text ?? "") });
    mark.bounds = { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
  }
  if (isItem(data.vision)) view.vision = pick(data.vision, ["capturedAt", "ok", "scope", "viewport", "diagnostics", "image", "warning"]);
  if (isItem(data.context)) view.context = positionsView(data.context);
  return view;
}

/** What an implementer needs to build from the Canvas: members, relationships, and grouping, by title. */
function specView(data: Item): Item {
  const source = isItem(data.context) && !Array.isArray(data.nodes) ? data.context : data;
  const nodes = items(source.nodes);
  const titles = nodes.map((node) => String(node.title));
  // A member is named by its title, or by its Note path when another member shares that title.
  const names = new Map(nodes.map((node, index) => [String(node.id),
    titles.indexOf(titles[index]) === titles.lastIndexOf(titles[index]) ? titles[index] : String(node.ref ?? node.subcanvasRef ?? node.id)]));
  const named = (ids: unknown) => (Array.isArray(ids) ? ids : [ids]).flatMap((id) => names.get(String(id)) ?? []);
  const about = (ids: unknown) => named(ids).length > 0 ? named(ids) : undefined;
  const primitives = items(source.diagramPrimitives);
  const canvas = isItem(source.canvas) ? source.canvas : isItem(data.canvas) ? data.canvas : {};
  return {
    canvas: canvas.name ?? canvas.id,
    members: nodes.map((node) => pick({
      title: names.get(String(node.id)),
      ...(node.kind === "portal" ? { portal: node.subcanvasRef } : { note: node.ref }),
      appearance: node.appearance === "card" ? undefined : node.appearance
    })),
    edges: items(source.links).flatMap((link) => {
      const [from, to] = [named(link.sourceNodeID)[0], named(link.targetNodeID)[0]];
      return from && to ? [pick({ from, to, label: link.displayLabel ?? link.label, color: link.color, direction: link.direction })] : [];
    }),
    // A Node belongs to each region its center sits in.
    clusters: primitives.filter((region) => region.kind === "group").map((region) => pick({
      name: region.title,
      color: region.color,
      members: nodes.filter((node) => contains(region, node.position)).map((node) => names.get(String(node.id)))
    })),
    lines: primitives.filter((line) => line.kind === "line" && line.title).map((line) => pick({ title: line.title, color: line.color, lineStyle: line.lineStyle })),
    marks: items(source.marks).filter((mark) => mark.text).map((mark) => pick({ text: mark.text, about: about(mark.connectedNodeIDs) })),
    excerpts: items(source.excerpts).flatMap((excerpt) =>
      named(excerpt.linkedNodeID).map((on) => pick({ on, about: about(excerpt.connectedNodeIDs) })))
  };
}

/** A region's bounds give its origin and size, or only its size beside a center `position`. */
function contains(region: Item, point: unknown): boolean {
  const bounds = isItem(region.bounds) ? region.bounds : {};
  const center = isItem(region.position) ? region.position : {};
  if (!isItem(point)) return false;
  const [width, height] = [bounds.width, bounds.height].map(Number);
  const left = typeof bounds.x === "number" ? bounds.x : Number(center.x) - width / 2;
  const top = typeof bounds.y === "number" ? bounds.y : Number(center.y) - height / 2;
  const [x, y] = [point.x, point.y].map(Number);
  return x >= left && x <= left + width && y >= top && y <= top + height;
}

/** The listed fields that hold a value, or every such field when none are listed. */
function pick(value: unknown, keys?: string[]): Item {
  if (!isItem(value)) return {};
  return Object.fromEntries((keys ?? Object.keys(value)).flatMap((key) => value[key] === undefined || value[key] === null ? [] : [[key, value[key]]]));
}

function items(value: unknown): Item[] {
  return Array.isArray(value) ? value.filter(isItem) : [];
}

function isItem(value: unknown): value is Item {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
