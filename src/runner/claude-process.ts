import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ProviderCleanupError } from "./provider.js";

/** One SDK query's process group. SDK close()/asyncDispose only request or briefly await cleanup; neither proves
 * that the process has exited. Keep that proof separately, including children of an already exited leader. */
export class ClaudeProcessGroup {
  private child?: ChildProcessWithoutNullStreams;
  private ended = false;
  private streamsClosed = false;
  private closing?: Promise<void>;
  private closed = false;

  constructor(private readonly stderr: (data: string) => void, private readonly graceMs = 2000) {}

  readonly spawn: NonNullable<Options["spawnClaudeCodeProcess"]> = options => {
    if (this.closed || this.child) throw new Error("Cannot spawn Claude after cleanup or twice for one query");
    const child = this.child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal,
      detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    child.once("exit", () => { this.ended = true; });
    child.once("close", () => { this.streamsClosed = true; });
    child.once("error", () => { if (child.pid === undefined) this.ended = true; });
    // The custom-spawn hook takes over stderr handling from the SDK's default local spawner.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", this.stderr);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => { /* the SDK observes transport failure */ });
    return child;
  };

  /** Idempotent EOF, TERM, KILL escalation. A failed proof is fatal, and carries a wait the engine must retain before
   * releasing service ownership: an ordinary interrupted outcome would allow another prompt to overlap this group. */
  close(): Promise<void> {
    return this.closing ??= this.cleanup();
  }

  private async cleanup(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    for (const signal of [undefined, "SIGTERM", "SIGKILL"] as const) {
      if (this.gone()) break;
      if (signal) {
        try { if (child.pid !== undefined) process.kill(-child.pid, signal); }
        catch { try { child.kill(signal); } catch { /* checked below, never mistaken for an exit */ } }
      }
      const deadline = Date.now() + this.graceMs;
      while (!this.gone() && Date.now() < deadline) await delay(Math.min(25, deadline - Date.now()));
    }
    if (!this.gone()) {
      throw new ProviderCleanupError("Claude's process group did not exit after SIGKILL; runner stopped accepting work", this.untilGone(), { pid: child.pid ?? null });
    }
    await this.closeStreams();
  }

  private gone(): boolean {
    if (!this.child) return true;
    if (!this.ended) return false;
    if (this.child.pid === undefined) return true;
    try { process.kill(-this.child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }

  private async untilGone(): Promise<void> {
    while (!this.gone()) await delay(100);
    await this.closeStreams();
  }

  private async closeStreams(): Promise<void> {
    // Node can deliver exit before the final stderr bytes. Let them drain, bounded in case a process outside the
    // group inherited the pipe, just as the SDK's default local spawner does.
    const deadline = Date.now() + 200;
    while (!this.streamsClosed && Date.now() < deadline) await delay(10);
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
  }
}
