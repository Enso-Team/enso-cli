// A stand-in `codex app-server` for tests that need a real process (the transport, the CLI, the packed bundle).
// Plain JavaScript so any supported Node runs it without a loader. ENSO_MOCK_MODE selects its behavior:
// - transcript (default): plays the inbound side of an Enso Codex replay transcript (ENSO_MOCK_TRANSCRIPT). Each line it
//   reads stands for the next expected outbound frame, unchecked; it then writes the inbound entries that follow, with
//   `<workspace>` as its working directory. Closing stdin plays `stdin.close`; a runtime_exit ends the process.
// - crash: answers the first request, writes an error to stderr and exits with code 3.
// - garbage: answers the first request with a line that is not JSON, then waits for stdin to close.
// - stubborn: ignores stdin's end and SIGTERM, starts `sleep` in its own process group, and writes both pids to
//   ENSO_MOCK_PIDS.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.ENSO_MOCK_MODE ?? "transcript";
const send = frame => process.stdout.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`);
const lines = createInterface({ input: process.stdin });

if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(process.env.ENSO_MOCK_PIDS, JSON.stringify({ server: process.pid, child: sleeper.pid }));
  lines.on("line", line => { const { id } = JSON.parse(line); if (id !== undefined) send({ id, result: { userAgent: "mock/0", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } }); });
  setInterval(() => {}, 1000);
} else if (mode === "crash" || mode === "garbage") {
  lines.once("line", line => {
    if (mode === "garbage") return send("this is not { json");
    process.stderr.write("fatal: the mock crashed\n");
    process.exit(3);
  });
  lines.on("close", () => process.exit(0));
} else {
  const workspace = realpathSync(process.cwd());
  const materialize = value => {
    if (value === "<workspace>") return workspace;
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materialize(entry)]));
    return value;
  };
  const entries = readFileSync(process.env.ENSO_MOCK_TRANSCRIPT, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).slice(1)
    .filter(entry => !(entry.type === "expect_outbound" && entry.frame.type === "process.spawn"));
  let cursor = 0;
  const play = () => {
    for (; cursor < entries.length; cursor++) {
      const entry = entries[cursor];
      if (entry.type === "expect_outbound") return;
      if (entry.type === "runtime_exit") process.exit(entry.status === "success" ? 0 : 1);
      send(materialize(entry.frame));
    }
  };
  const consume = () => { if (entries[cursor]?.type === "expect_outbound") cursor++; play(); };
  lines.on("line", line => { if (line.trim()) consume(); });
  lines.on("close", () => { consume(); process.exit(0); });
}
