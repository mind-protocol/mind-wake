import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ownerVoicePass } from "./owner-voice.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export const CONTACT_GREETING =
  "Bonjour, ici le bot MIND de NLR. Vos messages ici sont lus par NLR et ses agents.";
/** Tables des contacts : un humain autre que le propriétaire qui écrit au bot. */
export const CONTACT_SCHEMA =
  "CREATE TABLE IF NOT EXISTS contacts(chat_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,username TEXT,first_name TEXT,last_seen TEXT NOT NULL,greeted_at TEXT); CREATE TABLE IF NOT EXISTS contact_incoming(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,delivered_at TEXT); CREATE TABLE IF NOT EXISTS contact_outgoing(key TEXT PRIMARY KEY,chat_id TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT);";
/** Dépôt par défaut d'un message de contact dans l'inbox du principal (module compilé). */
const contactInbox = (dataDir) => async (message) => {
  const { enqueueTelegramContactMessage } = await import(
    "../../dist/communication/telegram-contacts.js"
  );
  enqueueTelegramContactMessage(dataDir, message);
};
/**
 * Types de message Telegram (NLR, 16 nov. 2026 15:19 : messages 11186 et 11187 perdus sans bruit).
 * Fichiers téléchargés dans l'inbox ; tout autre type arrive dans le fil sous la forme
 * « [Telegram : <type> reçu, non pris en charge] ». Rien n'est plus ignoré sans trace.
 */
export const FILE_KINDS = ["photo", "document", "video", "audio", "animation", "video_note"];
export const OTHER_KINDS = [
  "sticker",
  "location",
  "venue",
  "contact",
  "poll",
  "dice",
  "game",
  "story",
  "invoice",
  "paid_media",
  "checklist",
];
/** Libellé et accord (« photo reçue », « document reçu »). */
const KIND_LABELS = {
  photo: ["photo", "e"],
  document: ["document", ""],
  video: ["vidéo", "e"],
  audio: ["fichier audio", ""],
  animation: ["animation (GIF)", "e"],
  video_note: ["vidéo ronde", "e"],
  voice: ["vocal", ""],
  sticker: ["sticker", ""],
  location: ["position", "e"],
  venue: ["lieu", ""],
  contact: ["contact", ""],
  poll: ["sondage", ""],
  dice: ["dé", ""],
  game: ["jeu", ""],
  story: ["story", "e"],
  invoice: ["facture", "e"],
  paid_media: ["média payant", ""],
  checklist: ["liste", "e"],
  inconnu: ["message d'un type inconnu", ""],
};
export function kindLabel(kind) {
  return (KIND_LABELS[kind] ?? [kind, ""])[0];
}
export function kindReceived(kind) {
  const [label, agree] = KIND_LABELS[kind] ?? [kind, ""];
  return `${label} reçu${agree}`;
}
/** Type d'un message : text, voice, un type de fichier, un autre type connu, ou « inconnu ». */
export function messageKind(message) {
  if (typeof message?.text === "string") return "text";
  if (message?.voice) return "voice";
  for (const kind of [...FILE_KINDS, ...OTHER_KINDS]) if (message?.[kind]) return kind;
  return "inconnu";
}
/** Fichier d'un message : la plus grande taille d'une photo, sinon l'objet du type. */
export function fileOf(message, kind) {
  const value = message?.[kind];
  if (kind === "photo" && Array.isArray(value)) return value.at(-1) ?? null;
  return value && typeof value.file_id === "string" ? value : null;
}
/** `@handle` en tête de message (routage vers une room ou un agent) ; `null` sinon. */
export function leadHandle(text) {
  return leadHandles(text)[0] ?? null;
}
/** Tous les `@handle` consécutifs en tête (« @marco @vox salut » → ["marco", "vox"]), sans doublon. */
export function leadHandles(text) {
  const handles = [];
  const re = /^[\s,]*@([A-Za-z0-9][A-Za-z0-9_.-]*)/;
  let rest = text ?? "";
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    const handle = m[1].replace(/[.-]+$/, "").toLowerCase();
    if (!handles.includes(handle)) handles.push(handle);
    rest = rest.slice(m[0].length);
  }
  return handles;
}
/** Handles qui désignent le fil principal plutôt qu'une room ou un agent. */
export const MAIN_HANDLES = ["marco", "principal"];
/** Nom de fichier sûr (sans dossier ni caractère réservé de Windows). */
export function safeFileName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(-120);
  return clean || "fichier";
}
export const TRANSCRIBED = "[Vocal Telegram transcrit automatiquement]";
export const BOT_DOWNLOAD_MAX = 20_000_000;

export function chunks(text, size = 3900) {
  const result = [];
  let part = "";
  for (const char of text) {
    if (part.length + char.length > size) {
      result.push(part);
      part = "";
    }
    part += char;
  }
  if (part) result.push(part);
  return result;
}
/**
 * Code réseau d'un échec de fetch, sans secret (ECONNRESET, UND_ERR_SOCKET, TimeoutError…) :
 * la cause n'était pas journalisée, si bien que « réseau indisponible » ne disait rien.
 */
export function networkCode(error) {
  const cause = error?.cause;
  const raw = cause?.code ?? cause?.name ?? error?.code ?? error?.name ?? "unknown";
  return String(raw).replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "unknown";
}
/**
 * Délai dur d'un appel (pont gelé du 16 nov. 2026 : un getUpdates resté pendant des minutes
 * malgré AbortSignal.timeout, sans erreur ni lastPollAt). Minuteur propre et référencé : il
 * interrompt la requête et la lecture du corps, et rend la main même si le signal n'agit pas.
 */
export function withDeadline(ms, run) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Error(`délai de ${ms} ms dépassé`);
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([run(controller.signal), deadline]).finally(() => clearTimeout(timer));
}
export class TelegramApi {
  constructor(token, http = fetch, { deadlineMs } = {}) {
    this.token = token;
    this.http = http;
    this.deadlineMs = deadlineMs;
  }
  /** Délai d'un appel : l'attente longue de getUpdates plus 15 s, sinon 35 s. */
  deadline(method, input) {
    if (this.deadlineMs !== undefined) return this.deadlineMs;
    return method === "getUpdates" ? Math.max(0, Number(input.timeout) || 0) * 1000 + 15_000 : 35_000;
  }
  async call(method, input = {}) {
    let failure;
    const exchange = await withDeadline(this.deadline(method, input), async (signal) => {
      const response = await this.http(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        redirect: "error",
        signal,
      });
      return { response, body: await response.json() };
    }).catch((error) => {
      failure = error;
      return null;
    });
    if (exchange === null) {
      // Jamais l'URL (elle contient le jeton) : seulement un code.
      const code = networkCode(failure);
      const error = Error(`Telegram ${method} : réseau indisponible (${code})`);
      error.networkCode = code;
      throw error;
    }
    const { response, body } = exchange;
    if (!response.ok || !body.ok) {
      const error = Error(
        `Telegram ${method} : HTTP ${response.status}, code ${body.error_code ?? "unknown"}`,
      );
      error.retryAfter = body.parameters?.retry_after;
      error.telegramCode = body.error_code;
      throw error;
    }
    return body.result;
  }
  async voice(fileId) {
    return (await this.download(fileId)).bytes;
  }
  /** Fichier d'un message (getFile puis téléchargement), 20 Mo au plus (limite des bots). */
  async download(fileId) {
    const file = await this.call("getFile", { file_id: fileId });
    if (!file.file_path || file.file_size > 20_000_000) throw Error("Fichier trop volumineux");
    let response;
    try {
      response = await this.http(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw Error("Téléchargement indisponible");
    }
    if (!response.ok) throw Error("Téléchargement refusé");
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 20_000_000) {
        await response.body.cancel().catch(() => {});
        throw Error("Fichier trop volumineux");
      }
      parts.push(part);
    }
    return { bytes: Buffer.concat(parts), filePath: file.file_path };
  }
  async sendVoice(chat, bytes) {
    const form = new FormData();
    form.set("chat_id", String(chat));
    form.set("voice", new Blob([bytes], { type: "audio/ogg" }), "message.ogg");
    let response;
    try {
      response = await this.http(`https://api.telegram.org/bot${this.token}/sendVoice`, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw Error("Telegram sendVoice : réseau indisponible");
    }
    const body = await response.json();
    if (!response.ok || !body.ok) {
      const error = Error("Telegram sendVoice refusé");
      error.retryAfter = body.parameters?.retry_after;
      throw error;
    }
    return body.result;
  }
}

/** Single consumer. Telegram identities come only from Bot API metadata. */
export class TelegramBridge {
  constructor({
    dataDir,
    username,
    ownerId,
    api,
    readThread,
    receive,
    transcribe,
    speak,
    ownerSpeak = null,
    active = () => true,
    receiveContact,
    inboxDir = null,
    routeHandle = null,
    publicMessage = null,
    now = () => new Date(),
    typingIntervalMs = 4500,
    typingTimeoutMs = 180_000,
  }) {
    Object.assign(this, {
      username: username.replace(/^@/, "").toLowerCase(),
      api,
      readThread,
      receive,
      transcribe,
      speak,
      ownerSpeak,
      active,
      typingIntervalMs,
      typingTimeoutMs,
      inboxDir,
      routeHandle,
      publicMessage,
      now,
    });
    this.typing = null;
    this.receiveContact = receiveContact ?? contactInbox(dataDir);
    this.db = new Database(path.join(dataDir, "telegram.sqlite"));
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS sent(key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS incoming(id TEXT PRIMARY KEY,text TEXT);",
    );
    this.db.exec(CONTACT_SCHEMA);
    if (ownerId) {
      if (this.get("user") && this.get("user") !== String(ownerId))
        throw Error("Identité Telegram différente de celle déjà associée");
      this.set("user", ownerId);
      this.set("chat", ownerId);
    }
  }
  close() {
    this.stopTyping();
    this.db.close();
  }
  get(key) {
    return this.db.prepare("SELECT value FROM state WHERE key=?").get(key)?.value;
  }
  set(key, value) {
    this.db.prepare("INSERT OR REPLACE INTO state VALUES(?,?)").run(key, String(value));
  }
  keys(item) {
    const identity = `${item.from}:${item.id ?? item.at}`;
    return chunks(`[${item.from}${item.source ? ` · ${item.source}` : ""}]\n${item.text}`).map(
      (text, index) => ({ text, key: hash(`${identity}\0${item.text}\0${index}`) }),
    );
  }
  async outgoing() {
    if (!this.active()) return;
    const items = await this.readThread();
    // Start from the current thread without replaying its entire history.
    if (!this.get("initialized")) {
      this.db.transaction(() => {
        for (const item of items)
          for (const { key } of this.keys(item)) {
            this.db.prepare("INSERT OR IGNORE INTO sent VALUES(?)").run(key);
            this.db.prepare("INSERT OR IGNORE INTO sent VALUES(?)").run(key + ":voice");
          }
        this.set("initialized", 1);
      })();
      return;
    }
    const chat = this.get("chat");
    if (!chat) return;
    for (const item of items) {
      if (item.from === "activity") continue;
      // Texts/vocals received through Telegram are already visible there.
      if (item.from === "human" && item.id?.startsWith("tg-")) continue;
      for (const { text, key } of this.keys(item)) {
        if (!this.active()) return;
        if (!this.db.prepare("SELECT 1 FROM sent WHERE key=?").get(key)) {
          await this.api.call("sendMessage", { chat_id: chat, text });
          this.stopTyping();
          this.db.prepare("INSERT OR IGNORE INTO sent VALUES(?)").run(key);
        }
        if (this.speak && !this.db.prepare("SELECT 1 FROM sent WHERE key=?").get(key + ":voice")) {
          const audio = await this.speak(text);
          if (!this.active()) return;
          await this.api.sendVoice(chat, audio);
          this.db.prepare("INSERT OR IGNORE INTO sent VALUES(?)").run(key + ":voice");
        }
      }
    }
  }
  /**
   * Vocal après chaque message au propriétaire (telegram_send_owner), voir owner-voice.mjs.
   * Sans `ownerSpeak` (option coupée) : rien.
   */
  async ownerVoices(log) {
    if (typeof this.ownerSpeak !== "function" || !this.active()) return [];
    const chat = this.get("chat");
    if (!chat) return [];
    return ownerVoicePass({
      db: this.db,
      chat,
      speak: this.ownerSpeak,
      sendVoice: (to, bytes) => this.api.sendVoice(to, bytes),
      active: this.active,
      now: this.now,
      log,
    });
  }
  async incoming() {
    if (!this.active()) return;
    // Début du relevé : un pollStartedAt récent avec un lastPollAt figé signale un appel pendant.
    this.set("pollStartedAt", new Date().toISOString());
    const updates = await this.api.call("getUpdates", {
      offset: Number(this.get("offset") ?? 0),
      timeout: 5,
      allowed_updates: ["message"],
    });
    this.set("lastPollAt", new Date().toISOString());
    this.set("lastPollCount", updates.length);
    for (const update of updates) {
      if (!this.active()) return;
      const message = update.message;
      const user = message?.from;
      const pinned = this.get("user");
      const authorized =
        message?.chat?.type === "private" &&
        !user?.is_bot &&
        Number.isSafeInteger(user?.id) &&
        (pinned
          ? String(user.id) === pinned && String(message.chat.id) === this.get("chat")
          : user?.username?.toLowerCase() === this.username);
      if (authorized) {
        if (!pinned) {
          this.set("user", user.id);
          this.set("chat", message.chat.id);
        }
        const id = `tg-${message.chat.id}-${message.message_id}`;
        let text = this.db.prepare("SELECT text FROM incoming WHERE id=?").get(id)?.text;
        if (text === undefined) {
          const owner = await this.ownerText(message);
          text = owner.text;
          if (owner.reply) await this.notifyOwner(message.chat.id, owner.reply);
          if (text && text !== "/start")
            this.db.prepare("INSERT OR IGNORE INTO incoming VALUES(?,?)").run(id, text);
        }
        if (text === "/start")
          await this.api.call("sendMessage", {
            chat_id: message.chat.id,
            text: "MIND Wake connecté. Tes textes et vocaux sont transmis à ton agent ; le fil est relayé ici.",
          });
        else if (text) {
          if (!this.active()) return;
          const lead = text.startsWith(`${TRANSCRIBED}\n`)
            ? text.slice(TRANSCRIBED.length + 1)
            : (message.text ?? message.caption ?? "");
          const delivered = await this.routeOwner(message.chat.id, leadHandles(lead), text, id);
          if (delivered !== "routed") {
            const body = delivered === null ? text : `${delivered}\n${text}`;
            const parts = chunks(body, 4000);
            for (let i = 0; i < parts.length; i++)
              await this.receive(parts[i], parts.length === 1 ? id : `${id}-${i}`);
            this.startTyping(message.chat.id);
          }
        }
      } else if (this.isContact(message, user, pinned)) {
        if (!this.active()) return;
        await this.contact(message, user);
      } else if (
        (message?.chat?.type === "supergroup" || message?.chat?.type === "group") &&
        typeof this.publicMessage === "function"
      ) {
        // Groupe public (Crypto, NLR 16 nov. 17:01) : un échec est noté, jamais rejoué en boucle.
        try {
          await this.publicMessage(message);
        } catch (error) {
          console.error(`Telegram public : ${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
      this.set("offset", update.update_id + 1);
    }
  }
  /** Une ligne au propriétaire ; un échec d'envoi n'empêche pas la remise au fil. */
  async notifyOwner(chat, text) {
    try {
      await this.api.call("sendMessage", { chat_id: chat, text });
    } catch (error) {
      try {
        this.set(
          "notifyError",
          JSON.stringify({ at: new Date().toISOString(), code: error?.telegramCode ?? "local/network" }),
        );
      } catch {}
    }
  }
  /**
   * Texte remis à l'agent pour un message du propriétaire, quel que soit son type, et la ligne
   * éventuelle à lui renvoyer. Jamais de texte vide : tout message laisse une trace dans le fil.
   */
  async ownerText(message) {
    const kind = messageKind(message);
    const caption =
      typeof message.caption === "string" && message.caption !== "" ? message.caption : null;
    const withCaption = (head) => (caption === null ? head : `${head}\nLégende : ${caption}`);
    const reason = (error) => String(error?.message ?? error).slice(0, 120);
    if (kind === "text") return { text: message.text };
    if (kind === "voice") {
      let bytes;
      try {
        bytes = await this.api.voice(message.voice.file_id);
      } catch (error) {
        return {
          text: `[Telegram : vocal reçu, téléchargement impossible (${reason(error)})]`,
          reply: "Ce vocal n’a pas pu être téléchargé ; l’agent est prévenu. Renvoie-le ou envoie son texte.",
        };
      }
      try {
        return { text: `${TRANSCRIBED}\n${await this.transcribe(bytes)}` };
      } catch (error) {
        const saved = this.saveInbox(message, bytes, "voice.ogg");
        return {
          text: `[Telegram : vocal reçu, transcription impossible (${reason(error)})]${saved ? `\nFichier : ${saved}` : ""}`,
          reply: "Ce vocal n’a pas pu être transcrit ; l’agent est prévenu (fichier gardé). Renvoie-le ou envoie son texte.",
        };
      }
    }
    if (FILE_KINDS.includes(kind)) {
      const file = fileOf(message, kind);
      const what = kindReceived(kind);
      if (file === null)
        return {
          text: withCaption(`[Telegram : ${what}, fichier absent]`),
          reply: `Reçu : ${kindLabel(kind)} sans fichier lisible ; l’agent est prévenu.`,
        };
      if (Number(file.file_size) > BOT_DOWNLOAD_MAX)
        return {
          text: withCaption(
            `[Telegram : ${what}, trop gros pour le bot (${Math.round(file.file_size / 1e6)} Mo, 20 Mo au plus) : non téléchargé]`,
          ),
          reply: `Reçu : ${kindLabel(kind)} de plus de 20 Mo, que le bot ne peut pas télécharger ; l’agent est prévenu.`,
        };
      try {
        const { bytes, filePath } = await this.api.download(file.file_id);
        const name = file.file_name ?? `${kind}${path.extname(filePath ?? "")}`;
        const saved = this.saveInbox(message, bytes, name);
        if (saved === null)
          return {
            text: withCaption(`[Telegram : ${what}, aucun dossier d'inbox configuré : non enregistré]`),
            reply: "Fichier reçu mais non enregistré (inbox absente) ; l’agent est prévenu.",
          };
        return { text: withCaption(`[Telegram : ${what}]\nFichier : ${saved}`) };
      } catch (error) {
        return {
          text: withCaption(`[Telegram : ${what}, téléchargement impossible (${reason(error)})]`),
          reply: `Reçu : ${kindLabel(kind)}, mais le téléchargement a échoué ; l’agent est prévenu.`,
        };
      }
    }
    const detail = kind === "sticker" && message.sticker?.emoji ? ` (${message.sticker.emoji})` : "";
    return {
      text: withCaption(`[Telegram : ${kindReceived(kind)}${detail}, non pris en charge]`),
      reply: `Reçu : ${kindLabel(kind)}, type non pris en charge ; l’agent est prévenu.`,
    };
  }
  /** Fichier reçu → `<inbox>/<date>/<message_id>-<nom>` ; chemin absolu, ou `null` sans inbox. */
  saveInbox(message, bytes, name) {
    const root = typeof this.inboxDir === "function" ? this.inboxDir() : this.inboxDir;
    if (!root) return null;
    const dir = path.join(root, this.now().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${message.message_id}-${safeFileName(name)}`);
    fs.writeFileSync(file, bytes);
    return file;
  }
  /**
   * Routage `@handle` (NLR, 16 nov. 2026) : un message qui commence par le handle d'une room ou
   * d'un agent part dans ce fil-là. Rend "routed", `null` (fil principal, rien à signaler) ou une
   * ligne à placer en tête du message laissé au fil principal.
   * Plusieurs handles en tête : chacun reçoit le message ; `@marco`/`@principal` (ou le handle
   * propriétaire) vise le fil principal, qui reçoit aussi le message si un routage échoue.
   */
  async routeOwner(chat, handles, text, id) {
    const list = Array.isArray(handles) ? handles : handles == null ? [] : [handles];
    const main = list.some((h) => MAIN_HANDLES.includes(h) || h === this.username);
    const targets = list.filter((h) => !MAIN_HANDLES.includes(h) && h !== this.username);
    if (targets.length === 0 || typeof this.routeHandle !== "function") return null;
    const notes = [];
    for (const handle of targets) notes.push(await this.routeOne(chat, handle, text, id));
    // "main" : pattern holder du fil principal, qui garde le message (sans note).
    const failures = notes.filter((n) => n !== "routed" && n !== "main");
    if (failures.length === 0 && !main && !notes.includes("main")) return "routed";
    return failures.length ? failures.join("\n") : null;
  }
  async routeOne(chat, handle, text, id) {
    let result;
    try {
      result = await this.routeHandle(handle, text, id);
    } catch (error) {
      await this.notifyOwner(chat, `Routage vers @${handle} impossible ; message laissé au fil principal.`);
      return `[Telegram : routage vers @${handle} impossible (${String(error?.message ?? error).slice(0, 120)}), message laissé au fil principal]`;
    }
    if (result?.status === "routed") {
      await this.notifyOwner(chat, `→ ${result.label ?? `@${handle}`}`);
      return "routed";
    }
    if (result?.status === "main") {
      // Pattern holder du fil principal : il s'y réveille sur la mention `@slug` ; si NLR a
      // écrit son nom plutôt que son slug, la mention est ajoutée en tête du message.
      await this.notifyOwner(chat, `→ ${result.label ?? `@${handle}`}`);
      return !result.mention || result.mention === `@${handle}` ? "main" : result.mention;
    }
    const known = (result?.known ?? []).map((h) => `@${h}`).join(", ");
    await this.notifyOwner(
      chat,
      `personne de ce nom : @${handle}${known ? ` — handles connus : ${known}` : ""}`,
    );
    return `[Telegram : @${handle} inconnu, message laissé au fil principal]`;
  }
  /**
   * NLR, 16 nov. 2026 13:13 : « … » visible dès que son message est remis à l'agent.
   * sendChatAction typing dure ~5 s côté Telegram : renouvelé toutes les typingIntervalMs
   * jusqu'à une réponse au propriétaire (telegram_send_owner écrit channel_outgoing, channel
   * 'owner', dans la même base) ou typingTimeoutMs. Les erreurs sont notées, jamais propagées.
   */
  startTyping(chat) {
    this.stopTyping();
    const typing = { chat, since: new Date().toISOString(), started: Date.now(), busy: false };
    this.typing = typing;
    const tick = async () => {
      if (this.typing !== typing || typing.busy) return;
      typing.busy = true;
      try {
        if (
          Date.now() - typing.started >= this.typingTimeoutMs ||
          !this.active() ||
          this.ownerRepliedSince(typing.since)
        )
          return this.stopTyping(typing);
        await this.api.call("sendChatAction", { chat_id: chat, action: "typing" });
      } catch (error) {
        try {
          this.set(
            "typingError",
            JSON.stringify({ at: new Date().toISOString(), code: error?.telegramCode ?? "local/network" }),
          );
        } catch {}
      } finally {
        typing.busy = false;
      }
    };
    typing.timer = setInterval(() => void tick(), this.typingIntervalMs);
    typing.timer.unref?.();
    void tick();
  }
  /** Arrête l'indicateur courant (ou seulement `which` s'il est encore le courant). */
  stopTyping(which) {
    const typing = this.typing;
    if (!typing || (which && which !== typing)) return;
    clearInterval(typing.timer);
    this.typing = null;
  }
  /** Une réponse au propriétaire (même en cours d'envoi) depuis `since` ; table absente = non. */
  ownerRepliedSince(since) {
    try {
      return Boolean(
        this.db
          .prepare("SELECT 1 FROM channel_outgoing WHERE channel='owner' AND at>=? LIMIT 1")
          .get(since),
      );
    } catch {
      return false;
    }
  }
  /** Humain en message privé qui n'est pas le propriétaire : jamais traité comme lui. */
  isContact(message, user, pinned) {
    return (
      message?.chat?.type === "private" &&
      !user?.is_bot &&
      Number.isSafeInteger(user?.id) &&
      Number.isSafeInteger(message.chat.id) &&
      String(message.chat.id) === String(user.id) &&
      String(user.id) !== pinned &&
      String(message.chat.id) !== this.get("chat") &&
      user.username?.toLowerCase() !== this.username
    );
  }
  /** Garde le contact et son message, salue une fois sur /start, dépose le texte pour le principal. */
  async contact(message, user) {
    const chat = String(message.chat.id);
    const at = new Date(
      Number.isSafeInteger(message.date) ? message.date * 1000 : Date.now(),
    ).toISOString();
    this.db
      .prepare(
        "INSERT INTO contacts(chat_id,user_id,username,first_name,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET user_id=excluded.user_id,username=excluded.username,first_name=excluded.first_name,last_seen=max(last_seen,excluded.last_seen)",
      )
      .run(chat, String(user.id), user.username ?? null, user.first_name ?? null, at);
    const id = `tg-contact-${chat}-${message.message_id}`;
    let row = this.db.prepare("SELECT text,delivered_at FROM contact_incoming WHERE id=?").get(id);
    if (!row) {
      let text;
      if (message.voice) {
        const bytes = await this.api.voice(message.voice.file_id);
        try {
          text = `[Vocal Telegram transcrit automatiquement]\n${await this.transcribe(bytes)}`;
        } catch {
          text = "[Vocal Telegram : transcription impossible, aucun texte]";
        }
      } else if (typeof message.text === "string" && message.text !== "") text = message.text;
      else
        text = `[Message Telegram sans texte${typeof message.caption === "string" ? ` ; légende : ${message.caption}` : ""}]`;
      this.db
        .prepare("INSERT OR IGNORE INTO contact_incoming(id,chat_id,text,at) VALUES(?,?,?,?)")
        .run(id, chat, text, at);
      row = { text, delivered_at: null };
    }
    const start = /^\/start(\s|$)/.test(row.text);
    if (
      start &&
      !this.db.prepare("SELECT greeted_at FROM contacts WHERE chat_id=?").get(chat)?.greeted_at
    ) {
      await this.api.call("sendMessage", { chat_id: message.chat.id, text: CONTACT_GREETING });
      this.db
        .prepare("UPDATE contacts SET greeted_at=? WHERE chat_id=?")
        .run(new Date().toISOString(), chat);
    }
    if (!row.delivered_at) {
      await this.receiveContact({
        chatId: message.chat.id,
        userId: user.id,
        username: user.username ?? null,
        firstName: user.first_name ?? null,
        messageId: message.message_id,
        at,
        text: start ? `${row.text}\n[a lancé le bot : il peut maintenant recevoir un message]` : row.text,
      });
      this.db
        .prepare("UPDATE contact_incoming SET delivered_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
    }
  }
}
