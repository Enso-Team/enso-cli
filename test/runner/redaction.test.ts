import { expect, it } from "vitest";
import { fingerprintToken, redactedTextTail, tokenFingerprints, tokenRedactor } from "../../src/runner/redaction.js";

it("redacts nested strings and keys using persisted fingerprints, including Unicode and overlapping credentials", () => {
  const fingerprints = ["abc", "bcde", "🔐token", "other-secret"].map(fingerprintToken);
  const saved = JSON.parse(JSON.stringify({ bridgeTokenRedactions: fingerprints }));
  const scrub = tokenRedactor(tokenFingerprints(saved)!);
  expect(scrub({ abcde: ["xabcdey", "🔐token / other-secret / 🔐token"], untouched: 123 })).toEqual({
    "[redacted]": ["x[redacted]y", "[redacted] / [redacted] / [redacted]"], untouched: 123
  });
  expect(JSON.stringify(saved)).not.toContain("other-secret");
});

it("confirms rolling-hash matches cryptographically", () => {
  // Both pairs have the same polynomial hash at base 31, but are different credentials.
  expect(fingerprintToken("Aa").rolling).toBe(fingerprintToken("BB").rolling);
  expect(tokenRedactor([fingerprintToken("Aa")])("BB Aa BB")).toBe("BB [redacted] BB");
});

it("scans large outputs while hashing only candidate windows", () => {
  const token = "a-long-pairing-token";
  const text = "x".repeat(1024 * 1024) + token + "y".repeat(1024 * 1024);
  expect(tokenRedactor([fingerprintToken(token)])(text)).toBe("x".repeat(1024 * 1024) + "[redacted]" + "y".repeat(1024 * 1024));
});

it("redacts a token crossing both chunk boundaries and the start of a bounded tail", () => {
  const token = "fixture-pairing-token";
  const tail = redactedTextTail([fingerprintToken(token)], 64);
  tail.append("discarded prefix " + token.slice(0, 8));
  tail.append(token.slice(8) + "x".repeat(64 - token.length + 1));
  expect(tail.read()).toBe("[redacted]" + "x".repeat(64 - token.length + 1));
  expect(tail.read()).not.toContain(token.slice(1));
});

it("does not pull a fragment from discarded lookbehind into view when other redactions shorten the tail", () => {
  const token = "fixture-pairing-token";
  const tail = redactedTextTail([fingerprintToken(token)], 64);
  // The retained lookbehind itself starts inside the first token; all of it must stay outside the output window.
  tail.append(token.repeat(4) + "xxxx");
  expect(tail.read()).toBe("[redacted]".repeat(3) + "xxxx");
});

it("keeps overlapping matches redacted and bounds output even for tokens longer than the tail", () => {
  const tail = redactedTextTail(["abc", "bcde", "a-long-fixture-credential"].map(fingerprintToken), 12);
  tail.append("abc");
  tail.append("de");
  expect(tail.read()).toBe("[redacted]");
  tail.append(" a-long-fixture-");
  tail.append("credential");
  expect(tail.read()).toBe("[redacted]");
});

it("keeps the ordinary text tail when no credentials are known", () => {
  const tail = redactedTextTail([], 8);
  tail.append("discarded");
  tail.append(" retained");
  expect(tail.read()).toBe("retained");
});
