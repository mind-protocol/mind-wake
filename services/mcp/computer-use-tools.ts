/**
 * Outil MCP `computer_use` (mandat NLR du 16 nov. 2026, 14:59) : confie une tâche d'écran à
 * Codex (`codex exec --enable computer_use`), stdin fermé (sinon Codex attend « Reading
 * additional input from stdin… »), dans `<workspace>/artifacts/computer-use/<horodatage>/`.
 * Renvoie le texte final de Codex et les chemins des captures.
 *
 * Cause de l'échec initial (voir output/computer-use/RESULTAT.md) : le helper Windows de Codex
 * applique une politique d'URL aux navigateurs et arrête le tour quand il ne lit pas l'URL avec
 * certitude (about:blank, barre d'adresse en cours de saisie). La consigne impose donc d'ouvrir
 * les URL avec `computer-use-browser.mjs` (Chrome à profil isolé, URL passée au lancement, CDP
 * local pour la preuve) au lieu de taper dans la barre d'adresse.
 *
 * `COMPUTER_USE_TOOLS` est la déclaration commune : le serveur du principal (`server-main.ts`) et
 * celui des rooms (`fork-owner-main.ts`) l'enregistrent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { workspaceDirFor } from "../../src/daemon/paths.js";
import { codexCommand, codexSessionId, nodeProcessRunner, type ProcessRunner } from "./media-tools.js";

import { DESKTOP_TOOLS, registerDesktopTools } from "./desktop-tools.js";

export const COMPUTER_USE_TOOLS = ["computer_use", ...DESKTOP_TOOLS] as const;

/** The principal owns Room 1. Missing host metadata must not select the human desktop. */
export function desktopRoom(env: Readonly<Record<string, string | undefined>>): string {
  const room = env["MIND_WAKE_DESKTOP_ROOM"] ?? env["MIND_WAKE_OWNER_FORK"] ?? env["MIND_WAKE_FORK_ID"] ?? "1";
  if (!/^[1-9]\d*$/.test(room)) throw Error("Invalid desktop room in host configuration.");
  return room;
}

/** Une tâche d'écran : quelques minutes au plus. */
export const COMPUTER_USE_TIMEOUT_MS = 12 * 60_000;
const SHOT_EXT = /\.(png|jpe?g|webp)$/i;

/** Script du navigateur dédié, à côté de ce module. */
export function browserHelperPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "computer-use-browser.mjs");
}

/** Horodatage de dossier : 20261116-153012-ab12. */
export function runStamp(now: Date = new Date(), suffix: string = Math.random().toString(36).slice(2, 6)): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${suffix}`;
}

/** Consigne complète donnée à Codex : règles de sécurité, méthode navigateur, puis la tâche. */
export function computerUseInstruction(
  task: string,
  options: { allowSubmit: boolean; helper: string; profile: string },
): string {
  const helper = `node "${options.helper}"`;
  const submit = options.allowSubmit
    ? "You MAY submit or send only what the task below explicitly asks to submit or send, once. Still never buy, pay, log in, create an account, or enter passwords."
    : "READ-ONLY by default: never click or press publish, post, send, submit, reply, like, buy, pay, sign in or log in controls, and never press Enter in a form that would submit it. If the task needs one of these, stop just before it and say so.";
  return [
    "Use your Windows Computer Use capability (sky API) for this task. Rules:",
    `- ${submit}`,
    "- Never close, minimize or reuse windows or tabs you did not open: the user is at the screen. Never touch terminals, password managers, security settings or authentication dialogs. Never read secret files.",
    "- Browser pages: do NOT type URLs into an address bar (Computer Use's URL policy stops the turn when the browser URL is being edited or is about:blank). Open each URL with this shell command instead:",
    `    ${helper} open <https-url>`,
    `  It opens a NEW window of a dedicated Chrome with an isolated profile (${options.profile}, no account signed in) and prints its title and URL. Then use list_windows (retry once after 2 s on timeout), pick that single window, activate_window it, and work with get_window_state / scroll / click inside it.`,
    `- Screenshots: save every Computer Use screenshot you rely on (state.screenshots[0].url is a data URL, usually JPEG) to the current directory as cu-1.jpg, cu-2.jpg… with node fs. For dedicated-browser pages also run \`${helper} shot page-1.png <url-or-title-part>\` (exact page capture even if covered) and \`${helper} list\` to confirm title and URL.`,
    "- If Computer Use stops the turn or fails, quote the raw error verbatim.",
    "- Final answer: the result, the page title/URL when relevant, and the screenshot file names.",
    "",
    "Task:",
    task.trim(),
  ].join("\n");
}

export function computerUseArgs(dir: string, instruction: string, lastMessageFile: string): string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    "--enable",
    "computer_use",
    "-s",
    "danger-full-access",
    "-C",
    dir,
    "-o",
    lastMessageFile,
    instruction,
  ];
}

/** Texte final de `codex exec` sans `-o` : ce qui suit la dernière ligne « tokens used » + nombre. */
export function finalFromLog(output: string): string {
  const m = /tokens used\r?\n[\d,.\s]*?\r?\n([\s\S]*)$/.exec(output);
  if (m?.[1]) return m[1].trim();
  // Pas de fin normale (plantage, délai) : les dernières lignes du journal, après la consigne.
  const after = output.split(/\r?\n(?=codex\r?\n)/).slice(1).join("\n") || output;
  return after.slice(-1500).trim();
}

export interface ComputerUseResult {
  readonly final: string;
  readonly run_dir: string;
  readonly screenshots: string[];
  readonly exit_code: number | null;
  readonly codex_session: string | null;
  readonly log: string;
}

export async function runComputerUse(
  workspace: string,
  task: string,
  options: {
    allowSubmit?: boolean;
    runner?: ProcessRunner;
    command?: string;
    timeoutMs?: number;
    now?: Date;
  } = {},
): Promise<ComputerUseResult> {
  if (task.trim() === "") throw Error("Tâche vide.");
  const root = fs.realpathSync(workspace);
  const base = path.join(root, "artifacts", "computer-use");
  const runDir = path.join(base, runStamp(options.now));
  fs.mkdirSync(runDir, { recursive: true });
  const allowSubmit = options.allowSubmit === true;
  const instruction = computerUseInstruction(task, {
    allowSubmit,
    helper: browserHelperPath(),
    profile: path.join(base, "chrome-profile"),
  });
  fs.writeFileSync(path.join(runDir, "task.md"), `allow_submit: ${String(allowSubmit)}\n\n${instruction}\n`);
  const lastFile = path.join(runDir, "final.md");
  const runner = options.runner ?? nodeProcessRunner;
  let result: Awaited<ReturnType<ProcessRunner>>;
  try {
    result = await runner(options.command ?? codexCommand(), computerUseArgs(runDir, instruction, lastFile), {
      cwd: runDir,
      timeoutMs: options.timeoutMs ?? COMPUTER_USE_TIMEOUT_MS,
    });
  } catch (error) {
    throw Error(`Codex introuvable ou non lancé : ${error instanceof Error ? error.message : String(error)}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const log = path.join(runDir, "codex.log");
  fs.writeFileSync(log, output.slice(-400_000));
  const final = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8").trim() : finalFromLog(output);
  const screenshots = fs
    .readdirSync(runDir)
    .filter((n) => SHOT_EXT.test(n))
    .map((n) => path.join(runDir, n))
    .sort();
  return {
    final: final || `(aucun texte final, code ${String(result.code)})`,
    run_dir: runDir,
    screenshots,
    exit_code: result.code,
    codex_session: codexSessionId(output),
    log,
  };
}

export function registerComputerUseTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
  options: { runner?: ProcessRunner; command?: string } = {},
): void {
  const dir = env["MIND_WAKE_DATA_DIR"];
  if (!dir) return;
  server.registerTool(
    "computer_use",
    {
      description:
        "Delegate a task on this Windows PC's screen to Codex Computer Use (desktop apps, or web pages opened in a dedicated Chrome with an isolated profile, no account signed in). Takes one to several minutes. Read-only by default: allow_submit=false forbids publish/post/send/submit; true allows only the submission the task explicitly asks for (never purchases or logins). Returns Codex's final text, the run folder (artifacts/computer-use/<timestamp>/) and screenshot paths. Never closes windows it did not open.",
      inputSchema: z.strictObject({
        task: z.string().trim().min(1).max(4000),
        allow_submit: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const result = await runComputerUse(workspaceDirFor(dir), args.task, {
          allowSubmit: args.allow_submit === true,
          ...(options.runner ? { runner: options.runner } : {}),
          ...(options.command ? { command: options.command } : { command: codexCommand(env) }),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `computer_use : ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );
  registerDesktopTools(server, env["MIND_WAKE_DESKTOP_PYTHON"], env["MIND_WAKE_OWNER_SIGNATURE"], desktopRoom(env), dir);
}
