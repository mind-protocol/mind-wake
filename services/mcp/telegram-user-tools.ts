/**
 * Écrire depuis le compte Telegram personnel de NLR (mandat du 16 nov. 2026), par le sidecar
 * Telethon `services/telegram/user_account.py`. Le bot ne peut pas écrire le premier ; ce compte,
 * lui, écrit à n'importe quel dialogue. Garde-fous : clé d'idempotence obligatoire journalisée dans
 * `telegram.sqlite` (table `user_outgoing`, même réservation que `contact_outgoing`), 5 s au moins
 * entre deux envois (anti-spam). Aucun plafond quotidien (NLR, 16 nov. 2026 13:00) : seule limite,
 * le FloodWait de Telegram — attente de N s puis un seul nouvel essai si N ≤ 60, sinon refus qui
 * rend le délai (`retry_after_seconds`).
 *
 * Secrets : `telegram-user.json` (api_id, api_hash, phone) n'est jamais ouvert ici ; seul le sidecar
 * le lit. Réglages par variables : `MIND_WAKE_TELEGRAM_USER_PYTHON`, `MIND_WAKE_TELEGRAM_USER_MIN_INTERVAL_S`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { TELEGRAM_TEXT_MAX, TelegramContactError } from "./telegram-tools.js";
import { MediaError, resolveWorkspaceFile } from "./media-tools.js";
import { workspaceDirFor } from "../../src/daemon/paths.js";
import {
  coachContactTarget,
  findCoachContact,
  readCoachContacts,
  type CoachContact,
} from "../../src/daemon/telegram-coach-inbound.js";

export const USER_OUTGOING_SCHEMA =
  "CREATE TABLE IF NOT EXISTS user_outgoing(key TEXT PRIMARY KEY,target TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,peer_id TEXT,peer_name TEXT); CREATE INDEX IF NOT EXISTS user_outgoing_at ON user_outgoing(at);";
export const USER_DEFAULT_MIN_INTERVAL_S = 5;
/** FloodWait de Telegram au plus égal à ce délai : attente puis un seul nouvel essai. */
export const USER_FLOOD_WAIT_RETRY_MAX_S = 60;
/** Préfixe des clés d'envoi des coachs Telegram dans `user_outgoing`. */
export const COACH_KEY_PREFIX = "coach:";
export const USER_SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../telegram/user_account.py");

/** Réponse JSON du sidecar : `ok: true` et données, ou `ok: false` avec un code d'erreur. */
export type UserSidecarResult = { ok: true; [key: string]: unknown } | {
  ok: false;
  error: string;
  message: string;
  /** true : rien n'a pu partir. false : issue incertaine. */
  definite?: boolean;
  /** FloodWait : secondes imposées par Telegram. */
  seconds?: number;
};
/** Lance le sidecar avec ces arguments ; `stdin` porte le texte d'un envoi. */
export type UserSidecar = (args: string[], stdin?: string) => Promise<UserSidecarResult>;

/** Python du sidecar : variable, puis celui de la transcription (telegram.json), puis `python`. */
export function userPythonFor(dataDir: string, env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env["MIND_WAKE_TELEGRAM_USER_PYTHON"]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const python = (
      JSON.parse(fs.readFileSync(path.join(dataDir, "telegram.json"), "utf8")) as { transcription?: { python?: unknown } }
    ).transcription?.python;
    if (typeof python === "string" && python.trim() !== "") return python.trim();
  } catch {
    // Pas de configuration du bridge : Python du PATH.
  }
  return "python";
}

/** Sidecar réel. stderr est jeté (jamais journalisé) ; seule la dernière ligne JSON de stdout compte. */
export function pythonUserSidecar(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = 90_000,
): UserSidecar {
  return (args, stdin) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(userPythonFor(dataDir, env), [USER_SIDECAR, "--data-dir", dataDir, ...args], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        });
      } catch {
        resolve({ ok: false, error: "python_missing", message: "Python introuvable pour le sidecar Telegram.", definite: true });
        return;
      }
      let out = "";
      let settled = false;
      const finish = (value: UserSidecarResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, error: "timeout", message: "Sidecar Telegram trop long ; issue incertaine.", definite: false });
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        out += part;
      });
      child.on("error", () =>
        finish({ ok: false, error: "python_missing", message: "Python introuvable pour le sidecar Telegram.", definite: true }),
      );
      child.on("close", () => {
        const line = out.trim().split(/\r?\n/).pop() ?? "";
        try {
          const parsed = JSON.parse(line) as UserSidecarResult;
          if (typeof parsed === "object" && parsed !== null && typeof parsed.ok === "boolean") return finish(parsed);
        } catch {
          // Sortie illisible ci-dessous.
        }
        finish({ ok: false, error: "sidecar_failed", message: "Sidecar Telegram sans réponse lisible.", definite: false });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "", "utf8");
    });
}

export class TelegramUserAccount {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly dataDir: string,
    private readonly sidecar: UserSidecar,
    options: {
      minIntervalSeconds?: number | undefined;
      now?: (() => number) | undefined;
      sleep?: ((ms: number) => Promise<void>) | undefined;
      workspace?: (() => string) | undefined;
    } = {},
  ) {
    this.minIntervalMs = 1000 * (options.minIntervalSeconds ?? USER_DEFAULT_MIN_INTERVAL_S);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.workspace = options.workspace ?? (() => workspaceDirFor(dataDir));
  }
  private readonly workspace: () => string;

  /**
   * Appel avec le FloodWait de Telegram : attente imposée (≤ 60 s) puis un seul nouvel essai ;
   * au-delà, refus net qui rend le délai. Un FloodWait signifie que rien n'est parti.
   */
  private async callFlood(args: string[], stdin?: string): Promise<UserSidecarResult> {
    let result = await this.call(args, stdin);
    const wait = TelegramUserAccount.floodSeconds(result);
    if (wait !== null && wait <= USER_FLOOD_WAIT_RETRY_MAX_S) {
      await this.sleep(wait * 1000 + 500);
      result = await this.call(args, stdin);
    }
    const again = TelegramUserAccount.floodSeconds(result);
    if (again !== null)
      return {
        ok: false,
        error: "flood_wait",
        message: `Telegram impose une attente de ${String(again)} s : rien n'est parti. Réessaie après ce délai (retry_after_seconds).`,
        definite: true,
        seconds: again,
      };
    return result;
  }

  private static floodSeconds(result: UserSidecarResult): number | null {
    if (result.ok || result.error !== "flood_wait") return null;
    const seconds = typeof result.seconds === "number" ? result.seconds : Number(/(\d+)\s*s/.exec(result.message)?.[1]);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : USER_FLOOD_WAIT_RETRY_MAX_S + 1;
  }

  /** Un appel au sidecar à la fois : la session Telethon est un fichier SQLite partagé. */
  private call(args: string[], stdin?: string): Promise<UserSidecarResult> {
    const next = this.queue.then(() => this.sidecar(args, stdin));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private open(): Database.Database {
    const file = path.join(this.dataDir, "telegram.sqlite");
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new TelegramContactError("invalid_store", "telegram.sqlite invalide.");
    }
    const db = new Database(file);
    db.pragma("busy_timeout = 5000");
    db.exec(USER_OUTGOING_SCHEMA);
    return db;
  }

  /** Session et configuration présentes ; sinon une erreur qui dit quoi faire. */
  private requireSetup(): void {
    if (!fs.existsSync(path.join(this.dataDir, "telegram-user.json")))
      throw new TelegramContactError(
        "not_configured",
        "Compte Telegram personnel non configuré : NLR doit créer telegram-user.json (api_id, api_hash, phone) dans le dossier de données.",
      );
    if (!fs.existsSync(path.join(this.dataDir, "telegram-user.session")))
      throw new TelegramContactError(
        "not_logged_in",
        "Compte Telegram personnel non connecté : session absente. NLR doit lancer une fois `python services/telegram/user_account.py login`.",
      );
  }

  private static check(result: UserSidecarResult): Record<string, unknown> {
    if (!result.ok) throw TelegramUserAccount.error(result);
    return result;
  }

  private static error(result: UserSidecarResult & { ok: false }): TelegramContactError {
    const e = new TelegramContactError(result.error, result.message);
    if (result.error === "flood_wait" && typeof result.seconds === "number")
      Object.assign(e, { retryAfterSeconds: result.seconds });
    return e;
  }

  async status(): Promise<{ configured: boolean; logged_in: boolean; account: unknown; min_interval_seconds: number; flood_wait_retry_max_seconds: number; sent_last_24h: number }> {
    const limits = {
      min_interval_seconds: this.minIntervalMs / 1000,
      flood_wait_retry_max_seconds: USER_FLOOD_WAIT_RETRY_MAX_S,
      sent_last_24h: this.sentSince(this.now() - 86_400_000),
    };
    if (!fs.existsSync(path.join(this.dataDir, "telegram-user.json")))
      return { configured: false, logged_in: false, account: null, ...limits };
    if (!fs.existsSync(path.join(this.dataDir, "telegram-user.session")))
      return { configured: true, logged_in: false, account: null, ...limits };
    const result = TelegramUserAccount.check(await this.call(["status"]));
    return { configured: true, logged_in: result["logged_in"] === true, account: result["account"] ?? null, ...limits };
  }

  private sentSince(since: number): number {
    const db = this.open();
    try {
      return (
        db
          .prepare("SELECT COUNT(*) AS n FROM user_outgoing WHERE status<>'failed' AND at>=?")
          .get(new Date(since).toISOString()) as { n: number }
      ).n;
    } finally {
      db.close();
    }
  }

  async recent(input: { to: string; limit?: number | undefined }): Promise<Record<string, unknown>> {
    this.requireSetup();
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 10)));
    const result = TelegramUserAccount.check(await this.callFlood(["recent", input.to.trim(), String(limit)]));
    return { peer: result["peer"], messages: result["messages"] };
  }

  /**
   * Envoi depuis le compte de NLR. `scope` (coach Telegram d'une room) : clé rangée sous
   * `coach:<id>:` dans la même table, donc même espacement que tous les envois du compte.
   */
  /** Recherche de messages : tous les dialogues (`in` absent) ou un seul. */
  async search(input: { query: string; in?: string | undefined; limit?: number | undefined }): Promise<Record<string, unknown>> {
    this.requireSetup();
    const query = input.query.trim();
    if (query === "") throw new TelegramContactError("invalid_query", "Recherche vide.");
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)));
    const result = TelegramUserAccount.check(
      await this.callFlood(["search", query, (input.in ?? "").trim(), String(limit)]),
    );
    return { query, dialog: result["dialog"] ?? null, messages: result["messages"] };
  }

  async send(
    input: { to: string; text: string; idempotency_key: string; image_path?: string | undefined },
    scope?: { coach: string },
  ): Promise<{
    message_id: number | null;
    peer: unknown;
    idempotency_key: string;
    file?: string;
  }> {
    const to = input.to.trim();
    const ownKey = input.idempotency_key.trim();
    const prefix = scope === undefined ? "" : `${COACH_KEY_PREFIX}${scope.coach}:`;
    const key = ownKey === "" ? "" : prefix + ownKey;
    if (to === "") throw new TelegramContactError("invalid_target", "Destinataire vide.");
    if (key === "") throw new TelegramContactError("invalid_key", "idempotency_key obligatoire.");
    if (scope === undefined && ownKey.startsWith(COACH_KEY_PREFIX))
      throw new TelegramContactError("invalid_key", `Préfixe ${COACH_KEY_PREFIX} réservé aux envois des coachs Telegram.`);
    if (input.text.trim() === "") throw new TelegramContactError("invalid_text", "Texte vide.");
    if (input.text.length > TELEGRAM_TEXT_MAX)
      throw new TelegramContactError("invalid_text", `Texte trop long (${String(TELEGRAM_TEXT_MAX)} caractères au plus).`);
    // Fichier joint (image, graphe, document) : un fichier du workspace, envoyé avec le texte en légende.
    let file: string | undefined;
    if (input.image_path !== undefined) {
      try {
        file = resolveWorkspaceFile(this.workspace(), input.image_path).absolutePath;
      } catch (error) {
        throw new TelegramContactError(error instanceof MediaError ? error.code : "invalid_path", error instanceof Error ? error.message : String(error));
      }
    }
    this.requireSetup();
    const db = this.open();
    try {
      // Clé, rythme et quota vérifiés puis réservés d'un bloc : deux appels concurrents ne passent pas tous deux.
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM user_outgoing WHERE key=?").get(key) !== undefined)
          throw new TelegramContactError(
            "duplicate_key",
            "Envoi refusé : cette idempotency_key a déjà servi ; rien n'a été renvoyé. Vérifie l'envoi précédent (telegram_user_recent), ou choisis une nouvelle clé pour un nouveau message.",
          );
        const now = this.now();
        const last = (
          db.prepare("SELECT MAX(at) AS at FROM user_outgoing WHERE status<>'failed'").get() as { at: string | null }
        ).at;
        if (last !== null) {
          const wait = Date.parse(last) + this.minIntervalMs - now;
          if (wait > 0)
            throw new TelegramContactError(
              "rate_limited",
              `Envoi refusé : ${String(this.minIntervalMs / 1000)} s au moins entre deux envois depuis le compte de NLR. Réessaie dans ${String(Math.ceil(wait / 1000))} s.`,
            );
        }
        db.prepare("INSERT INTO user_outgoing(key,target,text,at,status) VALUES(?,?,?,?,'pending')").run(
          key,
          to,
          input.text,
          new Date(now).toISOString(),
        );
      }).immediate();
    } finally {
      db.close();
    }
    let result: UserSidecarResult;
    try {
      result = await this.callFlood(["send", to, "-", ...(file === undefined ? [] : ["--file", file])], input.text);
    } catch {
      result = { ok: false, error: "sidecar_failed", message: "Sidecar Telegram indisponible ; issue incertaine.", definite: false };
    }
    const after = this.open();
    try {
      if (!result.ok) {
        // Refus net : rien n'est parti, la clé est rendue. Sinon l'issue est incertaine et la clé reste prise.
        if (result.definite === true) after.prepare("DELETE FROM user_outgoing WHERE key=?").run(key);
        else after.prepare("UPDATE user_outgoing SET status='uncertain' WHERE key=?").run(key);
        throw TelegramUserAccount.error(result);
      }
      const peer = (result["peer"] ?? null) as { id?: unknown; name?: unknown } | null;
      const messageId = typeof result["message_id"] === "number" ? result["message_id"] : null;
      after
        .prepare("UPDATE user_outgoing SET status='sent',message_id=?,peer_id=?,peer_name=? WHERE key=?")
        .run(
          messageId === null ? null : String(messageId),
          peer?.id === undefined ? null : String(peer.id as string | number),
          typeof peer?.name === "string" ? peer.name : null,
          key,
        );
      return { message_id: messageId, peer, idempotency_key: ownKey, ...(file === undefined ? {} : { file }) };
    } finally {
      after.close();
    }
  }
}

/** Délai FloodWait d'une erreur, pour la réponse JSON. */
function retryAfter(error: unknown): { retry_after_seconds?: number } {
  const seconds = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof seconds === "number" ? { retry_after_seconds: seconds } : {};
}

export function registerTelegramUserTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
  sidecar?: UserSidecar,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): void {
  const dataDir = env["MIND_WAKE_DATA_DIR"];
  if (!dataDir) return;
  const envInt = (name: string) => {
    const value = env[name]?.trim();
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
  };
  const account = new TelegramUserAccount(dataDir, sidecar ?? pythonUserSidecar(dataDir, env), {
    minIntervalSeconds: envInt("MIND_WAKE_TELEGRAM_USER_MIN_INTERVAL_S"),
    now: options.now,
    sleep: options.sleep,
  });
  const reply = async (name: string, work: () => unknown) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema: `mind.mcp/${name}`, schema_version: 1, provenance: "telegram-user", data: await work() }),
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
              error: error instanceof TelegramContactError ? error.code : "telegram_user_error",
              message: error instanceof TelegramContactError ? error.message : "Compte Telegram personnel indisponible.",
              ...retryAfter(error),
            }),
          },
        ],
      };
    }
  };
  server.registerTool(
    "telegram_user_status",
    {
      description:
        "Status of NLR's personal Telegram account link: configured, logged_in, account name, the spacing between sends (min_interval_seconds), the longest Telegram FloodWait waited out automatically, and sends of the last 24 h (informative, no daily cap). No secret is returned.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => reply("telegram_user_status", () => account.status()),
  );
  server.registerTool(
    "telegram_user_send",
    {
      description:
        "Send one Telegram message FROM NLR'S PERSONAL ACCOUNT (not the bot): the recipient sees it as written by NLR himself. Works for anyone in his dialogs, including people who never wrote to the bot. `to` is @username, a numeric id, or the exact name of a private conversation. Text sent exactly as given (at most 4000 characters, no formatting, no signature). idempotency_key required; a reused key is refused and nothing is resent. Spacing: at least 5 s between two sends from his account (configurable); no daily cap. If Telegram imposes a FloodWait of at most 60 s, the call waits and retries once; longer, it is refused with retry_after_seconds.",
      inputSchema: z.strictObject({
        to: z.string().min(1).max(128),
        text: z.string().min(1).max(TELEGRAM_TEXT_MAX),
        idempotency_key: z.string().min(1).max(128),
        image_path: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe("Optional file of the workspace (image, chart, document) sent with the text as caption."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => reply("telegram_user_send", () => account.send(input)),
  );
  server.registerTool(
    "telegram_user_recent",
    {
      description:
        "Read the last messages (default 10, at most 50) of one dialog of NLR's personal Telegram account, oldest first: author (\"moi\" = NLR, \"lui\" = the other side), date, text. Use it to see whether someone answered.",
      inputSchema: z.strictObject({
        to: z.string().min(1).max(128),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => reply("telegram_user_recent", () => account.recent(input)),
  );
}

// ------------------------------------------------------------ coachs Telegram d'une room

export { readCoachContacts, findCoachContact, type CoachContact } from "../../src/daemon/telegram-coach-inbound.js";

/**
 * Outils d'un coach Telegram d'une room (`coach-telegram*`, détecté par `agentsFrom`) :
 * `telegram_user_send`, `telegram_user_recent` et `telegram_user_search`, mêmes noms et même
 * sidecar que ceux du principal. Accès complet (NLR, 16 nov. 2026 13:17 : « full access plz ») :
 * tout dialogue du compte ; son `contacts.json` (relu à chaque appel) est sa liste par défaut, qui
 * résout un nom en @username ou id, pas une liste blanche. Même table, donc même espacement entre
 * envois que tout le compte, et même gestion du FloodWait ; aucun plafond.
 * Env : MIND_WAKE_DATA_DIR, MIND_WAKE_OWNER_TELEGRAM_COACH (id), MIND_WAKE_OWNER_TELEGRAM_CONTACTS
 * (chemin absolu).
 * Renvoie false (aucun outil) si ce réglage manque.
 */
export function registerTelegramCoachTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
  sidecar?: UserSidecar,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): boolean {
  const dataDir = env["MIND_WAKE_DATA_DIR"];
  const coach = env["MIND_WAKE_OWNER_TELEGRAM_COACH"]?.trim();
  const contactsFile = env["MIND_WAKE_OWNER_TELEGRAM_CONTACTS"]?.trim();
  if (!dataDir || !coach || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(coach) || !contactsFile || !path.isAbsolute(contactsFile))
    return false;
  const envInt = (name: string) => {
    const value = env[name]?.trim();
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
  };
  const minInterval = envInt("MIND_WAKE_TELEGRAM_USER_MIN_INTERVAL_S") ?? USER_DEFAULT_MIN_INTERVAL_S;
  const account = new TelegramUserAccount(dataDir, sidecar ?? pythonUserSidecar(dataDir, env), {
    minIntervalSeconds: minInterval,
    now: options.now,
    sleep: options.sleep,
  });
  /** Cible : la personne de contacts.json si `to` la désigne, sinon `to` tel quel. */
  const resolveTo = (to: string): { target: string; contact: CoachContact | null } => {
    let contacts: CoachContact[] = [];
    try {
      contacts = readCoachContacts(contactsFile);
    } catch {
      // Sans contacts.json (ou illisible) : `to` est passé tel quel.
    }
    const found = findCoachContact(contacts, to);
    return found === null ? { target: to.trim(), contact: null } : { target: coachContactTarget(found), contact: found };
  };
  const reply = async (name: string, work: () => unknown) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema: `mind.mcp/${name}`, schema_version: 1, provenance: "telegram-user", data: await work() }),
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
              error: error instanceof TelegramContactError ? error.code : "telegram_user_error",
              message: error instanceof TelegramContactError ? error.message : "Compte Telegram personnel indisponible.",
              ...retryAfter(error),
            }),
          },
        ],
      };
    }
  };
  server.registerTool(
    "telegram_user_send",
    {
      description: `Send one Telegram message FROM NLR'S PERSONAL ACCOUNT (the recipient sees it as written by NLR himself), to anyone in his dialogs. \`to\` is a @username, a numeric id, or an exact name; a name or handle listed in your contacts.json (${contactsFile}, your default list of people) is resolved through it first. Text sent exactly as given (at most 4000 characters, no formatting, no signature). idempotency_key required; a reused key is refused and nothing is resent. Spacing shared with every sender of NLR's account: at least ${String(minInterval)} s between two sends; no daily cap. If Telegram imposes a FloodWait of at most 60 s, the call waits and retries once; longer, it is refused with retry_after_seconds.`,
      inputSchema: z.strictObject({
        to: z.string().min(1).max(128),
        text: z.string().min(1).max(TELEGRAM_TEXT_MAX),
        idempotency_key: z.string().min(1).max(100),
        image_path: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe("Optional file of the workspace (image, chart, document) sent with the text as caption."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) =>
      reply("telegram_user_send", async () => {
        const { target, contact } = resolveTo(input.to);
        return {
          ...(await account.send({ ...input, to: target }, { coach })),
          contact: contact === null ? null : { name: contact.name, username: contact.username, id: contact.id },
        };
      }),
  );
  server.registerTool(
    "telegram_user_recent",
    {
      description:
        'Read the last messages (default 10, at most 50) of any dialog of NLR\'s personal Telegram account, oldest first: author ("moi" = NLR, "lui" = the other side), date, text. `to` is a @username, numeric id or exact dialog name; names from your contacts.json are resolved first.',
      inputSchema: z.strictObject({
        to: z.string().min(1).max(128),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      reply("telegram_user_recent", async () => account.recent({ to: resolveTo(input.to).target, limit: input.limit })),
  );
  server.registerTool(
    "telegram_user_search",
    {
      description:
        'Search messages in NLR\'s personal Telegram account: across ALL his dialogs (Telegram global search) when `in` is omitted, or inside one dialog (`in` = @username, numeric id or exact name). Returns, newest first, the dialog, the author ("moi" = NLR), date and text. Use it to check whether a name or a link appears in other conversations.',
      inputSchema: z.strictObject({
        query: z.string().min(1).max(200),
        in: z.string().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      reply("telegram_user_search", async () =>
        account.search({ query: input.query, in: input.in === undefined ? undefined : resolveTo(input.in).target, limit: input.limit }),
      ),
  );
  return true;
}
