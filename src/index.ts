#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerAuth } from "./commands/auth.js";
import { registerCanvas } from "./commands/canvas.js";
import { registerContext } from "./commands/context.js";
import { registerPrimitive } from "./commands/primitive.js";
import { registerGraph } from "./commands/graph.js";
import { registerLayout } from "./commands/layout.js";
import { registerLink } from "./commands/link.js";
import { registerNode } from "./commands/node.js";
import { registerPortal } from "./commands/portal.js";
import { registerSearch } from "./commands/search.js";
import { registerSkill } from "./commands/skill.js";
import { registerStatus } from "./commands/status.js";
import { registerVault } from "./commands/vault.js";
import { errorEnvelope, printEnvelope, type EnsoEnvelope } from "./errors.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("enso")
    .description("Local CLI for the Enso Mac app")
    .option("--pretty", "format JSON output")
    .exitOverride();

  registerStatus(program);
  registerAuth(program);
  registerVault(program);
  registerSearch(program);
  registerCanvas(program);
  registerLayout(program);
  registerNode(program);
  registerPortal(program);
  registerLink(program);
  registerPrimitive(program);
  registerGraph(program);
  registerContext(program);
  registerSkill(program);

  program.hook("postAction", (thisCommand, actionCommand) => {
    const result = actionCommand.getOptionValue("__ensoResult") as EnsoEnvelope | undefined;
    if (result) {
      const pretty = Boolean(thisCommand.optsWithGlobals().pretty);
      printEnvelope(result, pretty, result.ok ? process.stdout : process.stderr);
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
      const result = (await action(processedArgs)) as EnsoEnvelope;
      command.setOptionValue("__ensoResult", result);
      process.exitCode = result.ok ? 0 : 1;
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
    if (isCommanderHelp(error)) {
      process.exitCode = 0;
      return;
    }
    const envelope = errorEnvelope(error);
    printEnvelope(envelope, Boolean(program.optsWithGlobals().pretty), process.stderr);
    process.exitCode = 1;
  }
}

function isCommanderHelp(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: string }).code === "commander.helpDisplayed";
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
