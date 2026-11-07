import { expect, it } from "vitest";
import { fingerprintToken, tokenFingerprints, tokenRedactor } from "../../src/runner/redaction.js";

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
