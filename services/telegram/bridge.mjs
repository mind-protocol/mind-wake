import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
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
export class TelegramApi {
  constructor(token, http = fetch) {
    this.token = token;
    this.http = http;
  }
  async call(method, input = {}) {
    let response;
    try {
      response = await this.http(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw Error(`Telegram ${method} : réseau indisponible`);
    }
    const body = await response.json();
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
    const file = await this.call("getFile", { file_id: fileId });
    if (!file.file_path || file.file_size > 20_000_000) throw Error("Vocal trop volumineux");
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
      throw Error("Téléchargement du vocal indisponible");
    }
    if (!response.ok) throw Error("Téléchargement du vocal refusé");
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 20_000_000) {
        await response.body.cancel().catch(() => {});
        throw Error("Vocal trop volumineux");
      }
      parts.push(part);
    }
    return Buffer.concat(parts);
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
    active = () => true,
  }) {
    Object.assign(this, {
      username: username.replace(/^@/, "").toLowerCase(),
      api,
      readThread,
      receive,
      transcribe,
      speak,
      active,
    });
    this.db = new Database(path.join(dataDir, "telegram.sqlite"));
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS sent(key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS incoming(id TEXT PRIMARY KEY,text TEXT);",
    );
    if (ownerId) {
      if (this.get("user") && this.get("user") !== String(ownerId))
        throw Error("Identité Telegram différente de celle déjà associée");
      this.set("user", ownerId);
      this.set("chat", ownerId);
    }
  }
  close() {
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
  async incoming() {
    if (!this.active()) return;
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
          if (message.voice) {
            const bytes = await this.api.voice(message.voice.file_id);
            try {
              text = `[Vocal Telegram transcrit automatiquement]\n${await this.transcribe(bytes)}`;
            } catch {
              await this.api.call("sendMessage", {
                chat_id: message.chat.id,
                text: "Ce vocal n’a pas pu être transcrit. Renvoie-le ou envoie son texte ; aucun texte n’a été transmis à l’agent.",
              });
              this.set("offset", update.update_id + 1);
              continue;
            }
          } else text = message.text;
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
          const parts = chunks(text, 4000);
          for (let i = 0; i < parts.length; i++)
            await this.receive(parts[i], parts.length === 1 ? id : `${id}-${i}`);
        } else
          await this.api.call("sendMessage", {
            chat_id: message.chat.id,
            text: "Envoie un texte ou un message vocal.",
          });
      }
      this.set("offset", update.update_id + 1);
    }
  }
}
