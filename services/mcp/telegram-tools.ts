/**
 * Écrire aux humains par le bot Telegram de NLR (mandat du 16 nov. 2026). Seulement aux contacts
 * qui ont écrit au bot (le bridge les garde dans `telegram.sqlite`), jamais au propriétaire,
 * une fois par clé d'idempotence. Le texte part tel quel, sans signature ajoutée.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { workspaceDirFor } from "../../src/daemon/paths.js";
import {
  MediaError,
  TELEGRAM_CAPTION_MAX,
  isTelegramParseError,
  resolveWorkspaceFile,
  telegramBotFileSender,
  type TelegramSendFile,
} from "./media-tools.js";

/** Mêmes tables que `services/telegram/bridge.mjs` (CONTACT_SCHEMA). */
export const CONTACT_SCHEMA =
  "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS contacts(chat_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,username TEXT,first_name TEXT,last_seen TEXT NOT NULL,greeted_at TEXT); CREATE TABLE IF NOT EXISTS contact_incoming(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,delivered_at TEXT); CREATE TABLE IF NOT EXISTS contact_outgoing(key TEXT PRIMARY KEY,chat_id TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT);";
export const TELEGRAM_TEXT_MAX = 4000;
/** Journal des publications sur le canal public, même logique de clé que `contact_outgoing`. */
export const CHANNEL_SCHEMA =
  "CREATE TABLE IF NOT EXISTS channel_outgoing(key TEXT PRIMARY KEY,channel TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT);";
/** Canal public par défaut ; `MIND_WAKE_TELEGRAM_CHANNEL` ou `channel` de telegram.json le remplacent. */
export const TELEGRAM_DEFAULT_CHANNEL = "@mindprotocol_ai";

export class TelegramContactError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Envoi d'un texte à un chat ; rejette avec `telegramCode` quand l'API a répondu non. */
export type TelegramSend = (
  chatId: string,
  text: string,
  options?: { parseMode?: "HTML" },
) => Promise<{ message_id?: number }>;

/** Envoi réel : jeton lu dans telegram.json au moment de l'envoi, jamais journalisé. */
export function telegramBotSender(dataDir: string, http: typeof fetch = fetch): TelegramSend {
  return async (chatId, text, options) => {
    let config: { enabled?: unknown; botToken?: unknown };
    try {
      config = JSON.parse(fs.readFileSync(path.join(dataDir, "telegram.json"), "utf8")) as typeof config;
    } catch {
      throw new TelegramContactError("not_configured", "Telegram n'est pas configuré sur ce poste.");
    }
    if (config.enabled !== true || typeof config.botToken !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken))
      throw new TelegramContactError("not_configured", "Telegram est désactivé ou mal configuré.");
    let response: Response;
    try {
      response = await http(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, ...(options?.parseMode === undefined ? {} : { parse_mode: options.parseMode }) }),
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new TelegramContactError("network", "Telegram sendMessage : réseau indisponible.");
    }
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error_code?: number;
      description?: unknown;
      result?: { message_id?: number };
    };
    if (!response.ok || body.ok !== true) {
      // L'explication de Telegram est rendue telle quelle (ex. « bot is not a member of the channel chat »).
      const description = typeof body.description === "string" ? ` : ${body.description.slice(0, 1000)}` : ".";
      const error = new TelegramContactError(
        "telegram_refused",
        `Telegram sendMessage refusé : HTTP ${String(response.status)}, code ${String(body.error_code ?? "unknown")}${description}`,
      );
      (error as TelegramContactError & { telegramCode?: number }).telegramCode = body.error_code ?? response.status;
      throw error;
    }
    return body.result ?? {};
  };
}

interface ContactRow {
  chat_id: string;
  user_id: string;
  username: string | null;
  first_name: string | null;
  last_seen: string;
  wrote: number;
}

export class TelegramContacts {
  constructor(
    private readonly dataDir: string,
    private readonly send: TelegramSend = telegramBotSender(dataDir),
  ) {}

  private open(): Database.Database {
    const file = path.join(this.dataDir, "telegram.sqlite");
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new TelegramContactError("invalid_store", "telegram.sqlite invalide.");
    }
    const db = new Database(file);
    db.pragma("busy_timeout = 5000");
    db.exec(CONTACT_SCHEMA);
    return db;
  }

  /** Identités du propriétaire : user/chat épinglés par le bridge et ownerUsername de telegram.json. */
  private owner(db: Database.Database): Set<string> {
    const rows = db.prepare("SELECT value FROM state WHERE key IN ('user','chat')").all() as { value: string }[];
    const owner = new Set(rows.map((r) => r.value));
    try {
      const name = (JSON.parse(fs.readFileSync(path.join(this.dataDir, "telegram.json"), "utf8")) as { ownerUsername?: unknown }).ownerUsername;
      if (typeof name === "string" && name.trim() !== "") owner.add(`@${name.trim().replace(/^@/, "").toLowerCase()}`);
    } catch {
      // Pas de configuration : seules les identités épinglées comptent.
    }
    return owner;
  }

  list(): {
    chat_id: string;
    user_id: string;
    username: string | null;
    first_name: string | null;
    last_message_at: string;
    can_send: boolean;
  }[] {
    const db = this.open();
    try {
      const owner = this.owner(db);
      return (
        db
          .prepare(
            "SELECT c.chat_id,c.user_id,c.username,c.first_name,c.last_seen,EXISTS(SELECT 1 FROM contact_incoming i WHERE i.chat_id=c.chat_id) AS wrote FROM contacts c ORDER BY c.last_seen DESC",
          )
          .all() as ContactRow[]
      )
        .filter(
          (c) =>
            !owner.has(c.chat_id) &&
            !owner.has(c.user_id) &&
            !(c.username !== null && owner.has(`@${c.username.toLowerCase()}`)),
        )
        .map((c) => ({
          chat_id: c.chat_id,
          user_id: c.user_id,
          username: c.username,
          first_name: c.first_name,
          last_message_at: c.last_seen,
          can_send: c.wrote === 1,
        }));
    } finally {
      db.close();
    }
  }

  async sendTo(input: { to: string; text: string; idempotency_key: string }): Promise<{
    chat_id: string;
    username: string | null;
    message_id: number | null;
    idempotency_key: string;
  }> {
    const to = input.to.trim();
    if (input.text.trim() === "") throw new TelegramContactError("invalid_text", "Texte vide.");
    if (input.text.length > TELEGRAM_TEXT_MAX)
      throw new TelegramContactError("invalid_text", `Texte trop long (${String(TELEGRAM_TEXT_MAX)} caractères au plus).`);
    const db = this.open();
    let chat: string;
    let username: string | null;
    try {
      const contact = (
        /^-?\d+$/.test(to)
          ? db.prepare("SELECT chat_id,user_id,username FROM contacts WHERE chat_id=?").get(to)
          : db
              .prepare("SELECT chat_id,user_id,username FROM contacts WHERE lower(username)=? ORDER BY last_seen DESC")
              .get(to.replace(/^@/, "").toLowerCase())
      ) as { chat_id: string; user_id: string; username: string | null } | undefined;
      const owner = this.owner(db);
      const named = (u: string | null | undefined) => (u ? owner.has(`@${u.replace(/^@/, "").toLowerCase()}`) : false);
      if (
        owner.has(to) ||
        (!/^-?\d+$/.test(to) && named(to)) ||
        (contact !== undefined && (owner.has(contact.chat_id) || owner.has(contact.user_id) || named(contact.username)))
      )
        throw new TelegramContactError("owner", "Destinataire refusé : c'est le propriétaire du bot ; écris-lui par le fil principal.");
      const wrote =
        contact !== undefined &&
        db.prepare("SELECT 1 FROM contact_incoming WHERE chat_id=? LIMIT 1").get(contact.chat_id) !== undefined;
      if (contact === undefined || !wrote)
        throw new TelegramContactError(
          "not_started",
          `Envoi refusé : ce contact n'a pas lancé le bot (/start). Il doit d'abord écrire au bot ; voir telegram_list_contacts.`,
        );
      chat = contact.chat_id;
      username = contact.username;
      // Réserve la clé avant l'envoi : une clé ne sert qu'une fois, même en concurrence.
      const reserved = db
        .prepare("INSERT OR IGNORE INTO contact_outgoing(key,chat_id,text,at,status) VALUES(?,?,?,?,'pending')")
        .run(input.idempotency_key, chat, input.text, new Date().toISOString());
      if (reserved.changes !== 1)
        throw new TelegramContactError(
          "duplicate_key",
          "Envoi refusé : cette idempotency_key a déjà servi ; rien n'a été renvoyé. Vérifie l'envoi précédent, ou choisis une nouvelle clé pour un nouveau message.",
        );
    } finally {
      db.close();
    }
    let result: { message_id?: number };
    try {
      result = await this.send(chat, input.text);
    } catch (error) {
      const refused = (error as { telegramCode?: unknown }).telegramCode !== undefined;
      const after = this.open();
      try {
        // Refus net de Telegram : rien n'est parti, la clé est rendue. Sinon l'issue est incertaine.
        if (refused) after.prepare("DELETE FROM contact_outgoing WHERE key=?").run(input.idempotency_key);
        else after.prepare("UPDATE contact_outgoing SET status='uncertain' WHERE key=?").run(input.idempotency_key);
      } finally {
        after.close();
      }
      throw error;
    }
    const done = this.open();
    try {
      done
        .prepare("UPDATE contact_outgoing SET status='sent',message_id=? WHERE key=?")
        .run(result.message_id === undefined ? null : String(result.message_id), input.idempotency_key);
    } finally {
      done.close();
    }
    return { chat_id: chat, username, message_id: result.message_id ?? null, idempotency_key: input.idempotency_key };
  }
}

/**
 * Canal public résolu : variable `MIND_WAKE_TELEGRAM_CHANNEL`, sinon `channel` de telegram.json,
 * sinon `@mindprotocol_ai`. Seuls un `@nom` de canal ou un id numérique négatif sont acceptés.
 */
export function telegramChannelFor(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  let channel = env["MIND_WAKE_TELEGRAM_CHANNEL"]?.trim() ?? "";
  if (channel === "") {
    try {
      const value = (JSON.parse(fs.readFileSync(path.join(dataDir, "telegram.json"), "utf8")) as { channel?: unknown })
        .channel;
      if (typeof value === "string") channel = value.trim();
    } catch {
      // Pas de configuration : canal par défaut.
    }
  }
  if (channel === "") return TELEGRAM_DEFAULT_CHANNEL;
  if (!/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(channel) && !/^-\d{5,20}$/.test(channel))
    throw new TelegramContactError("invalid_channel", `Canal Telegram invalide : ${channel.slice(0, 64)}.`);
  return channel;
}

/**
 * `image_path` d'un envoi Telegram : fichier du workspace (relatif à lui, ou absolu dedans),
 * mêmes règles que pour telegram_send_owner. Erreur rendue en TelegramContactError.
 */
export function resolveTelegramImage(workspace: string, imagePath: string): ReturnType<typeof resolveWorkspaceFile> {
  try {
    return resolveWorkspaceFile(workspace, imagePath);
  } catch (error) {
    throw new TelegramContactError(error instanceof MediaError ? error.code : "invalid_path", error instanceof Error ? error.message : String(error));
  }
}

/** Mise en forme d'une publication du canal : brut (défaut), HTML Telegram, ou Markdown simple converti en HTML. */
export const TELEGRAM_FORMATS = ["plain", "html", "markdown"] as const;
export type TelegramFormat = (typeof TELEGRAM_FORMATS)[number];

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Texte visible d'un HTML Telegram : balises retirées, entités décodées. */
export function telegramHtmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Markdown simple vers le HTML de Telegram (plus robuste que MarkdownV2 et son échappement) :
 * **gras**, *italique* ou _italique_, __souligné__, ~~barré~~, ||spoiler||, `code`, ```bloc```,
 * [texte](https://lien), lignes « > » en citation. Le reste est échappé et part tel quel.
 */
export function telegramMarkdownToHtml(markdown: string): string {
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${String(kept.push(html) - 1)}\u0000`;
  let s = markdown.replace(/\u0000/g, "");
  s = s.replace(/```(?:[A-Za-z0-9_+-]*\n)?([\s\S]*?)```/g, (_m, code: string) => keep(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|tg:\/\/|mailto:)[^\s)]+)\)/g, (_m, label: string, url: string) =>
    keep(`<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`),
  );
  s = s
    .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+?)__/g, "<u>$1</u>")
    .replace(/~~([^~\n]+?)~~/g, "<s>$1</s>")
    .replace(/\|\|([^|\n]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
    .replace(/(^|[^\w*])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![\w*])/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_([^_\s](?:[^_\n]*?[^_\s])?)_(?!\w)/g, "$1<i>$2</i>");
  // Lignes consécutives commençant par « > » : une citation.
  s = s.replace(/(?:^&gt; ?.*(?:\n|$))+/gm, (block) => {
    const end = block.endsWith("\n") ? "\n" : "";
    const body = block
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.replace(/^&gt; ?/, ""))
      .join("\n");
    return `<blockquote>${body}</blockquote>${end}`;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "");
}

/**
 * Publication sur le canal public par le bot, une fois par clé d'idempotence. Avec `image_path` :
 * sendPhoto (PNG/JPEG/WebP ≤ 10 Mo) ou sendDocument (≤ 50 Mo), le texte en légende ; au-delà de
 * 1024 caractères, le texte suit en message séparé, juste après le fichier.
 */
export class TelegramChannel {
  constructor(
    private readonly dataDir: string,
    private readonly send: TelegramSend = telegramBotSender(dataDir),
    private readonly env: Readonly<Record<string, string | undefined>> = {},
    private readonly sendFile: TelegramSendFile = telegramBotFileSender(dataDir),
    private readonly workspace: () => string = () => workspaceDirFor(dataDir),
  ) {}

  private open(): Database.Database {
    const file = path.join(this.dataDir, "telegram.sqlite");
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new TelegramContactError("invalid_store", "telegram.sqlite invalide.");
    }
    const db = new Database(file);
    db.pragma("busy_timeout = 5000");
    db.exec(CHANNEL_SCHEMA);
    return db;
  }

  async post(input: {
    text: string;
    idempotency_key: string;
    image_path?: string | undefined;
    format?: TelegramFormat | undefined;
  }): Promise<{
    channel: string;
    message_id: number | null;
    idempotency_key: string;
    format: TelegramFormat;
    file?: { path: string; method: "sendPhoto" | "sendDocument"; size: number };
    fallback_plain?: true;
    note?: string;
  }> {
    const format = input.format ?? "plain";
    if (!TELEGRAM_FORMATS.includes(format)) throw new TelegramContactError("invalid_format", "format : plain, html ou markdown.");
    if (input.text.trim() === "") throw new TelegramContactError("invalid_text", "Texte vide.");
    if (input.text.length > TELEGRAM_TEXT_MAX)
      throw new TelegramContactError("invalid_text", `Texte trop long (${String(TELEGRAM_TEXT_MAX)} caractères au plus).`);
    if (input.idempotency_key.trim() === "")
      throw new TelegramContactError("invalid_key", "idempotency_key obligatoire.");
    // Fichier vérifié avant de réserver la clé : un chemin refusé ne consomme pas la clé.
    const file = input.image_path === undefined ? undefined : resolveTelegramImage(this.workspace(), input.image_path);
    const channel = telegramChannelFor(this.dataDir, this.env);
    const db = this.open();
    try {
      // Réserve la clé avant l'envoi : une clé ne sert qu'une fois, même en concurrence.
      const reserved = db
        .prepare("INSERT OR IGNORE INTO channel_outgoing(key,channel,text,at,status) VALUES(?,?,?,?,'pending')")
        .run(input.idempotency_key, channel, input.text, new Date().toISOString());
      if (reserved.changes !== 1)
        throw new TelegramContactError(
          "duplicate_key",
          "Publication refusée : cette idempotency_key a déjà servi ; rien n'a été republié. Vérifie la publication précédente, ou choisis une nouvelle clé pour un nouveau message.",
        );
    } finally {
      db.close();
    }
    // Corps envoyé : brut tel quel, ou HTML Telegram (Markdown converti en HTML).
    const body = format === "markdown" ? telegramMarkdownToHtml(input.text) : input.text;
    const parse = format === "plain" ? undefined : ({ parseMode: "HTML" } as const);
    const plain = format === "plain" ? body : telegramHtmlToPlain(body);
    let fallback = false;
    // Balisage refusé par Telegram (« can't parse entities ») : un seul nouvel essai, en texte brut sans balises.
    const formatted = async <T>(attempt: (text: string, options?: { parseMode?: "HTML" }) => Promise<T>, text: string, plainText: string) => {
      if (parse === undefined) return attempt(text);
      try {
        return await attempt(text, parse);
      } catch (error) {
        if (!isTelegramParseError(error)) throw error;
        fallback = true;
        return attempt(plainText);
      }
    };
    let result: { message_id?: number };
    let sent: { method: "sendPhoto" | "sendDocument" } | undefined;
    try {
      if (file === undefined) result = await formatted((t, o) => this.send(channel, t, o), body, plain);
      else {
        // La limite de légende porte sur le texte visible ; au-delà, le fichier part sans légende et le
        // texte entier suit en un seul message : aucune coupe, donc jamais au milieu d'une balise.
        const long = plain.length > TELEGRAM_CAPTION_MAX;
        const r = long
          ? await this.sendFile(channel, file, "")
          : await formatted((t, o) => this.sendFile(channel, file, t, o), body, plain);
        result = r;
        sent = { method: r.method };
        if (long) await formatted((t, o) => this.send(channel, t, o), body, plain);
      }
    } catch (error) {
      // Fichier déjà publié : l'échec du texte qui suit ne rend pas la clé (pas de republication).
      const refused = (error as { telegramCode?: unknown }).telegramCode !== undefined && sent === undefined;
      const after = this.open();
      try {
        // Refus net de Telegram : rien n'est parti, la clé est rendue. Sinon l'issue est incertaine.
        if (refused) after.prepare("DELETE FROM channel_outgoing WHERE key=?").run(input.idempotency_key);
        else after.prepare("UPDATE channel_outgoing SET status='uncertain' WHERE key=?").run(input.idempotency_key);
      } finally {
        after.close();
      }
      throw error;
    }
    const done = this.open();
    try {
      done
        .prepare("UPDATE channel_outgoing SET status='sent',message_id=? WHERE key=?")
        .run(result.message_id === undefined ? null : String(result.message_id), input.idempotency_key);
    } finally {
      done.close();
    }
    return {
      channel,
      message_id: result.message_id ?? null,
      idempotency_key: input.idempotency_key,
      format,
      ...(file === undefined || sent === undefined ? {} : { file: { path: file.absolutePath, method: sent.method, size: file.size } }),
      ...(fallback
        ? {
            fallback_plain: true as const,
            note: "Telegram refused the formatting (can't parse entities); published once as plain text with the tags removed.",
          }
        : {}),
    };
  }
}

/**
 * Message direct au propriétaire (NLR), via le bot, vers le chat épinglé par le bridge. Avec
 * `image_path` (fichier du workspace) : sendPhoto, ou sendDocument si le fichier n'est pas une
 * photo acceptable, avec le texte en légende (au-delà de 1024 caractères, le texte suit à part).
 */
export class TelegramOwner {
  constructor(
    private readonly dataDir: string,
    private readonly send: TelegramSend = telegramBotSender(dataDir),
    private readonly sendFile: TelegramSendFile = telegramBotFileSender(dataDir),
    private readonly workspace: () => string = () => workspaceDirFor(dataDir),
  ) {}

  private open(): Database.Database {
    const db = new Database(path.join(this.dataDir, "telegram.sqlite"));
    db.pragma("busy_timeout = 5000");
    db.exec(CHANNEL_SCHEMA);
    return db;
  }

  async send_(input: { text: string; idempotency_key: string; image_path?: string | undefined }): Promise<{
    message_id: number | null;
    idempotency_key: string;
    file?: { path: string; method: "sendPhoto" | "sendDocument"; size: number };
  }> {
    // Avec un fichier, la légende peut être vide (pièces jointes suivantes d'une réponse de room).
    if (input.text.trim() === "" && input.image_path === undefined) throw new TelegramContactError("invalid_text", "Texte vide.");
    if (input.text.length > TELEGRAM_TEXT_MAX) throw new TelegramContactError("invalid_text", "Texte trop long.");
    let file: ReturnType<typeof resolveWorkspaceFile> | undefined;
    if (input.image_path !== undefined) {
      try {
        file = resolveWorkspaceFile(this.workspace(), input.image_path);
      } catch (error) {
        throw new TelegramContactError(error instanceof MediaError ? error.code : "invalid_path", error instanceof Error ? error.message : String(error));
      }
    }
    const db = this.open();
    let chat: string | undefined;
    try {
      chat = (db.prepare("SELECT value FROM state WHERE key='chat'").get() as { value?: string } | undefined)?.value;
      if (!chat) throw new TelegramContactError("not_started", "Chat du propriétaire inconnu : il doit avoir écrit au bot.");
      const reserved = db
        .prepare("INSERT OR IGNORE INTO channel_outgoing(key,channel,text,at,status) VALUES(?,?,?,?,'pending')")
        .run("owner:" + input.idempotency_key, "owner", input.text, new Date().toISOString());
      if (reserved.changes !== 1) throw new TelegramContactError("duplicate_key", "Clé déjà utilisée : rien n'a été renvoyé.");
    } finally {
      db.close();
    }
    let result: { message_id?: number };
    let sent: { method: "sendPhoto" | "sendDocument" } | undefined;
    // NLR, 16 nov. 2026 (11503) : « les ** ne passent pas en gras ». Le Markdown des agents est
    // converti en HTML Telegram ; si Telegram refuse le balisage, un seul nouvel essai en texte brut.
    const html = telegramMarkdownToHtml(input.text);
    const plain = telegramHtmlToPlain(html);
    const formatted = async <T>(attempt: (text: string, options?: { parseMode?: "HTML" }) => Promise<T>): Promise<T> => {
      try {
        return await attempt(html, { parseMode: "HTML" });
      } catch (error) {
        if (!isTelegramParseError(error)) throw error;
        return attempt(plain);
      }
    };
    try {
      if (file === undefined) result = await formatted((t, o) => this.send(chat, t, o));
      else {
        const long = plain.length > TELEGRAM_CAPTION_MAX;
        const r = long ? await this.sendFile(chat, file, "") : await formatted((t, o) => this.sendFile(chat, file, t, o));
        result = r;
        sent = { method: r.method };
        // Légende trop longue pour Telegram : le texte suit, juste après le fichier.
        if (long) await formatted((t, o) => this.send(chat, t, o));
      }
    } catch (error) {
      const after = this.open();
      try {
        if ((error as { telegramCode?: unknown }).telegramCode !== undefined && sent === undefined) after.prepare("DELETE FROM channel_outgoing WHERE key=?").run("owner:" + input.idempotency_key);
        else after.prepare("UPDATE channel_outgoing SET status='uncertain' WHERE key=?").run("owner:" + input.idempotency_key);
      } finally {
        after.close();
      }
      throw error;
    }
    const done = this.open();
    try {
      done.prepare("UPDATE channel_outgoing SET status='sent',message_id=? WHERE key=?").run(result.message_id === undefined ? null : String(result.message_id), "owner:" + input.idempotency_key);
    } finally {
      done.close();
    }
    return {
      message_id: result.message_id ?? null,
      idempotency_key: input.idempotency_key,
      ...(file === undefined || sent === undefined ? {} : { file: { path: file.absolutePath, method: sent.method, size: file.size } }),
    };
  }
}

export function registerTelegramTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
  send?: TelegramSend,
  sendFile?: TelegramSendFile,
): void {
  const dataDir = env["MIND_WAKE_DATA_DIR"];
  if (!dataDir) return;
  const contacts = new TelegramContacts(dataDir, send ?? telegramBotSender(dataDir));
  const channel = new TelegramChannel(dataDir, send ?? telegramBotSender(dataDir), env, sendFile ?? telegramBotFileSender(dataDir));
  const ownerChat = new TelegramOwner(dataDir, send ?? telegramBotSender(dataDir), sendFile ?? telegramBotFileSender(dataDir));
  const reply = async (name: string, work: () => unknown) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema: `mind.mcp/${name}`, schema_version: 1, provenance: "telegram", data: await work() }),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              schema: "mind.mcp/error",
              schema_version: 1,
              error: error instanceof TelegramContactError || error instanceof MediaError ? error.code : "telegram_error",
              message: error instanceof TelegramContactError || error instanceof MediaError ? error.message : "Envoi Telegram indisponible.",
            }),
          },
        ],
      };
    }
  };
  server.registerTool(
    "telegram_list_contacts",
    {
      description:
        "List humans (other than the owner) who wrote to the owner's MIND Telegram bot: username, first name, chat_id, last message date and can_send (true once they wrote to the bot). Their messages already arrive in your inbox as channel \"telegram\".",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => reply("telegram_list_contacts", () => ({ contacts: contacts.list() })),
  );
  server.registerTool(
    "telegram_send_contact",
    {
      description:
        "Send one Telegram message, as the owner's MIND bot, to a contact who already wrote to the bot. `to` is @username or a known chat_id. Refused for the owner, for anyone who never started the bot, and for a reused idempotency_key. The text is sent exactly as given, no signature added; the recipient reads it as coming from NLR's bot.",
      inputSchema: z.strictObject({
        to: z.string().min(1).max(64),
        text: z.string().min(1).max(TELEGRAM_TEXT_MAX),
        idempotency_key: z.string().min(1).max(128),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => reply("telegram_send_contact", () => contacts.sendTo(input)),
  );
  server.registerTool(
    "telegram_post_channel",
    {
      description:
        "Publish one message, as the owner's MIND bot, on the public Telegram channel (default @mindprotocol_ai). It is public: every subscriber sees it. The text is sent as given (at most 4000 characters, no signature added). Optional format: \"plain\" (default, no formatting), \"html\" (Telegram HTML; allowed tags: <b>, <i>, <u>, <s>, <a href=\"https://...\">, <code>, <pre>, <blockquote>, <tg-spoiler>; escape a literal <, > or & as &lt; &gt; &amp;) or \"markdown\" (simple Markdown converted to that HTML: **bold**, *italic* or _italic_, __underline__, ~~strike~~, ||spoiler||, `code`, ```block```, [text](https://link), lines starting with > as a quote). The format applies to the text and to the image caption. If Telegram refuses the markup (\"can't parse entities\"), the message is published once as plain text with the tags removed and the result says so (fallback_plain: true). Optional image_path: a file of the workspace (relative to it, or absolute inside it), e.g. an image from generate_image or a chart produced by a script; published as a photo (PNG/JPEG/WebP up to 10 MB) or else as a document (up to 50 MB), with the text as caption (beyond 1024 visible characters the image goes without caption and the whole formatted text follows as one separate message, never cut). idempotency_key is required: a reused key is refused and nothing is republished (text or image). If Telegram refuses (for example the bot is not a member or not an admin of the channel), its error is returned as is.",
      inputSchema: z.strictObject({
        text: z.string().min(1).max(TELEGRAM_TEXT_MAX),
        idempotency_key: z.string().min(1).max(128),
        image_path: z.string().min(1).max(4096).optional(),
        format: z.enum(TELEGRAM_FORMATS).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => reply("telegram_post_channel", () => channel.post(input)),
  );
  server.registerTool(
    "telegram_send_owner",
    {
      description:
        "Send one Telegram message to the owner (NLR) through the MIND bot, in his private chat with the bot. Use it when something deserves his attention on his phone; the main thread is no longer relayed to Telegram automatically. Text sent as is (at most 4000 characters). Optional image_path: a file of the workspace (relative to it, or absolute inside it), e.g. an image from generate_image or a chart produced by a script; sent as a photo (PNG/JPEG/WebP up to 10 MB) or else as a document (up to 50 MB), with the text as caption (beyond 1024 characters the text follows as a separate message). idempotency_key required; a reused key is refused.",
      inputSchema: z.strictObject({
        text: z.string().min(1).max(TELEGRAM_TEXT_MAX),
        idempotency_key: z.string().min(1).max(128),
        image_path: z.string().min(1).max(4096).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => reply("telegram_send_owner", () => ownerChat.send_(input)),
  );
}
