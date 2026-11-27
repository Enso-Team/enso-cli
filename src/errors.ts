import { CANVAS_INTENT_CONTRACT_HINT, CANVAS_INTENT_SCHEMA_EXPECTED, CANVAS_SPEC_CONTRACT_HINT, type EnsoEnvelope } from "@enso-app/core";

const commandHints: Record<string, string> = {
  [CANVAS_INTENT_CONTRACT_HINT]: "Run `enso canvas apply --schema` for the machine-readable contract",
  [CANVAS_SPEC_CONTRACT_HINT]: "Run `enso layout --schema` for the machine-readable canvas spec contract"
};
const commandExpectations: Record<string, string> = { [CANVAS_INTENT_SCHEMA_EXPECTED]: "canvas apply schema" };

const DUPLICATE_LINK_HINT = "Use link update on the existing link id, or pass --mention-index to link create to point a new link at another sentence from its mentions";

const ownOutput = new WeakSet<object>();
/** Marks a command whose action prints its own output and returns no envelope; any other action must return one. */
export function printsOwnOutput<T extends object>(command: T): T {
  ownOutput.add(command);
  return command;
}
export function hasOwnOutput(command: object): boolean { return ownOutput.has(command); }

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

function withRecovery(given: EnsoEnvelope): EnsoEnvelope {
  if (given.ok) return given;
  const { hint: coreHint, expected: coreExpected } = given.error.details ?? {};
  const commandHint = typeof coreHint === "string" ? commandHints[coreHint] : undefined;
  const commandExpected = typeof coreExpected === "string" ? commandExpectations[coreExpected] : undefined;
  const envelope: EnsoEnvelope = commandHint || commandExpected
    ? { ...given, error: { ...given.error, details: { ...given.error.details, ...(commandHint ? { hint: commandHint } : {}), ...(commandExpected ? { expected: commandExpected } : {}) } } }
    : given;
  const hints: Record<string, string> = {
    bridge_instance_mismatch: "A different Enso app instance answers at this bridge address. Check which app you meant before setting ENSO_BRIDGE_INSTANCE_ID again; the CLI has not retried",
    bridge_instance_unavailable: "Update Enso to a build whose /v1/health reports bridgeInstanceID, or unset ENSO_BRIDGE_INSTANCE_ID",
    wrong_vault: "Open the intended vault explicitly in Enso, then inspect it before retrying",
    target_not_found: "Run `enso canvas list` to check the stable canvasID in the intended vault",
    target_not_active: "Open the intended canvas explicitly in Enso. Inspect it before retrying; this command has not switched canvases or replayed mutations",
    target_changed: "Navigation interrupted the operation. Inspect the original target for partial effects before deciding whether to retry",
    explicit_navigation_required: "Run canvas navigation as a separate command without an immutable binding",
    vault_changed: "The vault changed during discovery. Run `enso canvas list` again before retrying"
  };
  const hint = hints[envelope.error.code];
  if (hint && !envelope.error.details?.hint) return { ...envelope, error: { ...envelope.error, details: { ...envelope.error.details, hint } } };
  if (envelope.error.code !== "duplicate_link") return envelope;
  return {
    ok: false,
    error: {
      ...envelope.error,
      details: { ...envelope.error.details, hint: DUPLICATE_LINK_HINT }
    }
  };
}
