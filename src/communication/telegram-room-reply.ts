/**
 * Réponse d'une room renvoyée à NLR sur Telegram (NLR, 16 nov. 2026 17:23 et 17:27 : il parle à
 * VOX depuis son téléphone, dans le chat du bot MIND). Quand un tour a été déclenché par un
 * message Telegram routé (`telegram-route:`), la réponse de l'agent adressé, et elle seule, part
 * dans le chat privé de NLR avec le bot, préfixée du nom de l'agent. Rien d'autre de la room.
 *
 * Envoi : même chemin que telegram_send_owner (`services/telegram/owner-send-main.ts` appelle
 * `TelegramOwner.send_`), une fois par entrée de la room, découpé à 4000 caractères. Un échec
 * est journalisé et n'est pas réessayé.
 *
 * Fichiers (NLR, 16 nov. 2026 : « permets l'envoi de fichier en message tg ») : chaque ligne
 * `[fichier: chemin]` (ou `[file: chemin]`) de la réponse est retirée du texte et le fichier part
 * en pièce jointe, 3 au plus. Chemin relatif au workspace de la room, ou absolu ; il doit être dans
 * ce workspace ou dans le workspace MIND, sinon une courte note remplace la ligne. Le premier
 * fichier porte le texte en légende (texte à part s'il est long : `send_`) ; les suivants partent
 * sans légende, clés `-f2`, `-f3`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TS_HOOKS, typeScriptNodeArgs } from "../cli/script-entry.js";
import { workspaceDirFor } from "../daemon/paths.js";
import type { SecondThreadStore } from "../daemon/second-thread.js";

export const TELEGRAM_REPLY_MAX = 4000;
/** Pièces jointes d'une réponse : 3 au plus. */
export const TELEGRAM_REPLY_FILES_MAX = 3;
/** Fichier joint : chemin réel, et le workspace autorisé qui le contient. */
export interface OwnerTelegramFile {
  path: string;
  root: string;
}
/** Envoi d'un texte à NLR (avec un fichier, le texte en légende) ; rejette en cas d'échec. */
export type OwnerTelegramSend = (text: string, idempotencyKey: string, file?: OwnerTelegramFile) => Promise<void>;

const FILE_LINE = /^\s*\[(?:fichier|file)\s*:\s*(.+?)\s*\]\s*$/i;

function within(root: string, file: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(norm(root), norm(file));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Retire les lignes `[fichier: …]` du texte et résout leurs chemins. `roots[0]` : workspace de la
 * room (base des chemins relatifs) ; un fichier hors de tous les `roots`, introuvable ou au-delà
 * du plafond n'est pas envoyé, et une note courte s'ajoute au texte.
 */
export function extractReplyFiles(
  text: string,
  roots: readonly string[],
  max = TELEGRAM_REPLY_FILES_MAX,
): { text: string; files: OwnerTelegramFile[] } {
  const real = roots.flatMap((r) => {
    try {
      return [fs.realpathSync(r)];
    } catch {
      return [];
    }
  });
  const files: OwnerTelegramFile[] = [];
  const notes: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const m = FILE_LINE.exec(line);
    if (m === null) {
      kept.push(line);
      continue;
    }
    const asked = m[1]!.replace(/^[`"'<]+|[`"'>]+$/g, "").trim();
    if (files.length >= max) {
      notes.push(`(fichier non envoyé : ${asked} — ${String(max)} au plus par réponse)`);
      continue;
    }
    let file: string | null = null;
    try {
      file = fs.realpathSync(path.resolve(real[0] ?? process.cwd(), asked));
      if (!fs.statSync(file).isFile()) file = null;
    } catch {
      file = null;
    }
    if (file === null) {
      notes.push(`(fichier non envoyé : ${asked} — introuvable)`);
      continue;
    }
    const found = file;
    const root = real.find((r) => within(r, found));
    if (root === undefined) {
      notes.push(`(fichier non envoyé : ${asked} — hors du workspace)`);
      continue;
    }
    if (!files.some((f) => f.path === found)) files.push({ path: found, root });
  }
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: [body, ...notes].filter((t) => t !== "").join("\n"), files };
}

/** Workspaces d'où une room peut envoyer un fichier : le sien (base des chemins), puis MIND. */
export function roomFileRoots(dataDir: string, roomWorkspace: string): string[] {
  try {
    return [roomWorkspace, workspaceDirFor(dataDir)];
  } catch {
    return [roomWorkspace];
  }
}

/** Entrée JSON de services/telegram/owner-send-main.ts. */
export function ownerSendPayload(text: string, idempotencyKey: string, file?: OwnerTelegramFile): string {
  return JSON.stringify({
    text,
    idempotency_key: idempotencyKey,
    ...(file === undefined ? {} : { image_path: file.path, workspace: file.root }),
  });
}

/** « VOX (Room 7) » → « VOX ». */
export function displayName(signature: string): string {
  return signature.replace(/\s*\(.*?\)\s*/g, " ").trim() || signature.trim();
}

/** Préfixe le nom (sans le doubler) et découpe à `max` caractères. */
export function telegramReplyParts(name: string, text: string, max = TELEGRAM_REPLY_MAX): string[] {
  const body = text.trim();
  const full = body.startsWith(`${name} :`) || body.startsWith(`${name}:`) ? body : `${name} : ${body}`;
  const parts: string[] = [];
  for (let rest = full; rest !== ""; rest = rest.slice(max)) parts.push(rest.slice(0, max));
  return parts;
}

function sendScript(): { repo: string; script: string } | null {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const script = path.join(dir, "services", "telegram", "owner-send-main.ts");
    if (fs.existsSync(script) && fs.existsSync(path.join(dir, TS_HOOKS))) return { repo: dir, script };
    if (path.dirname(dir) === dir) return null;
  }
}

/** Envoi réel par un sous-processus du service Telegram (aucun nouveau client du bot). */
export function ownerTelegramSender(dataDir: string, node = process.execPath): OwnerTelegramSend {
  return (text, idempotencyKey, file) =>
    new Promise<void>((resolve, reject) => {
      const found = sendScript();
      if (found === null) return reject(new Error("services/telegram/owner-send-main.ts introuvable."));
      const child = spawn(node, [...typeScriptNodeArgs(found.repo), found.script], {
        cwd: found.repo,
        env: { ...process.env, MIND_WAKE_DATA_DIR: dataDir },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), 90_000);
      child.stdout.on("data", (c: Buffer) => (out += String(c)));
      child.stderr.on("data", (c: Buffer) => (err += String(c)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", () => {
        clearTimeout(timer);
        let r: { ok?: boolean; code?: string; message?: string } = {};
        try {
          r = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as typeof r;
        } catch {
          /* sortie illisible : échec ci-dessous */
        }
        // Clé déjà utilisée : le message est déjà parti (ou réservé), on ne renvoie rien.
        if (r.ok === true || r.code === "duplicate_key") resolve();
        else reject(new Error(r.message ?? (err.trim().slice(-300) || "envoi Telegram échoué")));
      });
      child.stdin.end(ownerSendPayload(text, idempotencyKey, file));
    });
}

/**
 * Envoie une fois la réponse `entryId` de la room à NLR. L'entrée est réservée avant l'envoi :
 * un redémarrage ou un échec ne la renvoie jamais.
 */
export async function forwardRoomReply(input: {
  store: Pick<SecondThreadStore, "get" | "set">;
  room: number;
  entryId: number;
  name: string;
  text: string;
  send: OwnerTelegramSend;
  /** Workspaces d'où un fichier peut partir : celui de la room (base des chemins), puis MIND. */
  workspaces?: readonly string[] | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<boolean> {
  const slot = `telegram-reply:${String(input.entryId)}`;
  if (input.store.get(slot) !== null) return false;
  input.store.set(slot, "pending");
  const { text, files } = input.workspaces === undefined ? { text: input.text, files: [] } : extractReplyFiles(input.text, input.workspaces);
  const parts = telegramReplyParts(input.name, text);
  const key = `room${String(input.room)}-reply-${String(input.entryId)}`;
  try {
    for (const [i, part] of parts.entries())
      await input.send(part, `${key}${parts.length === 1 ? "" : `-${String(i)}`}`, i === 0 ? files[0] : undefined);
    for (const [i, file] of files.entries()) if (i > 0) await input.send("", `${key}-f${String(i + 1)}`, file);
    input.store.set(slot, "sent");
    input.log?.(`Room ${String(input.room)} : réponse ${String(input.entryId)} envoyée à NLR sur Telegram.`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.store.set(slot, `failed: ${detail.slice(0, 300)}`);
    input.log?.(`Room ${String(input.room)} : envoi Telegram de la réponse ${String(input.entryId)} échoué — ${detail}`);
    return false;
  }
}
