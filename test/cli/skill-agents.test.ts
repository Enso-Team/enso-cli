import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkillAgents } from "../../src/skill-agents.js";

const homeDirectory = join("/", "agents-home");
const workingDirectory = join("/", "project");

function discover(paths: string[], environment: NodeJS.ProcessEnv = {}) {
  const installed = new Set(paths);
  return discoverSkillAgents({ homeDirectory, workingDirectory, environment, pathExists: path => installed.has(path) });
}

describe("installed skill agents", () => {
  it("discovers installed agents independently of the calling agent", () => {
    const result = discover([".codex", ".claude", ".gemini", ".cursor", ".pi/agent", ".config/opencode"].map(path => join(homeDirectory, path)), { CODEX_THREAD_ID: "calling-agent" });
    expect(result.agents).toEqual(["claude-code", "codex", "cursor", "gemini-cli", "opencode", "pi"]);
    expect(result.skippedAgents).toEqual([]);
  });
  it("separates project-only agents from global installation targets", () => {
    const result = discover([join(homeDirectory, ".codex"), join(workingDirectory, "promptscript.yaml")]);
    expect(result).toEqual({ agents: ["codex"], skippedAgents: ["promptscript"] });
  });
  it("honors configured agent and XDG directories", () => {
    const codexDirectory = join("/", "configured", "codex");
    const claudeDirectory = join("/", "configured", "claude");
    const configDirectory = join("/", "configured", "config");
    const result = discover([codexDirectory, claudeDirectory, join(configDirectory, "goose")], { CODEX_HOME: codexDirectory, CLAUDE_CONFIG_DIR: claudeDirectory, XDG_CONFIG_HOME: configDirectory });
    expect(result.agents).toEqual(["claude-code", "codex", "goose"]);
  });
  it("reports an empty inventory for an empty environment", () => {
    expect(discover([])).toEqual({ agents: [], skippedAgents: [] });
  });
});
