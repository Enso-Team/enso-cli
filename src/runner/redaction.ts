import { createHash } from "node:crypto";
import { z } from "zod/v3";

/** Non-reversible token fingerprints, safe to retain with the conversation instead of retaining credentials. */
const fingerprintSchema = z.object({
  length: z.number().int().positive(), rolling: z.number().int().min(0).max(0xffffffff),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type TokenFingerprint = z.infer<typeof fingerprintSchema>;
const fingerprintsSchema = z.array(fingerprintSchema);
const base = 31;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Missing on conversations created before historical token redaction was introduced. */
export function tokenFingerprints(state: unknown): TokenFingerprint[] | undefined {
  const value = (state as { bridgeTokenRedactions?: unknown } | null | undefined)?.bridgeTokenRedactions;
  return value === undefined ? undefined : fingerprintsSchema.parse(value);
}

/** Conversations whose complete credential history is covered, including an attempted fresh recovery. */
export function redactedConversations(state: unknown): string[] {
  const value = (state as { bridgeTokenRedactionConversations?: unknown } | null | undefined)?.bridgeTokenRedactionConversations;
  return value === undefined ? [] : z.array(z.string().min(1)).parse(value);
}

export function fingerprintToken(token: string): TokenFingerprint {
  let rolling = 0;
  for (let index = 0; index < token.length; index++) rolling = (Math.imul(rolling, base) + token.charCodeAt(index)) >>> 0;
  return { length: token.length, rolling, sha256: digest(token) };
}

/**
 * Match old credentials without knowing their plaintext. Rolling hashes screen windows in linear time per distinct
 * token length; SHA-256 confirms only hash hits. Overlapping matches are merged so one replacement cannot hide another.
 */
export function tokenRedactor(fingerprints: TokenFingerprint[]): <T>(value: T) => T {
  const lengths = new Map<number, Map<number, Set<string>>>();
  for (const { length, rolling, sha256 } of fingerprints) {
    if (!lengths.has(length)) lengths.set(length, new Map());
    const hashes = lengths.get(length)!;
    if (!hashes.has(rolling)) hashes.set(rolling, new Set());
    hashes.get(rolling)!.add(sha256);
  }
  const redactString = (text: string): string => {
    const matches: { start: number; end: number }[] = [];
    for (const [length, hashes] of lengths) {
      if (length > text.length) continue;
      let rolling = 0, power = 1;
      for (let index = 0; index < length; index++) {
        rolling = (Math.imul(rolling, base) + text.charCodeAt(index)) >>> 0;
        if (index) power = Math.imul(power, base) >>> 0;
      }
      for (let start = 0; start <= text.length - length; start++) {
        const candidates = hashes.get(rolling);
        if (candidates?.has(digest(text.slice(start, start + length)))) matches.push({ start, end: start + length });
        if (start < text.length - length) {
          rolling = (Math.imul((rolling - Math.imul(text.charCodeAt(start), power)) >>> 0, base) + text.charCodeAt(start + length)) >>> 0;
        }
      }
    }
    if (!matches.length) return text;
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let output = "", through = 0;
    for (const match of matches) {
      if (match.start >= through) output += text.slice(through, match.start) + "[redacted]";
      through = Math.max(through, match.end);
    }
    return output + text.slice(through);
  };
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactString(key), scrub(item)]));
    return value;
  };
  return fingerprints.length ? value => scrub(value) as never : value => value;
}
