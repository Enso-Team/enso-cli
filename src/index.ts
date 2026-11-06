#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerAuth } from "./commands/auth.js";
import { registerCanvas } from "./commands/canvas.js";
import { registerCheck } from "./commands/check.js";
import { registerContext } from "./commands/context.js";
import { registerExcerpt } from "./commands/excerpt.js";
import { registerPrimitive } from "./commands/primitive.js";
import { registerLayout } from "./commands/layout.js";
import { registerLink } from "./commands/link.js";
import { registerMark } from "./commands/mark.js";
import { registerNode } from "./commands/node.js";
import { registerPortal } from "./commands/portal.js";
import { registerSearch } from "./commands/search.js";
import { registerSkill } from "./commands/skill.js";
import { registerRunner } from "./commands/runner.js";
import { registerStatus } from "./commands/status.js";
import { registerUpdate } from "./commands/update.js";
import { notifyUpdate, wantsUpdateNotice } from "./update.js";
import { registerVault } from "./commands/vault.js";
import { EnsoCliError, errorEnvelope, hasOwnOutput, printEnvelope, type EnsoEnvelope } from "./errors.js";
import { withRequestContext, currentRequestContext, type TargetOptions } from "./targeting.js";
import { cliVersion } from "./version.js";

function immutableOption(value: string, previous?: string): string {
  if (previous !== undefined && previous !== value) throw new EnsoCliError("target_conflict", "Repeated target options must agree");
  return value;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .configureHelp({ showGlobalOptions: true })
    .name("enso")
    .description("Local CLI for the Enso Mac app")
    .version(cliVersion, "-v, --version", "print the installed CLI version")
    .option("--pretty", "format JSON output")
    .option("--canvas <selector>", "resolve one canvas name, ref or stable canvasID for this invocation", immutableOption)
    .option("--vault-id <uuid>", "immutable binding: stable vault UUID; requires --canvas-id", immutableOption)
    .option("--canvas-id <uuid>", "immutable binding: stable canvas UUID; requires --vault-id", immutableOption)
    .addHelpText("after", "\nCanvas requests require Enso bridge contract 3. Selection never navigates.\nBinding: supply both --vault-id/--canvas-id or ENSO_VAULT_ID/ENSO_CANVAS_ID.\nA binding rejects selector overrides and navigation; target errors are never replayed.")
    .exitOverride();

  registerRunner(program);
  registerStatus(program);
  registerAuth(program);
  registerVault(program);
  registerSearch(program);
  registerCanvas(program);
  registerLayout(program);
  registerCheck(program);
  registerNode(program);
  registerPortal(program);
  registerLink(program);
  registerPrimitive(program);
  registerMark(program);
  registerExcerpt(program);
  registerContext(program);
  registerSkill(program);
  registerUpdate(program);

  program.hook("postAction", async (thisCommand, actionCommand) => {
    const result = actionCommand.getOptionValue("__ensoResult") as EnsoEnvelope | undefined;
    if (result) {
      const pretty = Boolean(thisCommand.optsWithGlobals().pretty);
      printEnvelope(result, pretty, result.ok ? process.stdout : process.stderr);
      if (result.ok && wantsUpdateNotice(actionCommand)) await notifyUpdate();
    }
  });

  for (const command of program.commands) {
    wrapActions(command);
  }

  return program;
}

function wrapActions(command: Command): void {
  for (const child of command.commands) wrapActions(child);
  // Relies on Commander's private `_actionHandler`; revalidate on any commander major bump (pinned ^12).
  const action = command["_actionHandler" as keyof Command] as ((...args: unknown[]) => unknown) | undefined;
  if (!action) return;

  command.action(async (...args: unknown[]) => {
    const program = rootCommand(command);
    try {
      const processedArgs = (command as unknown as { processedArgs: unknown[] }).processedArgs ?? args;
      const options = command.optsWithGlobals() as TargetOptions;
      const rootCanvas = program.opts().canvas as string | undefined;
      const localCanvas = command.opts().canvas as string | undefined;
      if (rootCanvas && localCanvas && rootCanvas !== localCanvas) throw new EnsoCliError("target_conflict", "Conflicting canvas selectors");
      if (options.canvas !== undefined) command.setOptionValue("canvas", options.canvas);
      const result = await withRequestContext(options, async () => {
        const context = currentRequestContext()!;
        const group = command.parent?.name();
        if (context.bound && ((group === "vault" && ["open", "create"].includes(command.name())) ||
          (group === "canvas" && ["open", "create", "delete"].includes(command.name())) ||
          (group === "portal" && command.name() === "open") ||
          (group === "auth" && ["link", "unlink"].includes(command.name())))) context.rejectNavigation();
        return await action(processedArgs) as EnsoEnvelope | undefined;
      });
      // A missing envelope is a bug, not a silent success, unless the command printed its own output.
      if (result === undefined && !hasOwnOutput(command)) throw new EnsoCliError("internal_error", `${command.name()} returned no result`);
      command.setOptionValue("__ensoResult", result);
      process.exitCode = result === undefined || result.ok ? 0 : 1;
    } catch (error) {
      const envelope = errorEnvelope(error);
      printEnvelope(envelope, Boolean(program.optsWithGlobals().pretty), process.stderr);
      process.exitCode = 1;
    }
  });
}

function rootCommand(command: Command): Command {
  let current = command;
  while (current.parent) current = current.parent;
  return current;
}

export async function run(argv = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (isCommanderInfoExit(error)) {
      process.exitCode = 0;
      return;
    }
    const envelope = errorEnvelope(error);
    printEnvelope(envelope, Boolean(program.optsWithGlobals().pretty), process.stderr);
    process.exitCode = 1;
  }
}

/**
 * Commander's `.exitOverride()` turns help and version output into thrown errors even though
 * both printed exactly what was asked for. Callers treat these two codes as a clean exit.
 */
export function isCommanderInfoExit(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  return code === "commander.helpDisplayed" || code === "commander.version";
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  void run();
}
