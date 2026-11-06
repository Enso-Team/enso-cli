import { describe, expect, it, vi } from "vitest";
import { printsOwnOutput } from "../../src/errors.js";
import { run, setupCliTest } from "../support/cli-harness.js";

// Stands in for a command module: one action that forgets its envelope, one that prints its own output.
vi.mock("../../src/commands/status.js", () => ({
  registerStatus: (program: import("commander").Command) => {
    program.command("forgetful").action(async () => undefined);
    printsOwnOutput(program.command("self-printing")).action(async () => { process.stdout.write("printed\n"); });
  }
}));

setupCliTest();

describe("an action that returns no envelope", () => {
  it("fails instead of exiting 0 silently", async () => {
    const result = await run(["forgetful"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "internal_error", message: "forgetful returned no result" });
  });

  it("succeeds when the command prints its own output", async () => {
    expect(await run(["self-printing"])).toEqual({ stdout: "printed\n", stderr: "", code: 0 });
  });
});
