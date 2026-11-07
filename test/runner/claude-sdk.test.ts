import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { permissionRequest, permissionResultFromDecision, sdkUserInputAnswers, userInputQuestions } from "../../src/runner/claude-sdk.js";

const callback = (options: Partial<Parameters<CanUseTool>[2]> = {}): Parameters<CanUseTool>[2] =>
  ({ signal: new AbortController().signal, toolUseID: "toolu_x", requestId: "req_x", ...options });

it("keys AskUserQuestion questions by their untrimmed text so answers round-trip", () => {
  const questions = userInputQuestions({ questions: [
    { question: " Which DB?", header: "DB", options: [{ label: "Postgres", description: "" }], multiSelect: false },
    { question: "   ", header: "Blank", options: [] }
  ] });
  expect(questions).toEqual([{ id: " Which DB?", header: "DB", question: " Which DB?", options: [{ label: "Postgres", description: "Postgres" }], multiSelect: false }]);
  expect(sdkUserInputAnswers({ [questions[0].id]: ["Postgres", "SQLite"] })).toEqual({ " Which DB?": "Postgres, SQLite" });
});

it("declines a denied tool without interrupting the turn", () => {
  expect(permissionResultFromDecision({ toolName: "Bash", decision: "deny", toolInput: { command: "ls" }, toolUseID: "t" }))
    .toEqual({ behavior: "deny", message: "User declined tool execution.", toolUseID: "t", decisionClassification: "user_reject" });
});

it("withholds the session grant when the CLI suppresses always-allow", () => {
  expect(permissionRequest("Bash", { command: "ls" }, callback({ suppressAlwaysAllowRule: true })).choices).toEqual(["allow", "deny"]);
  expect(permissionRequest("Bash", { command: "ls" }, callback()).choices).toEqual(["allow", "allow_session", "deny"]);
});

it("strips terminal escapes from the decision reason", () => {
  expect(permissionRequest("Bash", { command: "ls" }, callback({ decisionReason: "\x1b[31mrisky\x1b[0m " })).reason).toBe("risky");
});

it("uses the title as the message when there is no command, ahead of the description and reason", () => {
  const request = permissionRequest("Write", { file_path: "a.txt" }, callback({ title: "Write a.txt", description: "Creates a file", decisionReason: "outside the workspace" }));
  expect(request).toMatchObject({ message: "Write a.txt", reason: "outside the workspace" });
});

it("grants a session rule for the tool when the CLI suggests none", () => {
  expect(permissionResultFromDecision({ toolName: "Bash", decision: "allow_session", toolInput: { command: "ls" }, toolUseID: "toolu_x" })).toEqual({
    behavior: "allow", updatedInput: { command: "ls" }, toolUseID: "toolu_x", decisionClassification: "user_permanent",
    updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }]
  });
});
