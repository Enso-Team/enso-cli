import { Command } from "commander";
import { checkEnsoFolder, type CheckReport } from "../enso-folder.js";
import type { EnsoEnvelope } from "../errors.js";

export function registerCheck(program: Command): void {
  program
    .command("check")
    .argument("[folder]", "the Vault folder to lint", ".")
    .description("Lint a Vault folder: frontmatter, duplicate titles, and wikilinks")
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
