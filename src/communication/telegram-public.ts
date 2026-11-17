/**
 * Groupe public Telegram (@mindprotocol_ai, un supergroupe où le bot est admin) et Crypto
 * (NLR, 16 nov. 2026 17:01 : « Quand on reçoit un message sur le main-channel, est-ce que tu
 * peux réveiller Crypto, en lui demandant de répondre si besoin ? »).
 *
 * 1. Chaque nouveau message public d'une personne (ni bot, ni NLR, ni compte de canal) entre au
 *    fil principal comme message qui mentionne @crypto ; le holder s'y réveille comme d'habitude.
 * 2. Sa réponse au fil principal (clé `pattern-holder:crypto:<id du message>`) est postée par le
 *    code dans le groupe, en réponse au message d'origine, sous ces gardes : réponse non vide et
 *    pas « [rien] » ; aucun prix, rendement, date de lancement, adresse de mint ou de wallet, ni
 *    demande de wallet (sinon brouillon envoyé à NLR) ; 20 réponses publiques par 24 h au plus,
 *    une par message ; jamais à un bot, jamais à une réponse au bot, jamais en privé.
 * 3. NLR reçoit une ligne avec le lien à chaque réponse postée.
 * 4. Copie au coach de la personne si le registre des coachs liste exactement son @username ou
 *    son id Telegram : notice ciblée dans sa room, sinon `<coach>/canal-public.md`.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { OwnerMessages } from "./owner-messages.js";
import { sendNoticeToFork } from "../daemon/forks.js";
import { roomAgentIndex } from "./room-handle-wake.js";
import { workspaceDirFor } from "../daemon/paths.js";

export const PUBLIC_REPLY_CAP = 20;
const DAY_MS = 24 * 60 * 60_000;
/** Délai après lequel un message sans réponse de Crypto est classé sans suite. */
const REPLY_WAIT_MS = 30 * 60_000;
export const CRYPTO_SLUG = "crypto";
/** Convention : Crypto répond exactement `[rien]` quand il n'y a rien à dire publiquement. */
export const PUBLIC_SKIP_MARKER = "[rien]";
const HOLDER_KEY = `pattern-holder:${CRYPTO_SLUG}:`;

export interface TelegramUser {
  id?: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}
export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: TelegramUser;
  sender_chat?: unknown;
  is_automatic_forward?: boolean;
  text?: string;
  caption?: string;
  reply_to_message?: { from?: TelegramUser };
}
export interface TelegramCall {
  call(method: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Sujets que Crypto ne publie jamais lui-même : brouillon pour NLR à la place. */
export const PUBLIC_RISKS: readonly { readonly reason: string; readonly pattern: RegExp }[] = [
  { reason: "prix", pattern: /\b(prix|price|cours|market ?cap|mcap|valorisation|valuation|pump|moon|ath|x\d{1,3})\b/iu },
  { reason: "rendement", pattern: /\b(rendements?|yields?|apy|apr|roi|returns?|profits?|gains?|int[ée]r[êe]ts?|rewards?|r[ée]compenses?|staking|passive income|revenu passif|garanti[es]?|guaranteed)\b/iu },
  { reason: "lancement", pattern: /\b(lancement|launch(es|ed|ing)?|listing|list[ée]e?s?|tge|airdrop|presale|pr[ée]-?vente|ico|ido|ieo|whitelist)\b/iu },
  { reason: "adresse", pattern: /\b(mint|contract address|adresse (du|de) (token|contrat|mint)|CA\s*:)|\b0x[0-9a-fA-F]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/u },
  { reason: "wallet", pattern: /\b(wallets?|portefeuilles?|seed|phrase (secr[èe]te|de r[ée]cup[ée]ration)|private key|cl[ée] priv[ée]e|connect(e|ez)? (ton|votre|your) wallet|send (me|us)|envo(ie|yez)[- ](moi|nous))\b/iu },
];

export function publicRisks(text: string): string[] {
  return PUBLIC_RISKS.filter((r) => r.pattern.test(text)).map((r) => r.reason);
}

/** Texte publiable de la réponse de Crypto, ou `null` (vide, `[rien]`, notes de sections seules). */
export function publicReplyText(raw: string, prefix = "🪙 Crypto · "): string | null {
  let text = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  text = text
    .split("\n")
    .filter((l) => !/^\(section .*\)$/.test(l.trim()))
    .join("\n")
    .trim();
  const bare = text.replace(/^[«"“]|[»"”]$/g, "").trim().toLowerCase();
  if (bare === "" || bare === "silence" || bare === "—" || bare === "-" || bare === "rien" || bare.startsWith(PUBLIC_SKIP_MARKER))
    return null;
  return text;
}

function displayName(user: TelegramUser | undefined): string {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return user?.username ? `${name || user.username} (@${user.username})` : name || "anonyme";
}

export function cryptoPrompt(chatTitle: string, author: string, text: string): string {
  return `@${CRYPTO_SLUG}: nouveau message public sur ${chatTitle}, de ${author}: «${text}». Réponds seulement si c'est une question ou si une réponse aide; sinon réponds exactement ${PUBLIC_SKIP_MARKER}. Ta réponse sera postée telle quelle dans le groupe public, en réponse à ce message : jamais de prix, de rendement, de date de lancement, d'adresse ni de demande de wallet.`;
}

interface Row {
  chat_id: string;
  message_id: number;
  chat_username: string | null;
  chat_title: string;
  author: string;
  text: string;
  at: string;
  owner_message_id: string;
  status: string;
}

export class TelegramPublic {
  readonly #db: Database.Database;
  constructor(
    private readonly dataDir: string,
    private readonly options: {
      /** Username du groupe public, sans @ (ex. « mindprotocol_ai »). */
      readonly chat: string;
      readonly api: TelegramCall;
      /** Chat privé de NLR avec le bot (état `chat` du bridge). */
      readonly ownerChat: () => string | undefined;
      /** Id Telegram de NLR (état `user` du bridge). */
      readonly ownerUser: () => string | undefined;
      readonly log?: (line: string) => void;
      readonly now?: () => number;
    },
  ) {
    this.#db = new Database(path.join(dataDir, "telegram.sqlite"));
    this.#db.pragma("busy_timeout = 5000");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS public_messages(chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,chat_username TEXT,chat_title TEXT NOT NULL,user_id TEXT,author TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,owner_message_id TEXT NOT NULL,status TEXT NOT NULL,reply_message_id TEXT,decided_at TEXT,detail TEXT,PRIMARY KEY(chat_id,message_id));",
    );
  }
  close(): void {
    this.#db.close();
  }
  #now(): number {
    return (this.options.now ?? Date.now)();
  }
  #log(line: string): void {
    this.options.log?.(line);
  }

  /** Vrai si ce message de groupe vient d'une personne du groupe public suivi. */
  accepts(message: TelegramMessage): boolean {
    const chat = message.chat;
    if (chat.type !== "supergroup" && chat.type !== "group") return false;
    if ((chat.username ?? "").toLowerCase() !== this.options.chat.replace(/^@/, "").toLowerCase()) return false;
    const from = message.from;
    if (from === undefined || from.is_bot === true || !Number.isSafeInteger(from.id)) return false;
    // Compte de canal, admin anonyme ou transfert automatique : pas une personne.
    if (message.sender_chat !== undefined || message.is_automatic_forward === true) return false;
    if (String(from.id) === this.options.ownerUser()) return false;
    // Réponse à un message d'un bot (dont le nôtre) : jamais de réponse, pas de boucle.
    if (message.reply_to_message?.from?.is_bot === true) return false;
    const text = (message.text ?? message.caption ?? "").trim();
    return text !== "";
  }

  /** Enregistre le message, le dépose au fil principal pour Crypto et copie son coach. Idempotent. */
  receive(message: TelegramMessage): "delivered" | "duplicate" | "ignored" {
    if (!this.accepts(message)) return "ignored";
    const chatId = String(message.chat.id);
    const prior = this.#db.prepare("SELECT 1 FROM public_messages WHERE chat_id=? AND message_id=?").get(chatId, message.message_id);
    if (prior !== undefined) return "duplicate";
    const text = (message.text ?? message.caption ?? "").trim().slice(0, 2500);
    const author = displayName(message.from);
    const title = message.chat.title ?? `@${message.chat.username ?? chatId}`;
    const at = new Date(Number.isSafeInteger(message.date) ? (message.date ?? 0) * 1000 : this.#now()).toISOString();
    const messages = new OwnerMessages(this.dataDir, "claude-wake");
    let ownerId: string;
    try {
      ownerId = messages.publish(cryptoPrompt(title, author, text), `telegram-public:${chatId}:${String(message.message_id)}`).id;
    } finally {
      messages.close();
    }
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO public_messages(chat_id,message_id,chat_username,chat_title,user_id,author,text,at,owner_message_id,status) VALUES(?,?,?,?,?,?,?,?,?,'waiting')",
      )
      .run(chatId, message.message_id, message.chat.username ?? null, title, String(message.from?.id ?? ""), author, text, at, ownerId);
    this.#log(`public : message ${String(message.message_id)} de ${author} remis à @${CRYPTO_SLUG}`);
    try {
      this.copyToCoach(message, title, author, text);
    } catch (error) {
      this.#log(`public : copie au coach en échec — ${String(error)}`);
    }
    return "delivered";
  }

  /**
   * Copie au coach si le registre liste exactement le @username ou l'id Telegram de l'auteur.
   * Coach agent d'une room : notice ciblée ; sinon ligne dans `<coach>/canal-public.md`.
   */
  copyToCoach(message: TelegramMessage, title: string, author: string, text: string): string | null {
    const holders = path.join(workspaceDirFor(this.dataDir), "artifacts", "pattern-holders");
    let registry: { personnes?: { id?: string; coach?: string; handles?: { plateforme?: string; handle?: string; id?: number }[] }[] };
    try {
      registry = JSON.parse(fs.readFileSync(path.join(holders, "COACHS-REGISTRE.json"), "utf8")) as typeof registry;
    } catch {
      return null;
    }
    const username = message.from?.username?.toLowerCase();
    const userId = message.from?.id;
    const person = (registry.personnes ?? []).find((p) =>
      (p.handles ?? []).some(
        (h) =>
          (h.plateforme ?? "").toLowerCase() === "telegram" &&
          ((userId !== undefined && h.id === userId) ||
            (username !== undefined && typeof h.handle === "string" && h.handle.replace(/^@/, "").toLowerCase() === username)),
      ),
    );
    const coach = person?.coach;
    if (coach === undefined || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(coach)) return null;
    const line = `Canal public (${title}) [${new Date(this.#now()).toISOString()}] : ${author}, que tu suis (${person?.id ?? "?"}), a écrit : «${text}». Crypto peut y répondre publiquement ; toi, rien de public ni de privé à rapporter là-bas.`;
    const home = roomAgentIndex(this.dataDir).get(coach);
    if (home !== undefined) {
      sendNoticeToFork(this.dataDir, home.room, line, `public-copy:${String(message.chat.id).replace("-", "m")}:${String(message.message_id)}:${coach}`.slice(0, 128), `Canal public → ${home.agent.name}`);
      this.#log(`public : copie à ${home.agent.name} (Room ${String(home.room)})`);
      return `room:${String(home.room)}`;
    }
    const dir = path.join(holders, coach);
    if (!fs.existsSync(dir)) return null;
    fs.appendFileSync(path.join(dir, "canal-public.md"), `- ${line}\n`);
    this.#log(`public : copie à ${coach} (canal-public.md)`);
    return "file";
  }

  /** Poste les réponses de Crypto arrivées au fil principal, sous les gardes. */
  async tick(): Promise<void> {
    const waiting = this.#db.prepare("SELECT * FROM public_messages WHERE status='waiting' ORDER BY at").all() as Row[];
    if (waiting.length === 0) return;
    const file = path.join(this.dataDir, "owner-messages.sqlite");
    if (!fs.existsSync(file)) return;
    const owner = new Database(file, { readonly: true, fileMustExist: true });
    try {
      for (const row of waiting) {
        const reply = owner
          .prepare("SELECT id,text FROM messages WHERE request_key=? AND deleted=0")
          .get(`${HOLDER_KEY}${row.owner_message_id}`) as { id: string; text: string } | undefined;
        if (reply === undefined) {
          if (this.#now() - Date.parse(row.at) > REPLY_WAIT_MS) this.#decide(row, "silent", "pas de réponse de Crypto");
          continue;
        }
        await this.#handle(row, reply.text);
      }
    } finally {
      owner.close();
    }
  }

  #decide(row: Row, status: string, detail: string | null, replyId: string | null = null): void {
    this.#db
      .prepare("UPDATE public_messages SET status=?,detail=?,reply_message_id=?,decided_at=? WHERE chat_id=? AND message_id=?")
      .run(status, detail, replyId, new Date(this.#now()).toISOString(), row.chat_id, row.message_id);
  }

  async #toOwner(text: string): Promise<void> {
    const chat = this.options.ownerChat();
    if (!chat) return;
    try {
      await this.options.api.call("sendMessage", { chat_id: chat, text: text.slice(0, 4000) });
    } catch (error) {
      this.#log(`public : message à NLR en échec — ${String(error)}`);
    }
  }

  async #handle(row: Row, raw: string): Promise<void> {
    const text = publicReplyText(raw);
    if (text === null) return this.#decide(row, "skipped", "Crypto : rien à répondre");
    const risks = publicRisks(text);
    if (risks.length > 0) {
      this.#decide(row, "draft", `garde : ${risks.join(", ")}`);
      await this.#toOwner(
        `🪙 Crypto, brouillon non publié (${risks.join(", ")}) — réponse à ${row.author} sur ${row.chat_title} :\n\n${text}`,
      );
      return;
    }
    const since = new Date(this.#now() - DAY_MS).toISOString();
    const posted = (this.#db.prepare("SELECT count(*) AS n FROM public_messages WHERE status='posted' AND decided_at>=?").get(since) as { n: number }).n;
    if (posted >= PUBLIC_REPLY_CAP) {
      this.#decide(row, "capped", `plafond de ${String(PUBLIC_REPLY_CAP)} réponses publiques sur 24 h`);
      this.#log(`public : plafond atteint, réponse à ${String(row.message_id)} non postée`);
      return;
    }
    // Réservée avant l'envoi : jamais deux réponses au même message, même après une panne.
    this.#decide(row, "posting", null);
    let sent: { message_id?: number } | undefined;
    try {
      // Jamais en privé : uniquement le groupe d'où vient le message, en réponse à ce message.
      if (!row.chat_id.startsWith("-")) throw Error("chat non public");
      sent = (await this.options.api.call("sendMessage", {
        chat_id: row.chat_id,
        text: text.slice(0, 4000),
        reply_parameters: { message_id: row.message_id, allow_sending_without_reply: false },
      })) as { message_id?: number };
    } catch (error) {
      this.#decide(row, "failed", String(error).slice(0, 300));
      this.#log(`public : réponse à ${String(row.message_id)} en échec — ${String(error)}`);
      return;
    }
    const replyId = sent?.message_id === undefined ? null : String(sent.message_id);
    this.#decide(row, "posted", null, replyId);
    const link = row.chat_username && replyId ? `https://t.me/${row.chat_username}/${replyId}` : "(lien indisponible)";
    this.#log(`public : Crypto a répondu à ${String(row.message_id)} (${link})`);
    await this.#toOwner(`🪙 Crypto a répondu à ${row.author} sur ${row.chat_title} : ${link}`);
  }
}
