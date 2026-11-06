import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerCall } from "../../src/runner/client.js";
import { startRunner, type RunnerService } from "../../src/runner/service.js";
import { FakeProvider, type Execution } from "../../src/runner/provider.js";
import { RunnerStorage } from "../../src/runner/storage.js";
import { RunnerEngine } from "../../src/runner/engine.js";
import { applyEvents, durable, empty, type Replica } from "./replica.js";

let directory: string;
let child: ChildProcess | undefined;
let service: RunnerService | undefined;
const binding = () => ({ bridgeUrl: "http://127.0.0.1:17650", canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
}, workingDirectory: realpathSync(directory) });
const call = (method: string, path: string, body?: unknown) => runnerCall(method, path, body, directory);
const count = () => { try { return Number(readFileSync(join(directory, "executions"), "utf8")); } catch { return 0; } };
class CountingFake extends FakeProvider {
  override execute(execution: Execution) {
    writeFileSync(join(directory, "executions"), String(count() + 1));
    return super.execute(execution);
  }
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "enso-crash-")); });
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "exit"); child.kill("SIGKILL"); await closed;
  }
  child = undefined;
  await service?.stop(); service = undefined;
  rmSync(directory, { recursive: true, force: true });
});
async function launch(boundary: string) {
  child = spawn(process.execPath, ["--import", "tsx", "test/runner/crash-child.ts", directory, boundary], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr!.on("data", chunk => { errors += chunk; });
  await new Promise<void>((resolve, reject) => {
    child!.stdout!.once("data", () => resolve());
    child!.once("exit", () => reject(new Error(`Runner exited before ready: ${errors}`)));
    child!.once("error", reject);
  });
}
async function waitStatus(wanted: string) {
  for (let n = 0; n < 200; n++) {
    const result = await call("GET", "/v1/runs/crash");
    if (result.ok && (result.data as any).status === wanted) return result.data as any;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Expected ${wanted}`);
}

describe("real process crash recovery", () => {
  it.each([
    "accepted", "running", "before_completed", "mid_completed", "completed", "checkpointed", "waiting_input", "stopping"
  ])("recovers at %s without duplicate execution", async boundary => {
    await launch(boundary);
    const session = await call("POST", "/v1/sessions", { binding: binding() });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const p = { requestID: "crash", sessionID: (session.data as any).id, text: "Persist me", context: {
      selectedNodes: [{ nodeID: "selected", content: "Captured before crash" }]
    }, fake: { scenario: ["waiting_input", "stopping"].includes(boundary) ? "input" : "success", delayMs: 5 } };
    const exited = once(child!, "exit");
    const submitted = call("POST", "/v1/prompts", p).catch(error => error);
    if (boundary === "stopping") {
      await submitted;
      await waitStatus("waiting_input");
      await call("POST", "/v1/runs/crash/cancel").catch(() => {});
    }
    await exited;
    await submitted;
    expect(child!.signalCode).toBe("SIGKILL");
    const before = count();
    expect(before).toBe(["accepted", "running"].includes(boundary) ? 0 : 1);
    service = await startRunner({ directory, provider: new CountingFake() });
    const wanted = ["accepted", "completed", "checkpointed"].includes(boundary) ? "completed" : "interrupted";
    const recovered = await waitStatus(wanted);
    // The binding and captured context survive exactly as submitted.
    expect(recovered.request).toEqual(p);
    expect((await call("GET", `/v1/sessions/${p.sessionID}`) as any).data.binding).toEqual(binding());
    expect(recovered.pending).toBeUndefined();
    expect(count()).toBe(boundary === "accepted" ? 1 : before);
    const duplicate = await call("POST", "/v1/prompts", p);
    expect(duplicate).toEqual({ ok: true, data: recovered });
    expect(count()).toBe(boundary === "accepted" ? 1 : before);
    // Clients rebuild state from a snapshot plus the deltas after its cursor.
    let replica: Replica = empty();
    for (;;) {
      const page = (await call("GET", `/v1/events?after=${replica.cursor}`) as any).data;
      if (!page.events.length) break;
      replica = applyEvents(replica, page.events);
    }
    const snapshot = (await call("GET", "/v1/snapshot") as any).data;
    expect(replica).toEqual(snapshot);
    expect(durable(directory)).toEqual(snapshot);
    expect(replica.runs.find(run => run.request.requestID === "crash")).toEqual(recovered);
    // The completion transaction is atomic: the result and session checkpoint survive together or not at all.
    expect(replica.sessions.find(s => s.id === p.sessionID)!.providerState).toEqual(wanted === "completed" ? { turn: 1 } : undefined);
    if (wanted === "interrupted") expect(recovered.error.code).toBe("restart_uncertain");
    else expect(recovered.result).toMatchObject({ context: p.context, text: "Fake response: Persist me" });
  }, 15_000);
});

describe("storage recovery guards", () => {
  it("recovers pending accepted work with normalized fake defaults", async () => {
    const storage = new RunnerStorage(directory); storage.acquire();
    const engine = new RunnerEngine(storage, new FakeProvider(), { autoDispatch: false });
    const s = engine.createSession({ binding: binding() });
    engine.submit({ requestID: "crash", sessionID: s.id, text: "A", context: { selectedNodes: [] } });
    storage.release();
    service = await startRunner({ directory });
    const done = await waitStatus("completed");
    expect(done.request.fake.scenario).toBe("success");
  });

  it("refuses malformed owner records", async () => {
    symlinkSync("not-a-pid", join(directory, "owner"));
    await expect(startRunner({ directory })).rejects.toMatchObject({ body: { code: "runner_locked" } });
  });
});
