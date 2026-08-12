import { Command } from "commander";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { BridgeClient } from "../client.js";
import type { EnsoEnvelope } from "../errors.js";

const maxVisionImageEdge = 1568;

export function registerContext(program: Command): void {
  program
    .command("context")
    .option("--canvas <selector|current>")
    .option("--node <selector>")
    .option("--depth <n>", "node context depth", "1")
    .option("--query <query>")
    .option("--vision", "include visual viewport context")
    .description("Export agent context from Enso")
    .action(async (options: { canvas?: string; node?: string; depth: string; query?: string; vision?: boolean }) => {
      const client = new BridgeClient();
      const target = options.canvas ?? "current";
      const response = target !== "current" && !options.node && !options.query && !options.vision
        ? await client.request(`/v1/canvases/${encodeURIComponent(target)}/inspect`)
        : await client.request("/v1/context", {
        method: "POST",
        body: {
          canvas: options.canvas,
          node: options.node,
          depth: Number(options.depth),
          query: options.query,
          vision: options.vision
            ? {
                enabled: true,
                scope: "viewport",
                transport: "file"
              }
            : undefined
        }
      });
      if (options.vision) await downscaleVisionImage(response);
      return options.node || options.query ? response : compactContext(response);
    });
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

function compactContext(envelope: EnsoEnvelope): EnsoEnvelope {
  if (!envelope.ok || !envelope.data || typeof envelope.data !== "object") return envelope;
  const data = envelope.data as Record<string, unknown>;
  return { ok: true, data: projectContextObject(data) };
}

function projectContextObject(data: Record<string, unknown>): Record<string, unknown> {
  const projected = { ...data };
  if (Array.isArray(data.nodes)) projected.nodes = data.nodes.map((value) => pick(value, ["id", "kind", "title", "displayTitle", "ref", "position", "bounds", "subcanvasRef"]));
  if (Array.isArray(data.links)) projected.links = data.links.map((value) => pick(value, ["id", "sourceNodeID", "targetNodeID", "label", "color", "direction", "isUnbound", "primaryBinding"]));
  if (Array.isArray(data.diagramPrimitives)) projected.diagramPrimitives = data.diagramPrimitives.map((value) => pick(value, ["id", "kind", "title", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "bounds", "color", "lineStyle", "strokeWidth", "fillOpacity"]));
  if (data.vision && typeof data.vision === "object") projected.vision = pick(data.vision, ["capturedAt", "ok", "scope", "viewport", "diagnostics", "image"]);
  if (data.context && typeof data.context === "object") projected.context = projectContextObject(data.context as Record<string, unknown>);
  return projected;
}

function pick(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]]));
}
