/**
 * The contract between the Codex provider and its app-server transport. Effect-free: the provider and the CLI depend on
 * this module, and only `codex-app-server.ts`, loaded on demand, brings in Effect and the vendored client. The vendored
 * imports below are types, erased at build time.
 */
import type { Readable, Writable } from "node:stream";
import type * as CodexRpc from "../vendor/effect-codex-app-server/src/rpc.js";

/** The part of a spawned process the transport uses. Tests substitute a replayed one. */
export interface CodexChild {
  readonly pid?: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Whether the process or any member of its process group still exists, even after the leader exits. */
  isAlive(): boolean;
  /** Signals the process and everything it started. */
  kill(signal: NodeJS.Signals): void;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}
export type CodexSpawn = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CodexChild;

export type ClientRequestMethod = CodexRpc.ClientRequestMethod;
export type ServerRequestMethod = CodexRpc.ServerRequestMethod;
export type ServerNotificationMethod = CodexRpc.ServerNotificationMethod;
export type RequestParams<M extends ClientRequestMethod> = CodexRpc.ClientRequestParamsByMethod[M];
export type RequestResponse<M extends ClientRequestMethod> = CodexRpc.ClientRequestResponsesByMethod[M];
export type ServerRequestParams<M extends ServerRequestMethod> = CodexRpc.ServerRequestParamsByMethod[M];
export type ServerRequestResponse<M extends ServerRequestMethod> = CodexRpc.ServerRequestResponsesByMethod[M];
export type NotificationParams<M extends ServerNotificationMethod> = CodexRpc.ServerNotificationParamsByMethod[M];

/**
 * Why a request has no result, by what it proves:
 * - `rejected`: Codex answered with a JSON-RPC error, so it refused the request;
 * - `not_sent`: the request failed validation before it was written, so Codex never saw it;
 * - `malformed`: Codex answered, but not in the shape the schema expects, so it may have acted;
 * - `transport`: the connection ended or was closed first, so Codex may or may not have acted.
 */
export class CodexRequestError extends Error {
  constructor(readonly kind: "rejected" | "not_sent" | "malformed" | "transport", readonly method: string, message: string, readonly rpcCode?: number) {
    super(message);
    this.name = "CodexRequestError";
  }
}

/** How the connection ended. `closed` is the runner's own `close()`. */
export type CodexTermination = {
  code: "codex_exited" | "codex_malformed_message" | "codex_transport_error" | "closed";
  message: string;
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string;
};
/** A log line from the vendored client, such as a notification it dropped because it failed to decode. */
export type CodexDiagnostic = { level: string; message: string; annotations: Record<string, unknown> };

export interface CodexConnection {
  readonly pid: number | undefined;
  request<M extends ClientRequestMethod>(method: M, params: RequestParams<M>): Promise<RequestResponse<M>>;
  notify(method: "initialized"): Promise<void>;
  /** Handlers run in arrival order and must not block; a throw is reported as a diagnostic. */
  onNotification<M extends ServerNotificationMethod>(method: M, handler: (params: NotificationParams<M>) => void): void;
  /** `withdrawn` aborts when Codex resolves the request itself (`serverRequest/resolved`) or the connection closes. */
  onRequest<M extends ServerRequestMethod>(method: M, handler: (params: ServerRequestParams<M>, withdrawn: AbortSignal) => Promise<ServerRequestResponse<M>>): void;
  /** Resolves once, when the connection ends; never rejects. */
  readonly terminated: Promise<CodexTermination>;
  /** The latest standard error output, bounded. */
  stderr(): string;
  /** Rejects outstanding RPCs, ends the Effect scope, closes stdin, then escalates SIGTERM and SIGKILL for the process
   * group, including children of an exited leader. Cleanup is bounded and idempotent. */
  close(): Promise<void>;
}

export type CodexConnectOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onDiagnostic?: (diagnostic: CodexDiagnostic) => void;
  /** How long each cleanup step (stdin EOF, SIGTERM, SIGKILL) waits for the process group to exit. */
  exitGraceMs?: number;
  /** Replaces the real spawn (tests replay a transcript through it). */
  spawn?: CodexSpawn;
};
export type CodexConnect = (options: CodexConnectOptions) => Promise<CodexConnection>;
