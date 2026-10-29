import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClaudeLaunchSpec, ClaudeProcess } from "../../../src/adapters/claude/index.js";
import type { TreeTermination } from "../../../src/runner/process-tree.js";

/**
 * Processus enfant direct, même forme que les processus contenus (tests seulement) :
 * aucun Job Object ni AppContainer. `onLine` reçoit chaque ligne brute de stdout.
 */
export class ChildClaude implements ClaudeProcess {
  readonly exited: Promise<{ readonly mainExitCode: number | null }>;
  readonly #child;
  readonly #lines: string[] = [];
  readonly #waiters: ((line: string | null) => void)[] = [];
  #closed = false;
  #done = false;

  constructor(
    spec: ClaudeLaunchSpec,
    baseEnv: Readonly<Record<string, string>>,
    onLine?: (line: string) => void,
  ) {
    this.#child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: { ...baseEnv, ...spec.env },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      onLine?.(line);
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(line);
      else waiter(line);
    });
    this.#child.stdout.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
    this.exited = new Promise((resolve) => {
      this.#child.on("exit", (code) => {
        this.#done = true;
        resolve({ mainExitCode: code });
      });
    });
  }

  started(): Promise<number> {
    return Promise.resolve(this.#child.pid ?? 0);
  }

  get hasExited(): boolean {
    return this.#done;
  }

  readLine(): Promise<string | null> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  send(line: string): void {
    this.#child.stdin.write(`${line}\n`);
  }

  async terminateTree(): Promise<TreeTermination> {
    const begin = performance.now();
    if (this.#done) {
      return { confirmed: true, elapsedMs: 0, kernelMs: null, via: "already_exited" };
    }
    this.#child.kill("SIGKILL");
    await this.exited;
    return {
      confirmed: true,
      elapsedMs: performance.now() - begin,
      kernelMs: null,
      via: "kill_command",
    };
  }
}
