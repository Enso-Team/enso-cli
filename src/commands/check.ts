import { Command } from "commander";
import { checkEnsoFolder, type CheckReport } from "../enso-folder.js";
import type { EnsoEnvelope } from "../errors.js";

export function registerCheck(program: Command): void {
  program
    .command("check")
    .argument("[folder]", "authoring root to lint", "enso")
    .description("Lint an enso/ folder: frontmatter, UUIDs, wikilinks, and canvas manifests")
    .action((folder: string): EnsoEnvelope => toEnvelope(checkEnsoFolder(folder)));
}

function toEnvelope(report: CheckReport): EnsoEnvelope {
  const { violations, ...rest } = report;
  if (violations.length === 0) return { ok: true, data: { ...rest, violations } };
  return {
    ok: false,
    error: {
      code: "check_failed",
      message: `${violations.length} ${violations.length === 1 ? "violation" : "violations"} in ${report.root}`,
      details: { ...rest, violations }
    }
  };
}
