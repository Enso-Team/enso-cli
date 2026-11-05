import { z } from "zod";
import { isLoopbackBridgeUrl } from "../client.js";
import { EnsoCliError } from "../errors.js";
import { parseTarget } from "../targeting.js";

export const runnerVersion = 1;
export const runnerVersionHeader = "Enso-Runner-Version";
const id = z.string().min(1).max(128);
const pendingID = z.string().min(1).max(256);
/** Runner-issued session IDs are lowercase; accept any case from clients. */
const sessionID = z.string().uuid().transform(value => value.toLowerCase());
/** Reports a bad target as an issue so safeParse stays non-throwing; `parse()` restores its error code. */
const target = z.unknown().transform((value, ctx) => {
  try { return parseTarget(value); } catch (error) {
    if (!(error instanceof EnsoCliError)) throw error;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message, params: { code: error.body.code } });
    return z.NEVER;
  }
});
export const bindingSchema = z.object({
  bridgeUrl: z.string().refine(value => {
    if (!isLoopbackBridgeUrl(value)) return false;
    const url = new URL(value);
    return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  }, "Expected a loopback HTTP bridge origin without credentials").transform(value => new URL(value).origin),
  canvasTarget: target,
  workingDirectory: z.string().min(1)
}).strict();
export const sessionInputSchema = z.object({ binding: bindingSchema }).strict();
export const contextSchema = z.object({
  selectedNodes: z.array(z.object({ nodeID: id, noteID: id.optional(), content: z.string() }).strict())
}).strict();
export const promptSchema = z.object({
  requestID: id,
  sessionID,
  text: z.string().min(1),
  context: contextSchema,
  fake: z.object({
    scenario: z.enum(["success", "failure", "permission", "input", "interrupted"]),
    delayMs: z.number().int().min(0).max(60_000).default(20)
  }).strict().default({ scenario: "success", delayMs: 20 })
}).strict();
/**
 * New request IDs must stay addressable as a /v1/runs/{id} path segment: URL parsers drop "." and ".." (even
 * percent-encoded), and lone surrogates cannot be percent-encoded. Persisted runs keep the looser promptSchema so
 * state written before this rule still loads.
 */
export const submitSchema = promptSchema.extend({
  requestID: id.refine(value => value !== "." && value !== ".." && !/\p{Cs}/u.test(value),
    "requestID must not be \".\" or \"..\" and must be well-formed Unicode")
});
export const pendingSchema = z.object({
  id: pendingID, kind: z.enum(["permission", "input"]), message: z.string(), choices: z.array(z.string()).optional()
}).strict();
export const answerSchema = z.object({ pendingID, value: z.string() }).strict();
export const runStatusSchema = z.enum(["accepted", "running", "waiting_permission", "waiting_input", "stopping", "completed", "failed", "cancelled", "interrupted"]);
// JSON data is deliberately opaque at the runner/provider boundary.
const json: z.ZodType<Json> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(json)]));
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export const errorSchema = z.object({ code: z.string(), message: z.string(), details: z.record(json).optional() }).strict();
// Provider output is validated before commit so a durable write can never produce state that fails to reload.
export const outcomeSchema = z.union([
  z.object({ status: z.literal("completed"), result: json, providerState: json.optional() }).strict(),
  z.object({ status: z.enum(["failed", "interrupted"]), error: errorSchema }).strict(),
  z.object({ status: z.literal("cancelled") }).strict()
]);
export const sessionSchema = z.object({
  id: sessionID, binding: bindingSchema, provider: z.literal("fake"), createdAt: z.string(),
  providerState: json.optional()
}).strict();
export const runSchema = z.object({
  request: promptSchema, status: runStatusSchema, createdAt: z.string(), updatedAt: z.string(),
  pending: pendingSchema.optional(), result: json.optional(), error: errorSchema.optional(),
  providerState: json.optional()
}).strict();
const sequence = z.number().int().positive();
// Deltas: run_accepted is the only event carrying a request; updates replace every mutable field (absent = cleared).
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ sequence, type: z.literal("session_created"), session: sessionSchema }).strict(),
  z.object({ sequence, type: z.literal("session_updated"), sessionID, providerState: json.optional() }).strict(),
  z.object({ sequence, type: z.literal("run_accepted"), run: runSchema }).strict(),
  runSchema.omit({ request: true, createdAt: true }).extend({ sequence, type: z.literal("run_updated"), requestID: id })
]);
/** One log line: every event of one transaction. */
export const transactionSchema = z.object({ events: z.array(eventSchema).min(1) }).strict();
export const storageVersion = 2;
export const snapshotSchema = z.object({
  storageVersion: z.literal(storageVersion), sequence: z.number().int().nonnegative(),
  sessions: z.array(sessionSchema), runs: z.array(runSchema)
}).strict();
export type Binding = z.infer<typeof bindingSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Prompt = z.infer<typeof promptSchema>;
export type Pending = z.infer<typeof pendingSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type Run = z.infer<typeof runSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type RunnerEvent = z.infer<typeof eventSchema>;
export type Change = RunnerEvent extends infer E ? E extends RunnerEvent ? Omit<E, "sequence"> : never : never;
export function terminal(status: Run["status"]): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const coded = result.error.issues.find(issue => issue.code === z.ZodIssueCode.custom && issue.params?.code);
  if (coded?.code === z.ZodIssueCode.custom) throw new EnsoCliError(coded.params!.code, coded.message);
  throw new EnsoCliError("invalid_input", result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
