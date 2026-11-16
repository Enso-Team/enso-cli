export type EnsoErrorCode =
  | "app_unavailable"
  | "auth_required"
  | "access_disabled"
  | "cli_outdated"
  | "app_outdated"
  | "bridge_busy"
  | "canvas_changed"
  | "invalid_response"
  | "invalid_input"
  | "link_failed"
  | "ambiguous_selector"
  | string;

export type EnsoErrorBody = {
  code: EnsoErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type EnsoEnvelope<T = unknown> =
  | { ok: true; data: T; text?: string }
  | { ok: false; error: EnsoErrorBody; text?: string };

export class EnsoError extends Error {
  readonly body: EnsoErrorBody;

  constructor(code: EnsoErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EnsoError";
    this.body = { code, message, details };
  }
}

export function errorEnvelope(error: unknown): EnsoEnvelope {
  if (error instanceof EnsoError) {
    return { ok: false, error: error.body };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: error.message,
        details: {}
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "invalid_input",
      message: "Unknown error",
      details: { error }
    }
  };
}

/**
 * An app that predates a route answers it with the bridge's generic missing-route error. A
 * route's own not_found (a missing Mark, Node, or folder) carries its own message.
 */
export function isMissingRoute(error: EnsoErrorBody): boolean {
  return error.code === "not_found" && error.message === "Bridge route not found";
}
