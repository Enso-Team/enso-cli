import { z } from "zod/v3";
import { isBridgeInstanceID } from "../bridge-binding.js";
import { isLoopbackBridgeUrl } from "../client.js";
import { EnsoCliError } from "../errors.js";
import { parseTarget } from "../targeting.js";

/**
 * Version 2 added Claude sessions, durable native execution identifiers, session uncertainty and structured input.
 * Version 3 added the bridge instance a session pins (`binding.bridgeInstanceID`). It reads version 2 stores unchanged.
 */
export const runnerVersion = 3;
export const runnerVersionHeader = "Enso-Runner-Version";
const id = z.string().min(1).max(128);
const pendingID = z.string().min(1).max(256);
/** Runner-issued session IDs are lowercase; accept any case from clients. */
const sessionID = z.string().uuid().transform(value => value.toLowerCase());
// JSON data is deliberately opaque at the runner/provider boundary.
// Checked by hand: a recursive z.union builds an error for every failed branch at every node, and made each read of a
// stored run ~150µs. Only values JSON.stringify writes as-is pass, so a committed value reloads unchanged.
function isJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!(index in value) || !isJson(value[index])) return false;
    return true;
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJson);
}
const json = z.custom<Json>(isJson, "Expected a JSON value");
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
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
  workingDirectory: z.string().min(1),
  /**
   * Stored: the instance the runner read from the bridge's /v1/health when it created the session; absent on sessions
   * that pinned none (the bridge stays disabled for them). On creation: optional, the instance the client expects the
   * runner to pin.
   */
  bridgeInstanceID: z.string().refine(isBridgeInstanceID, "Expected the bridge instance ID the app advertises on /v1/health").optional()
}).strict();
export const providerNames = ["fake", "claude"] as const;
export const providerNameSchema = z.enum(providerNames);
/** `provider` is optional and must name the runner's provider: a client can assert which one will run the session. */
export const sessionInputSchema = z.object({ binding: bindingSchema, provider: providerNameSchema.optional() }).strict();
export const contextSchema = z.object({
  selectedNodes: z.array(z.object({ nodeID: id, noteID: id.optional(), content: z.string() }).strict())
}).strict();
export const fakeOptionsSchema = z.object({
  scenario: z.enum(["success", "failure", "permission", "input", "interrupted"]),
  delayMs: z.number().int().min(0).max(60_000).default(20)
}).strict();
export const defaultFakeOptions = { scenario: "success", delayMs: 20 } as const;
export const promptSchema = z.object({
  requestID: id,
  sessionID,
  text: z.string().min(1),
  context: contextSchema,
  /** Test controls, accepted only for fake sessions; the runner fills the default for them before storing. */
  fake: fakeOptionsSchema.optional(),
  /** Required exactly when the session is uncertain: names its uncertain run and how to continue. */
  recovery: z.object({ after: id, mode: z.enum(["resume", "fresh"]) }).strict().optional()
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
const questionSchema = z.object({
  id: z.string().min(1), header: z.string(), question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() }).strict()), multiSelect: z.boolean()
}).strict();
/** `questions`: an input request with structured questions, answered by an object keyed by question id. */
export const pendingSchema = z.object({
  id: pendingID, kind: z.enum(["permission", "input"]), message: z.string(), choices: z.array(z.string()).optional(),
  questions: z.array(questionSchema).min(1).optional(), details: z.record(json).optional()
}).strict();
export const answerSchema = z.object({
  pendingID, value: z.union([z.string(), z.record(z.union([z.string(), z.array(z.string())]))])
}).strict();
/** The storage schema's CHECK, index and triggers are built from these lists. */
export const activeStatuses = ["accepted", "running", "waiting_permission", "waiting_input", "stopping"] as const;
export const terminalStatuses = ["completed", "failed", "cancelled", "interrupted"] as const;
export const runStatusSchema = z.enum([...activeStatuses, ...terminalStatuses]);
export const errorSchema = z.object({ code: z.string(), message: z.string(), details: z.record(json).optional() }).strict();
// Provider output is validated before commit so a durable write can never produce state that fails to reload.
// providerState is the session's conversation checkpoint: any confirmed outcome may carry it (a failed or cancelled
// turn can still have created or advanced the provider's conversation). An interrupted outcome never does.
export const outcomeSchema = z.union([
  z.object({ status: z.literal("completed"), result: json, providerState: json.optional() }).strict(),
  z.object({ status: z.literal("failed"), error: errorSchema, providerState: json.optional() }).strict(),
  z.object({ status: z.literal("cancelled"), providerState: json.optional() }).strict(),
  z.object({ status: z.literal("interrupted"), error: errorSchema }).strict()
]);
/** Set while the session's latest uncertain run is unreconciled: the run and the native identifiers it recorded. */
export const uncertainSchema = z.object({ requestID: id, native: json.optional() }).strict();
export const sessionSchema = z.object({
  id: sessionID, binding: bindingSchema, provider: providerNameSchema, createdAt: z.string(),
  providerState: json.optional(), uncertain: uncertainSchema.optional()
}).strict();
/** `native`: provider execution identifiers, committed before the provider relies on them and kept to the end. */
export const runSchema = z.object({
  request: promptSchema, status: runStatusSchema, createdAt: z.string(), updatedAt: z.string(),
  pending: pendingSchema.optional(), result: json.optional(), error: errorSchema.optional(),
  providerState: json.optional(), native: json.optional()
}).strict();
const sequence = z.number().int().positive();
// Deltas: run_accepted is the only event carrying a request; updates replace every mutable field (absent = cleared).
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ sequence, type: z.literal("session_created"), session: sessionSchema }).strict(),
  z.object({ sequence, type: z.literal("session_updated"), sessionID, providerState: json.optional(), uncertain: uncertainSchema.optional() }).strict(),
  z.object({ sequence, type: z.literal("run_accepted"), run: runSchema }).strict(),
  runSchema.omit({ request: true, createdAt: true }).extend({ sequence, type: z.literal("run_updated"), requestID: id }),
  // Retention removed these finished runs and their events.
  z.object({ sequence, type: z.literal("runs_deleted"), requestIDs: z.array(id).min(1) }).strict()
]);
export type Binding = z.infer<typeof bindingSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;
export type Prompt = z.infer<typeof promptSchema>;
export type Pending = z.infer<typeof pendingSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type ProviderName = z.infer<typeof providerNameSchema>;
export type FakeOptions = z.infer<typeof fakeOptionsSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunnerEvent = z.infer<typeof eventSchema>;
export type Change = RunnerEvent extends infer E ? E extends RunnerEvent ? Omit<E, "sequence"> : never : never;
export function terminal(status: Run["status"]): boolean {
  return (terminalStatuses as readonly string[]).includes(status);
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
