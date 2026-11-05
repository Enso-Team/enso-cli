import { describe, expect, it } from "vitest";
import { eventSchema, parse, promptSchema, sessionInputSchema, snapshotSchema, submitSchema } from "../../src/runner/protocol.js";

const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const binding = { bridgeUrl: "http://127.0.0.1:17650", canvasTarget: { vaultID: "vault", canvasID: "canvas" }, workingDirectory: "/tmp" };

describe("protocol", () => {
  it("normalizes session IDs to lowercase", () => {
    const prompt = parse(promptSchema, { requestID: "r", sessionID: upper, text: "x", context: { selectedNodes: [] } });
    expect(prompt.sessionID).toBe(upper.toLowerCase());
    expect(eventSchema.parse({ sequence: 1, type: "session_updated", sessionID: upper })).toMatchObject({ sessionID: upper.toLowerCase() });
  });

  it("reports an invalid target as an issue, and as invalid_target from parse()", () => {
    const snapshot = { storageVersion: 2, sequence: 1, runs: [], sessions: [{ id: upper, binding, provider: "fake", createdAt: "" }] };
    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(() => parse(sessionInputSchema, { binding })).toThrow(expect.objectContaining({
      body: expect.objectContaining({ code: "invalid_target", message: "canvasTarget must contain exactly vaultID and canvasID UUID strings" })
    }));
  });

  it("rejects unaddressable request IDs on submission but still loads them from storage", () => {
    const request = (requestID: string) => ({ requestID, sessionID: upper, text: "x", context: { selectedNodes: [] } });
    for (const id of [".", "..", "\ud800"]) {
      expect(() => parse(submitSchema, request(id))).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "invalid_input" }) }));
    }
    const run = { request: { ...request(".."), fake: { scenario: "success", delayMs: 20 } }, status: "waiting_input", createdAt: "", updatedAt: "" };
    expect(snapshotSchema.safeParse({ storageVersion: 2, sequence: 1, sessions: [], runs: [run] }).success).toBe(true);
    expect(eventSchema.safeParse({ sequence: 1, type: "run_updated", requestID: "..", status: "cancelled", updatedAt: "" }).success).toBe(true);
  });
});
