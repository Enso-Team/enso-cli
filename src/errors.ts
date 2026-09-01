export type EnsoErrorCode =
  | "app_unavailable"
  | "auth_required"
  | "access_disabled"
  | "bridge_busy"
  | "canvas_changed"
  | "invalid_response"
  | "invalid_input"
  | "pairing_failed"
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

export class EnsoCliError extends Error {
  readonly body: EnsoErrorBody;

  constructor(code: EnsoErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EnsoCliError";
    this.body = { code, message, details };
  }
}

export function errorEnvelope(error: unknown): EnsoEnvelope {
  if (error instanceof EnsoCliError) {
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
      message: "Unknown CLI error",
      details: { error }
    }
  };
}

const DUPLICATE_LINK_HINT = "Use link update on the existing link id instead of link create";

export function printEnvelope(
  envelope: EnsoEnvelope,
  pretty = false,
  stream: NodeJS.WritableStream = process.stdout
): void {
  if (!pretty && envelope.ok && envelope.text) {
    stream.write(envelope.text);
    if (!envelope.text.endsWith("\n")) stream.write("\n");
    return;
  }

  const recoveredEnvelope = withRecovery(envelope);
  const { text: _text, ...serializableEnvelope } = recoveredEnvelope;
  stream.write(JSON.stringify(serializableEnvelope, null, pretty ? 2 : 0));
  stream.write("\n");
}

function withRecovery(envelope: EnsoEnvelope): EnsoEnvelope {
  if (envelope.ok || envelope.error.code !== "duplicate_link") return envelope;
  return {
    ok: false,
    error: {
      ...envelope.error,
      details: { ...envelope.error.details, hint: DUPLICATE_LINK_HINT }
    }
  };
}
