import type { EnsoEnvelope } from "@enso-app/core";

const DUPLICATE_LINK_HINT = "Use link update on the existing link id instead of link create";

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

/** A runner session's agent cannot navigate or relink, so it stops and reports instead (see src/bridge-binding.ts). */
const runnerHints: Record<string, string> = {
  target_not_active: "The user has another canvas open in Enso. Stop and tell the user: this runner session is bound to its canvas and cannot navigate. The command was not retried",
  bridge_instance_mismatch: "Enso restarted, or another app answers at its bridge address. Stop and tell the user: this runner session stays bound to the app instance it was created with. The command was not retried",
  bridge_instance_unavailable: "The app at the bridge address cannot prove it is this session's instance. Stop and tell the user. The command was not retried",
  wrong_vault: "The user has another vault open in Enso. Stop and tell the user: this runner session cannot open vaults. The command was not retried",
  target_changed: "The user navigated while the command ran. Stop and tell the user; the canvas may hold part of the change. The command was not retried",
  explicit_navigation_required: "This runner session is bound to one canvas. Work only on that canvas, or stop and tell the user what you needed",
  invalid_token: "Enso's pairing changed. Stop and tell the user; a runner session cannot relink the CLI"
};

function withRecovery(envelope: EnsoEnvelope): EnsoEnvelope {
  if (envelope.ok) return envelope;
  const runner = process.env.ENSO_RUNNER_BRIDGE === "bound" ? runnerHints : {};
  const hints: Record<string, string> = {
    bridge_instance_mismatch: "A different Enso app instance answers at this bridge address. Check which app you meant before setting ENSO_BRIDGE_INSTANCE_ID again; the CLI has not retried",
    bridge_instance_unavailable: "Update Enso to a build whose /v1/health reports bridgeInstanceID, or unset ENSO_BRIDGE_INSTANCE_ID",
    wrong_vault: "Open the intended vault explicitly in Enso, then inspect it before retrying",
    target_not_found: "Run `enso canvas list` to check the stable canvasID in the intended vault",
    target_not_active: "Open the intended canvas explicitly in Enso. Inspect it before retrying; this command has not switched canvases or replayed mutations",
    target_changed: "Navigation interrupted the operation. Inspect the original target for partial effects before deciding whether to retry",
    explicit_navigation_required: "Run canvas navigation as a separate command without an immutable binding",
    vault_changed: "The vault changed during discovery. Run `enso canvas list` again before retrying",
    ...runner
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
