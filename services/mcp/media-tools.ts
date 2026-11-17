/**
 * Brique « médias » partagée (mandat NLR du 16 nov. 2026, 14:53–14:57) : une seule brique pour
 * générer une image (Codex, feature `image_generation`), résoudre un fichier du workspace et
 * l'envoyer par le bot Telegram (sendPhoto, sinon sendDocument). Pas de quota ni de format imposé
 * au premier jet (NLR : pas de garde-fous avant une v0 correcte).
 *
 * `MEDIA_TOOLS` est la déclaration commune : le serveur du principal (`registerOwnerTools`) et
 * celui des rooms, VOX et coachs compris (`fork-owner-main.ts`), l'ajoutent à leurs outils.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Outils médias exposés par défaut au principal, aux rooms (VOX…) et aux coachs. */
export const MEDIA_TOOLS = ["generate_image"] as const;

export class MediaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ fichiers du workspace

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

export interface WorkspaceFile {
  readonly absolutePath: string;
  readonly name: string;
  readonly size: number;
}

/** Fichier existant du workspace (relatif à lui, ou absolu dedans) ; liens résolus. */
export function resolveWorkspaceFile(workspace: string, file: string): WorkspaceFile {
  if (file.trim() === "" || /[\x00-\x1f]/.test(file) || /^(?:https?:|[\\/]{2})/i.test(file))
    throw new MediaError("invalid_path", "Chemin local du workspace attendu.");
  const root = fs.realpathSync(workspace);
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(root, file));
  } catch {
    throw new MediaError("not_found", `Fichier introuvable : ${file.slice(0, 300)}`);
  }
  if (!inside(root, real)) throw new MediaError("outside_workspace", "Le fichier doit être dans le workspace.");
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new MediaError("not_a_file", "Fichier attendu.");
  return { absolutePath: real, name: path.basename(real), size: stat.size };
}

// ------------------------------------------------------------ envoi de fichier par le bot

/** Légende Telegram : 1024 caractères au plus. */
export const TELEGRAM_CAPTION_MAX = 1024;
/** sendPhoto : 10 Mo ; sendDocument : 50 Mo (Bot API). */
export const TELEGRAM_PHOTO_MAX = 10_000_000;
export const TELEGRAM_DOCUMENT_MAX = 50_000_000;
const PHOTO_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

/** Méthode Bot API pour ce fichier : photo si image raster ≤ 10 Mo, sinon document. */
export function telegramFileMethod(file: Pick<WorkspaceFile, "name" | "size">): "sendPhoto" | "sendDocument" {
  return PHOTO_EXT.has(path.extname(file.name).toLowerCase()) && file.size <= TELEGRAM_PHOTO_MAX ? "sendPhoto" : "sendDocument";
}

/** Envoi d'un fichier avec légende ; rejette avec `telegramCode` quand l'API a répondu non. */
export type TelegramSendFile = (
  chatId: string,
  file: WorkspaceFile,
  caption: string,
  options?: { parseMode?: "HTML" },
) => Promise<{ message_id?: number; method: "sendPhoto" | "sendDocument" }>;

/** Refus de Telegram dû au balisage (HTML/Markdown) de la légende ou du texte. */
export function isTelegramParseError(error: unknown): boolean {
  return (error as { telegramCode?: unknown }).telegramCode === 400 && /can't parse entities/i.test(error instanceof Error ? error.message : "");
}

function botToken(dataDir: string): string {
  let config: { enabled?: unknown; botToken?: unknown };
  try {
    config = JSON.parse(fs.readFileSync(path.join(dataDir, "telegram.json"), "utf8")) as typeof config;
  } catch {
    throw new MediaError("not_configured", "Telegram n'est pas configuré sur ce poste.");
  }
  if (config.enabled !== true || typeof config.botToken !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken))
    throw new MediaError("not_configured", "Telegram est désactivé ou mal configuré.");
  return config.botToken;
}

/**
 * Envoi réel par le bot : jeton lu dans telegram.json au moment de l'envoi, jamais journalisé.
 * Photo refusée par Telegram (dimensions, format) : un essai en document.
 */
export function telegramBotFileSender(dataDir: string, http: typeof fetch = fetch): TelegramSendFile {
  const once = async (
    method: "sendPhoto" | "sendDocument",
    chatId: string,
    file: WorkspaceFile,
    caption: string,
    options?: { parseMode?: "HTML" },
  ) => {
    if (file.size > TELEGRAM_DOCUMENT_MAX)
      throw new MediaError("too_large", `Fichier trop gros pour le bot (${String(Math.round(file.size / 1e6))} Mo, 50 Mo au plus).`);
    const token = botToken(dataDir);
    const form = new FormData();
    form.set("chat_id", chatId);
    if (caption !== "") form.set("caption", caption);
    if (caption !== "" && options?.parseMode !== undefined) form.set("parse_mode", options.parseMode);
    const type = MIME[path.extname(file.name).toLowerCase()] ?? "application/octet-stream";
    form.set(method === "sendPhoto" ? "photo" : "document", new Blob([fs.readFileSync(file.absolutePath)], { type }), file.name);
    let response: Response;
    try {
      response = await http(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new MediaError("network", `Telegram ${method} : réseau indisponible.`);
    }
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error_code?: number;
      description?: unknown;
      result?: { message_id?: number };
    };
    if (!response.ok || body.ok !== true) {
      const description = typeof body.description === "string" ? ` : ${body.description.slice(0, 500)}` : ".";
      const error = new MediaError(
        "telegram_refused",
        `Telegram ${method} refusé : HTTP ${String(response.status)}, code ${String(body.error_code ?? "unknown")}${description}`,
      );
      Object.assign(error, { telegramCode: body.error_code ?? response.status });
      throw error;
    }
    return { ...(body.result ?? {}), method };
  };
  return async (chatId, file, caption, options) => {
    const method = telegramFileMethod(file);
    try {
      return await once(method, chatId, file, caption, options);
    } catch (error) {
      // Balisage refusé : le document échouerait pareil ; l'appelant décide (repli en texte brut).
      if (method === "sendPhoto" && (error as { telegramCode?: unknown }).telegramCode === 400 && !isTelegramParseError(error))
        return once("sendDocument", chatId, file, caption, options);
      throw error;
    }
  };
}

// ------------------------------------------------------------ génération d'image (Codex)

/** Lance un programme ; rend son code de sortie et ses sorties. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const nodeProcessRunner: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error instanceof Error ? error : Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export const CODEX_IMAGE_TIMEOUT_MS = 10 * 60_000;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** Dossier de Codex (`CODEX_HOME`, sinon `~/.codex`). */
export function codexHomeDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env["CODEX_HOME"]?.trim();
  return home ? home : path.join(os.homedir(), ".codex");
}

/**
 * Exécutable Codex : `MIND_WAKE_CODEX_BIN`, sinon `codex` du PATH, sinon l'installation Windows
 * habituelle. Le serveur MCP d'une room peut tourner sans PATH (environnement réduit).
 */
export function codexCommand(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = env["MIND_WAKE_CODEX_BIN"]?.trim();
  if (explicit) return explicit;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(path.delimiter))
    if (dir !== "" && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  const local = path.join(env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin", exe);
  return fs.existsSync(local) ? local : "codex";
}

/** Consigne donnée à Codex : une image, enregistrée en `image.png` dans le dossier courant. */
export function codexImageInstruction(prompt: string): string {
  return [
    "Use your native image generation tool to create exactly one image for this request:",
    prompt.trim(),
    "Then save the generated image as PNG file 'image.png' in the current directory and print its absolute path. Do nothing else.",
  ].join("\n\n");
}

export function codexImageArgs(dir: string, prompt: string): string[] {
  return ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", dir, codexImageInstruction(prompt)];
}

/** Id de session (fil) annoncé par `codex exec` (« session id: … »). */
export function codexSessionId(output: string): string | null {
  return /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(output)?.[1] ?? null;
}

function newestImage(dir: string): string | null {
  let best: { file: string; at: number } | null = null;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!IMAGE_EXT.test(name)) continue;
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isFile() && (best === null || stat.mtimeMs > best.at)) best = { file, at: stat.mtimeMs };
  }
  return best?.file ?? null;
}

/**
 * Image produite par la session : `<codexHome>/generated_images/<session>/*.png` (la plus
 * récente), sinon celle que Codex a recopiée dans le dossier de travail.
 */
export function findCodexImage(output: string, workDir: string, codexHome: string): string | null {
  const session = codexSessionId(output);
  const fromHome = session === null ? null : newestImage(path.join(codexHome, "generated_images", session));
  return fromHome ?? newestImage(workDir);
}

export interface GeneratedImageFile {
  /** Copie de l'image dans le workspace (relative à lui), prête pour `saveGeneratedImage`. */
  readonly sourcePath: string;
  readonly runDir: string;
  readonly session: string | null;
}

/**
 * Lance `codex exec` dans un dossier temporaire du workspace (`artifacts/generated-images/runs/<id>`),
 * puis recopie l'image produite dans ce dossier. Journal de la session : `codex.log`.
 */
export async function generateImageWithCodex(
  workspace: string,
  prompt: string,
  options: {
    runner?: ProcessRunner;
    codexHome?: string;
    command?: string;
    timeoutMs?: number;
  } = {},
): Promise<GeneratedImageFile> {
  if (prompt.trim() === "") throw new MediaError("invalid_prompt", "Consigne vide.");
  const root = fs.realpathSync(workspace);
  const runDir = path.join(root, "artifacts", "generated-images", "runs", `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const runner = options.runner ?? nodeProcessRunner;
  let result: Awaited<ReturnType<ProcessRunner>>;
  try {
    result = await runner(options.command ?? codexCommand(), codexImageArgs(runDir, prompt), {
      cwd: runDir,
      timeoutMs: options.timeoutMs ?? CODEX_IMAGE_TIMEOUT_MS,
    });
  } catch (error) {
    throw new MediaError("codex_unavailable", `Codex introuvable ou non lancé : ${error instanceof Error ? error.message : String(error)}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  fs.writeFileSync(path.join(runDir, "codex.log"), output.slice(-200_000));
  const found = findCodexImage(output, runDir, options.codexHome ?? codexHomeDir());
  if (found === null)
    throw new MediaError(
      "no_image",
      `Codex n'a produit aucune image (code ${String(result.code)}). Journal : ${path.relative(root, path.join(runDir, "codex.log")).split(path.sep).join("/")}`,
    );
  const copy = inside(runDir, found) ? found : path.join(runDir, `codex${path.extname(found).toLowerCase()}`);
  if (copy !== found) fs.copyFileSync(found, copy);
  return {
    sourcePath: path.relative(root, copy).split(path.sep).join("/"),
    runDir,
    session: codexSessionId(output),
  };
}

/** Titre par défaut d'une image générée : début de la consigne. */
export function defaultImageTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat || "Image générée";
}
