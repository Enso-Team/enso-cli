import { afterEach, describe, expect, it } from "vitest";
import { configDir } from "../src/config.js";
import { defaultVaultIndexRoot } from "../src/vault-index.js";

const home = "/home/agent";

afterEach(() => {
  delete process.env.ENSO_CLI_CONFIG_DIR;
  delete process.env.ENSO_VAULT_INDEX_ROOT;
});

describe("platform paths", () => {
  it.each([
    ["darwin", {}, "/home/agent/Library/Application Support/Enso CLI"],
    ["linux", {}, "/home/agent/.config/Enso CLI"],
    ["linux", { XDG_CONFIG_HOME: "/xdg" }, "/xdg/Enso CLI"],
    ["win32", { APPDATA: "C:/Users/agent/AppData/Roaming" }, "C:/Users/agent/AppData/Roaming/Enso CLI"]
  ] as const)("keeps CLI config on %s %j under %s", (platform, env, expected) => {
    expect(configDir({ platform, home, env })).toBe(expected);
  });

  it.each([
    ["darwin", {}, "/home/agent/Library/Containers/com.kaungzinye.enso/Data/Library/Application Support/Enso/Vaults"],
    ["linux", {}, "/home/agent/.config/Enso/DesktopVaults"],
    ["linux", { XDG_CONFIG_HOME: "/xdg" }, "/xdg/Enso/DesktopVaults"],
    ["win32", { APPDATA: "C:/Users/agent/AppData/Roaming" }, "C:/Users/agent/AppData/Roaming/Enso/DesktopVaults"]
  ] as const)("reads Vault indexes on %s %j from %s", (platform, env, expected) => {
    expect(defaultVaultIndexRoot({ platform, home, env })).toBe(expected);
  });

  it("lets the environment override both", () => {
    process.env.ENSO_CLI_CONFIG_DIR = "/tmp/cli";
    process.env.ENSO_VAULT_INDEX_ROOT = "/tmp/index";
    expect(configDir({ platform: "linux", home, env: {} })).toBe("/tmp/cli");
    expect(defaultVaultIndexRoot({ platform: "linux", home, env: {} })).toBe("/tmp/index");
  });
});
