/**
 * Processus enfant ordinaire au format `CodexProcess`, sans Job Object ni AppContainer :
 * tests seulement. Un `spawn` ordinaire laisse libuv compléter l'environnement sous
 * Windows (PATH, USERPROFILE…) ; les lanceurs de production construisent un bloc
 * explicite. Optionnellement, chaque ligne échangée est enregistrée.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexCommand, CodexProcess } from "../../../src/adapters/codex/index.js";

export interface TranscriptLine {
  /** `in` : du serveur vers l'adapter ; `out` : de l'adapter vers le serveur. */
  readonly dir: "in" | "out";
  readonly line: string;
}

export class SpawnedCodexProcess implements CodexProcess {
  readonly exited: Promise<number | null>;
  readonly transcript: TranscriptLine[] | null;
  #child: ChildProcess;
  #lines: string[] = [];
  #waiters: ((line: string | null) => void)[] = [];
  #closed = false;
  #done = false;

  constructor(command: CodexCommand, extraEnv: Record<string, string>, record = false) {
    this.transcript = record ? [] : null;
    const env: Record<string, string> = { ...command.env, ...extraEnv };
    const systemRoot = process.env["SystemRoot"];
    if (systemRoot !== undefined) env["SystemRoot"] = systemRoot;
    this.#child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.#child.stdin?.on("error", () => undefined);
    createInterface({ input: this.#child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      this.transcript?.push({ dir: "in", line });
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(line);
      else waiter(line);
    });
    this.#child.stdout?.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
    this.exited = new Promise((resolve) => {
      this.#child.on("close", (code) => {
        this.#done = true;
        resolve(code);
      });
    });
  }

  started(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.#child.pid !== undefined) resolve(this.#child.pid);
      else this.#child.once("error", reject);
    });
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
    if (this.#done) return;
    this.transcript?.push({ dir: "out", line });
    this.#child.stdin?.write(`${line}\n`);
  }

  async terminateTree(): Promise<{ confirmed: boolean; elapsedMs: number }> {
    const begin = performance.now();
    if (!this.#done) this.#child.kill();
    await this.exited;
    return { confirmed: true, elapsedMs: performance.now() - begin };
  }
}
