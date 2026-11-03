import { z } from "zod";
import { isLoopbackBridgeUrl } from "../client.js";
import { EnsoCliError } from "../errors.js";
import { parseTarget } from "../targeting.js";

export const runnerVersion = 1;
export const runnerVersionHeader = "Enso-Runner-Version";
const id = z.string().min(1).max(128);
const pendingID = z.string().min(1).max(256);
const target = z.unknown().transform(value => parseTarget(value));
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
  sessionID: z.string().uuid(),
  text: z.string().min(1),
  context: contextSchema,
  fake: z.object({
    scenario: z.enum(["success", "failure", "permission", "input", "interrupted"]),
    delayMs: z.number().int().min(0).max(60_000).default(20)
  }).strict().default({ scenario: "success", delayMs: 20 })
}).strict();
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
  id: z.string().uuid(), binding: bindingSchema, provider: z.literal("fake"), createdAt: z.string(),
  providerState: json.optional()
}).strict();
export const runSchema = z.object({
  request: promptSchema, status: runStatusSchema, createdAt: z.string(), updatedAt: z.string(),
  pending: pendingSchema.optional(), result: json.optional(), error: errorSchema.optional(),
  providerState: json.optional()
}).strict();
export const eventSchema = z.object({ sequence: z.number().int().positive(), run: runSchema }).strict();
export const stateSchema = z.object({
  storageVersion: z.literal(1), sequence: z.number().int().nonnegative(),
  sessions: z.array(sessionSchema), runs: z.array(runSchema), events: z.array(eventSchema)
}).strict();
export type Binding = z.infer<typeof bindingSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Prompt = z.infer<typeof promptSchema>;
export type Pending = z.infer<typeof pendingSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type Run = z.infer<typeof runSchema>;
export type State = z.infer<typeof stateSchema>;
export type RunnerEvent = z.infer<typeof eventSchema>;
export function terminal(status: Run["status"]): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}
export function invalid(message: string): never { throw new EnsoCliError("invalid_input", message); }
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) invalid(result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return result.data;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
