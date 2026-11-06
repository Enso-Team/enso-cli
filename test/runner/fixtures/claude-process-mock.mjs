// A local Claude CLI stand-in driven through the real Agent SDK. No model or network calls.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const mark = name => writeFileSync(name, "ready");
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
let mode;
let prompt;
let child;
const args = process.argv.slice(2);
const argument = name => {
  const index = args.indexOf(`--${name}`);
  return args.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? (index < 0 ? undefined : args[index + 1]);
};
const sessionID = argument("session-id") ?? argument("resume");
const result = cancelled => send({
  type: "result", subtype: "success", session_id: sessionID, uuid: "22222222-2222-4222-8222-222222222222",
  user_message_uuid: prompt.uuid, is_error: false, result: "done", num_turns: 1,
  duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, stop_reason: "end_turn",
  terminal_reason: cancelled ? "aborted_streaming" : undefined, permission_denials: [], usage: {}, modelUsage: {}
});

setInterval(() => {
  if (existsSync("release")) process.exit(0);
}, 10);
process.on("SIGTERM", () => {
  mark("term");
  if (mode === "orphan-term") process.exit(0);
});

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    if (frame.request.subtype === "interrupt" && mode === "cancel-unanswered") continue;
    send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {} } });
    if (frame.request.subtype === "interrupt" && mode === "cancel") result(true);
  }
  if (frame.type !== "user") continue;
  prompt = frame;
  mode = frame.message.content.at(-1).text;
  if (mode.startsWith("orphan-")) {
    child = spawn(process.execPath, ["-e", `
      process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync('child-ready', 'ready');
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "inherit", "inherit"] });
    while (!existsSync("child-ready")) await new Promise(resolve => setTimeout(resolve, 10));
  }
  writeFileSync("pids.json", JSON.stringify({ server: process.pid, child: child?.pid }));
  if (mode.startsWith("cancel")) continue;
  if (mode === "crash") {
    process.stderr.write("mock Claude crashed\n", () => process.exit(3));
    continue;
  }
  result(false);
}
mark("eof");
if (mode === "orphan-eof") process.exit(0);
