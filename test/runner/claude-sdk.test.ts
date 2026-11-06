import { expect, it } from "vitest";
import { permissionResultFromDecision, sdkUserInputAnswers, userInputQuestions } from "../../src/runner/claude-sdk.js";

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
