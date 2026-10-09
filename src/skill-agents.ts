/*!
Agent discovery adapted from vercel-labs/skills v1.7.1 src/agents.ts.
https://github.com/vercel-labs/skills/blob/v1.7.1/src/agents.ts

MIT License

Copyright (c) 2026 Vercel, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type AgentDiscoveryEnvironment = {
  homeDirectory?: string;
  workingDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
};

function packageJsonHasDependency(packageJsonPath: string, dependencyName: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return !!(
      packageJson.dependencies?.[dependencyName] || packageJson.devDependencies?.[dependencyName]
    );
  } catch {
    return false;
  }
}

/** Find installed agents and separate those with project-only skill locations. */
export function discoverSkillAgents(options: AgentDiscoveryEnvironment = {}): { agents: string[]; skippedAgents: string[] } {
  const homeDirectory = options.homeDirectory ?? homedir();
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const environment = options.environment ?? process.env;
  const pathExists = options.pathExists ?? existsSync;
  const configHome = process.platform !== "win32" && environment.XDG_CONFIG_HOME && isAbsolute(environment.XDG_CONFIG_HOME)
    ? environment.XDG_CONFIG_HOME : join(homeDirectory, ".config");
  const codexHome = environment.CODEX_HOME?.trim() || join(homeDirectory, '.codex');
  const claudeHome = environment.CLAUDE_CONFIG_DIR?.trim() || join(homeDirectory, '.claude');
  const vibeHome = environment.VIBE_HOME?.trim() || join(homeDirectory, '.vibe');
  const hermesHome = environment.HERMES_HOME?.trim() || join(homeDirectory, '.hermes');
  const autohandHome = environment.AUTOHAND_HOME?.trim() || join(homeDirectory, '.autohand');
  const grokHome = environment.GROK_HOME?.trim() || join(homeDirectory, '.grok');
  const sarvamHome = environment.SARVAM_HOME?.trim() || join(homeDirectory, '.sarvam');
  const zedAppDataHome = environment.APPDATA?.trim();
  const zedFlatpakConfigHome = environment.FLATPAK_XDG_CONFIG_HOME?.trim();
  const probes: Record<string, () => boolean> = {
    "aider-desk": () => pathExists(join(homeDirectory, '.aider-desk')),
    "amp": () => pathExists(join(configHome, 'amp')),
    "antigravity": () => pathExists(join(homeDirectory, '.gemini/antigravity')),
    "antigravity-cli": () => pathExists(join(homeDirectory, '.gemini/antigravity-cli')),
    "astrbot": () => pathExists(join(workingDirectory, 'data/skills')) || pathExists(join(homeDirectory, '.astrbot')),
    "autohand-code": () => pathExists(autohandHome),
    "augment": () => pathExists(join(homeDirectory, '.augment')),
    "bob": () => pathExists(join(homeDirectory, '.bob')),
    "claude-code": () => pathExists(claudeHome),
    "openclaw": () => ( pathExists(join(homeDirectory, '.openclaw')) || pathExists(join(homeDirectory, '.clawdbot')) || pathExists(join(homeDirectory, '.moltbot')) ),
    "cline": () => pathExists(join(homeDirectory, '.cline')),
    "codearts-agent": () => pathExists(join(homeDirectory, '.codeartsdoer')),
    "codebuddy": () => pathExists(join(workingDirectory, '.codebuddy')) || pathExists(join(homeDirectory, '.codebuddy')),
    "codemaker": () => pathExists(join(homeDirectory, '.codemaker')),
    "codestudio": () => pathExists(join(homeDirectory, '.codestudio')),
    "codex": () => pathExists(codexHome) || pathExists('/etc/codex'),
    "command-code": () => pathExists(join(homeDirectory, '.commandcode')),
    "continue": () => pathExists(join(workingDirectory, '.continue')) || pathExists(join(homeDirectory, '.continue')),
    "cortex": () => pathExists(join(homeDirectory, '.snowflake/cortex')),
    "crush": () => pathExists(join(homeDirectory, '.config/crush')),
    "cursor": () => pathExists(join(homeDirectory, '.cursor')),
    "deepagents": () => pathExists(join(homeDirectory, '.deepagents')),
    "devin": () => pathExists(join(configHome, 'devin')),
    "dexto": () => pathExists(join(homeDirectory, '.dexto')),
    "droid": () => pathExists(join(homeDirectory, '.factory')),
    "eve": () => {
    const cwd = workingDirectory;
    return (
    pathExists(join(cwd, 'agent')) && packageJsonHasDependency(join(cwd, 'package.json'), 'eve')
    );
    },
    "firebender": () => pathExists(join(homeDirectory, '.firebender')),
    "forgecode": () => pathExists(join(homeDirectory, '.forge')),
    "fx": () => pathExists(join(homeDirectory, '.fx')),
    "gemini-cli": () => pathExists(join(homeDirectory, '.gemini')),
    "github-copilot": () => pathExists(join(homeDirectory, '.copilot')),
    "goose": () => pathExists(join(configHome, 'goose')),
    "grok": () => pathExists(grokHome),
    "hermes-agent": () => pathExists(hermesHome),
    "inference-sh": () => pathExists(join(homeDirectory, '.inferencesh')),
    "jazz": () => pathExists(join(homeDirectory, '.jazz')) || pathExists(join(workingDirectory, '.jazz')),
    "junie": () => pathExists(join(homeDirectory, '.junie')),
    "iflow-cli": () => pathExists(join(homeDirectory, '.iflow')),
    "kilo": () => pathExists(join(homeDirectory, '.kilo')) || pathExists(join(homeDirectory, '.kilocode')),
    "kimchi": () => pathExists(join(homeDirectory, '.config', 'kimchi')),
    "kimi-code-cli": () => pathExists(join(homeDirectory, '.kimi-code')) || pathExists(join(homeDirectory, '.kimi')),
    "kiro-cli": () => pathExists(join(homeDirectory, '.kiro')),
    "kode": () => pathExists(join(homeDirectory, '.kode')),
    "lingma": () => pathExists(join(homeDirectory, '.lingma')),
    "loaf": () => pathExists(join(homeDirectory, '.loaf')),
    "mcpjam": () => pathExists(join(homeDirectory, '.mcpjam')),
    "minimax-code": () => (pathExists(join(homeDirectory, '.minimax')) || pathExists('/Applications/MiniMax Code.app')),
    "mistral-vibe": () => pathExists(vibeHome),
    "moxby": () => pathExists(join(homeDirectory, '.moxby')),
    "mux": () => pathExists(join(homeDirectory, '.mux')),
    "opencode": () => pathExists(join(configHome, 'opencode')),
    "openhands": () => pathExists(join(homeDirectory, '.openhands')),
    "ona": () => pathExists(join(homeDirectory, '.ona')),
    "pi": () => pathExists(join(homeDirectory, '.pi/agent')),
    "posit-assistant": () => (pathExists(join(homeDirectory, '.posit/assistant')) || pathExists(join(homeDirectory, '.positai'))),
    "qoder": () => pathExists(join(homeDirectory, '.qoder')),
    "qoder-cn": () => pathExists(join(homeDirectory, '.qoder-cn')),
    "qwen-code": () => pathExists(join(homeDirectory, '.qwen')),
    "replit": () => pathExists(join(workingDirectory, '.replit')),
    "reasonix": () => pathExists(join(homeDirectory, '.reasonix')),
    "rovodev": () => pathExists(join(homeDirectory, '.rovodev')),
    "roo": () => pathExists(join(homeDirectory, '.roo')),
    "sarvam-code": () => pathExists(sarvamHome),
    "tabnine-cli": () => pathExists(join(homeDirectory, '.tabnine')),
    "terramind": () => pathExists(join(homeDirectory, '.terramind')),
    "tinycloud": () => pathExists(join(homeDirectory, '.tinycloud')),
    "trae": () => pathExists(join(homeDirectory, '.trae')),
    "trae-cn": () => pathExists(join(homeDirectory, '.trae-cn')),
    "warp": () => pathExists(join(homeDirectory, '.warp')),
    "windsurf": () => pathExists(join(homeDirectory, '.codeium/windsurf')),
    "zed": () => ( pathExists(join(configHome, 'zed')) || (!!zedAppDataHome && pathExists(join(zedAppDataHome, 'Zed'))) || (!!zedFlatpakConfigHome && pathExists(join(zedFlatpakConfigHome, 'zed'))) ),
    "zcode": () => (pathExists(join(homeDirectory, '.zcode')) || pathExists('/Applications/ZCode.app')),
    "zencoder": () => pathExists(join(homeDirectory, '.zencoder')),
    "zenflow": () => pathExists(join(homeDirectory, '.zencoder')),
    "neovate": () => pathExists(join(homeDirectory, '.neovate')),
    "pochi": () => pathExists(join(homeDirectory, '.pochi')),
    "promptscript": () => ( pathExists(join(workingDirectory, '.promptscript')) || pathExists(join(workingDirectory, 'promptscript.yaml')) ),
    "adal": () => pathExists(join(homeDirectory, '.adal')),
    "universal": () => false,
  };
  const projectOnly = new Set(["eve","promptscript"]);
  const installed = Object.entries(probes).filter(([, probe]) => probe()).map(([name]) => name);
  return {
    agents: installed.filter(name => !projectOnly.has(name)),
    skippedAgents: installed.filter(name => projectOnly.has(name))
  };
}
