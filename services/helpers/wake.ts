/**
 * Réveil d'une session Claude Code ou Codex par leurs interfaces officielles non
 * interactives, sans modifier la conversation d'origine :
 *
 * - Claude Code : fork éphémère avec les outils natifs et réglages habituels ;
 * - Codex : reprise éphémère avec les réglages habituels, réponse finale par `-o`.
 *
 * Le prompt passe par l'entrée standard. Délai borné ; la sortie est tronquée.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionDoc } from "./sessions.js";

export const WAKE_TIMEOUT_MS = 300_000;
export const MAX_ANSWER_CHARS = 4000;

export interface WakeResult {
  readonly ok: boolean;
  readonly text: string;
  readonly detail: string;
}

/** Session à réveiller : outil, identifiant et dossier de travail. */
export type WakeTarget = Pick<SessionDoc, "runtime" | "sessionId" | "cwd">;

export type Waker = (session: WakeTarget, prompt: string) => Promise<WakeResult>;

function claudeExe(): string {
  return (
    process.env["MIND_WAKE_CLAUDE_EXE"] ?? path.join(os.homedir(), ".local", "bin", "claude.exe")
  );
}

function codexExe(): string {
  return (
    process.env["MIND_WAKE_CODEX_BIN"] ??
    path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "OpenAI", "Codex", "bin", "codex.exe")
  );
}

function run(
  exe: string,
  args: readonly string[],
  cwd: string,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, [...args], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), WAKE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

const clip = (s: string): string => s.trim().slice(0, MAX_ANSWER_CHARS);

export function claudeAdviceArgs(sessionId:string):string[] {
 return ["--resume",sessionId,"--fork-session","--no-session-persistence","-p","--tools","default","--output-format","json"];
}
export function codexAdviceArgs(sessionId:string,outFile:string):string[] {
 return ["exec","resume","--ephemeral","--skip-git-repo-check","-o",outFile,sessionId,"-"];
}

export const officialWaker: Waker = async (session, prompt) => {
  if (!fs.existsSync(session.cwd)) {
    return { ok: false, text: "", detail: `dossier de la session introuvable : ${session.cwd}` };
  }
  if (session.runtime === "claude") {
    const r = await run(
      claudeExe(),
      claudeAdviceArgs(session.sessionId),
      session.cwd,
      prompt,
    );
    try {
      const out = JSON.parse(r.stdout) as { result?: unknown; is_error?: unknown };
      if (out.is_error === true || typeof out.result !== "string") {
        return {
          ok: false,
          text: "",
          detail: `claude : ${(typeof out.result === "string" ? out.result : r.stderr).slice(0, 300)}`,
        };
      }
      return { ok: true, text: clip(out.result), detail: "claude" };
    } catch {
      return {
        ok: false,
        text: "",
        detail: `claude (code ${String(r.code)}) : ${r.stderr.slice(0, 300)}`,
      };
    }
  }
  const outFile = path.join(
    os.tmpdir(),
    `mind-wake-helper-${String(process.pid)}-${String(Date.now())}.txt`,
  );
  try {
    const r = await run(
      codexExe(),
      codexAdviceArgs(session.sessionId,outFile),
      session.cwd,
      prompt,
    );
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
    if (text.trim() === "") {
      return {
        ok: false,
        text: "",
        detail: `codex (code ${String(r.code)}) : ${r.stderr.slice(-300)}`,
      };
    }
    return { ok: true, text: clip(text), detail: "codex" };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
};
