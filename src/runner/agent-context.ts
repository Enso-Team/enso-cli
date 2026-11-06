import type { Json, Prompt } from "./protocol.js";

/** Child processes inherit this; the `enso` CLI refuses bridge requests while it is set (see src/client.ts). */
export const runnerBridgeEnv = "ENSO_RUNNER_BRIDGE";
/** What every runner agent is told about its situation, whichever provider runs it. */
export const runnerInstructions = [
  "You are running for Enso's local runner, on behalf of a user working on an Enso canvas.",
  "The selected canvas nodes in the prompt were captured when the prompt was submitted; treat them as the selection.",
  "The Enso app bridge is not available to this session: do not use the `enso` CLI or the app's HTTP bridge to read or change canvases."
].join(" ");
const detailsLimit = 32 * 1024;

/**
 * The captured selection as one text block, or undefined without one. Content is sent as submitted except that it
 * cannot close its node or open another; nothing is reread from the canvas.
 */
export function selectionText(context: Prompt["context"]): string | undefined {
  const nodes = context.selectedNodes.map(node => {
    const attributes = `node_id=${JSON.stringify(node.nodeID)}${node.noteID === undefined ? "" : ` note_id=${JSON.stringify(node.noteID)}`}`;
    const content = node.content.replace(/<(\/?enso_node)/gi, "&lt;$1");
    return `<enso_node ${attributes}>\n${content}\n</enso_node>`;
  });
  return nodes.length ? `Selected Enso canvas nodes, captured when this prompt was submitted:\n\n${nodes.join("\n\n")}` : undefined;
}

/** JSON as JSON.stringify writes it: drops undefined and non-plain values. */
export function plain(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
/** A JSON copy for pending-request details, replaced by a preview past 32 KiB. */
export function bounded(value: unknown): Json {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= detailsLimit ? JSON.parse(text) as Json : { truncated: true, preview: text.slice(0, 1024) };
}
