import { Command, InvalidArgumentError } from "commander";
import { BridgeClient } from "../client.js";

type DividerOrientation = "horizontal" | "vertical";
type LineStyle = "solid" | "dashed" | "dotted";

type PrimitiveOptions = {
  title?: string;
  color?: string;
  lineStyle?: LineStyle;
  strokeWidth?: string;
  fillOpacity?: string;
  dryRun?: boolean;
};

function parseOrientation(value: string): DividerOrientation {
  if (value === "horizontal" || value === "vertical") return value;
  throw new InvalidArgumentError("expected horizontal or vertical");
}

function parseLineStyle(value: string): LineStyle {
  if (value === "solid" || value === "dashed" || value === "dotted") return value;
  throw new InvalidArgumentError("expected solid, dashed, or dotted");
}

function parseNumberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new InvalidArgumentError(`${name} must be a number`);
  return parsed;
}

function primitiveVisualBody(options: PrimitiveOptions): {
  title?: string;
  color?: string;
  lineStyle?: LineStyle;
  strokeWidth?: number;
  fillOpacity?: number;
  dryRun: boolean;
} {
  return {
    title: options.title,
    color: options.color,
    lineStyle: options.lineStyle,
    strokeWidth: parseNumberOption(options.strokeWidth, "strokeWidth"),
    fillOpacity: parseNumberOption(options.fillOpacity, "fillOpacity"),
    dryRun: Boolean(options.dryRun)
  };
}

export function registerDiagram(program: Command): void {
  const diagram = program.command("diagram").description("Manage structured diagram primitives");

  diagram
    .command("list")
    .description("List lines, section dividers, and group boundaries")
    .action(async () => new BridgeClient().request("/v1/diagram-primitives"));

  diagram
    .command("line")
    .description("Create an arbitrary diagram line")
    .requiredOption("--x1 <number>", "start world x coordinate")
    .requiredOption("--y1 <number>", "start world y coordinate")
    .requiredOption("--x2 <number>", "end world x coordinate")
    .requiredOption("--y2 <number>", "end world y coordinate")
    .option("--title <title>")
    .option("--color <color>", "line color, such as #6B7280 or gray")
    .option("--line-style <style>", "solid, dashed, or dotted", parseLineStyle)
    .option("--stroke-width <number>")
    .option("--dry-run", "validate without mutating")
    .action(async (options: PrimitiveOptions & { x1: string; y1: string; x2: string; y2: string }) =>
      new BridgeClient().request("/v1/diagram-primitives", {
        method: "POST",
        body: {
          type: "line.create",
          x1: parseNumberOption(options.x1, "x1"),
          y1: parseNumberOption(options.y1, "y1"),
          x2: parseNumberOption(options.x2, "x2"),
          y2: parseNumberOption(options.y2, "y2"),
          ...primitiveVisualBody(options)
        },
        dryRun: Boolean(options.dryRun)
      })
    );

  diagram
    .command("divider")
    .description("Create a horizontal or vertical section divider")
    .requiredOption("--orientation <orientation>", "horizontal or vertical", parseOrientation)
    .requiredOption("--x <number>", "world-space center x (ADR-0003)")
    .requiredOption("--y <number>", "world-space center y (ADR-0003)")
    .requiredOption("--length <number>", "divider length in world units")
    .option("--title <title>")
    .option("--color <color>", "line color, such as #6B7280 or gray")
    .option("--line-style <style>", "solid, dashed, or dotted", parseLineStyle)
    .option("--stroke-width <number>")
    .option("--dry-run", "validate without mutating")
    .action(async (options: PrimitiveOptions & { orientation: DividerOrientation; x: string; y: string; length: string }) =>
      new BridgeClient().request("/v1/diagram-primitives", {
        method: "POST",
        body: {
          type: "divider.create",
          orientation: options.orientation,
          x: parseNumberOption(options.x, "x"),
          y: parseNumberOption(options.y, "y"),
          length: parseNumberOption(options.length, "length"),
          ...primitiveVisualBody(options)
        },
        dryRun: Boolean(options.dryRun)
      })
    );

  diagram
    .command("group")
    .description("Create a labeled group boundary")
    .requiredOption("--x <number>", "world-space center x (ADR-0003)")
    .requiredOption("--y <number>", "world-space center y (ADR-0003)")
    .requiredOption("--width <number>", "group width in world units")
    .requiredOption("--height <number>", "group height in world units")
    .option("--title <title>")
    .option("--color <color>", "boundary color, such as #6B7280 or gray")
    .option("--line-style <style>", "solid, dashed, or dotted", parseLineStyle)
    .option("--stroke-width <number>")
    .option("--fill-opacity <number>", "0 to 0.18")
    .option("--dry-run", "validate without mutating")
    .action(async (options: PrimitiveOptions & { x: string; y: string; width: string; height: string }) =>
      new BridgeClient().request("/v1/diagram-primitives", {
        method: "POST",
        body: {
          type: "group.create",
          x: parseNumberOption(options.x, "x"),
          y: parseNumberOption(options.y, "y"),
          width: parseNumberOption(options.width, "width"),
          height: parseNumberOption(options.height, "height"),
          ...primitiveVisualBody(options)
        },
        dryRun: Boolean(options.dryRun)
      })
    );

  diagram
    .command("update")
    .argument("<primitive-id>")
    .option("--title <title>")
    .option("--clear-title", "remove title")
    .option("--color <color>")
    .option("--clear-color", "remove custom color")
    .option("--x <number>")
    .option("--y <number>")
    .option("--x1 <number>")
    .option("--y1 <number>")
    .option("--x2 <number>")
    .option("--y2 <number>")
    .option("--width <number>")
    .option("--height <number>")
    .option("--length <number>")
    .option("--orientation <orientation>", "horizontal or vertical", parseOrientation)
    .option("--line-style <style>", "solid, dashed, or dotted", parseLineStyle)
    .option("--stroke-width <number>")
    .option("--fill-opacity <number>", "0 to 0.18")
    .option("--dry-run", "validate without mutating")
    .action(async (primitiveId: string, options: PrimitiveOptions & {
      clearTitle?: boolean;
      clearColor?: boolean;
      x?: string;
      y?: string;
      x1?: string;
      y1?: string;
      x2?: string;
      y2?: string;
      width?: string;
      height?: string;
      length?: string;
      orientation?: DividerOrientation;
    }) =>
      new BridgeClient().request(`/v1/diagram-primitives/${encodeURIComponent(primitiveId)}`, {
        method: "PUT",
        body: {
          title: options.clearTitle ? null : options.title,
          color: options.clearColor ? null : options.color,
          x: parseNumberOption(options.x, "x"),
          y: parseNumberOption(options.y, "y"),
          x1: parseNumberOption(options.x1, "x1"),
          y1: parseNumberOption(options.y1, "y1"),
          x2: parseNumberOption(options.x2, "x2"),
          y2: parseNumberOption(options.y2, "y2"),
          width: parseNumberOption(options.width, "width"),
          height: parseNumberOption(options.height, "height"),
          length: parseNumberOption(options.length, "length"),
          orientation: options.orientation,
          ...primitiveVisualBody(options)
        },
        dryRun: Boolean(options.dryRun)
      })
    );

  diagram
    .command("delete")
    .argument("<primitive-id>")
    .option("--dry-run", "validate without mutating")
    .action(async (primitiveId: string, options: { dryRun?: boolean }) =>
      new BridgeClient().request(`/v1/diagram-primitives/${encodeURIComponent(primitiveId)}`, {
        method: "DELETE",
        body: { dryRun: Boolean(options.dryRun) },
        dryRun: Boolean(options.dryRun)
      })
    );
}
