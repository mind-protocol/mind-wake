/**
 * Réveils demandés par l'agent (`prompts/wake/agent-wakeup.schema.json`) : fichiers JSON
 * déposés dans le dossier `wakeups/` de l'espace d'exploration. Contenu non fiable :
 *
 * - schéma fermé, taille bornée, nom de fichier et identifiant contraints, au plus
 *   `MAX_FILES` lus par tour ; liens symboliques, jonctions et liens physiques refusés,
 *   dossier et fichiers résolus dans l'espace d'exploration ; chemin `fileChanged` confiné ;
 * - un fichier invalide est ignoré, journalisé une fois puis archivé (`archive/`) ;
 * - une demande expirée, ou servie sans `repeat`, est archivée ;
 * - une demande n'ajoute qu'une **échéance candidate** au scheduler : fenêtres, priorité
 *   humaine, pause, arrêt d'urgence, garde de quota et permissions restent vérifiés par
 *   `decideLaunch`. Elle ne peut ni relever une limite ni modifier la policy ; son texte
 *   remplace seulement la relance, présenté comme une note de l'agent à lui-même.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  ProfileId,
  ProviderQuotaSnapshot,
  UnitOfWork,
  UtcTimestamp,
} from "../contracts/index.js";
import { prepareJournalEvent } from "../journal/index.js";
import { isConfinedPath } from "../policy/index.js";
import type { SqliteDatabase } from "../store/index.js";

export const WAKEUPS_SEGMENT = "wakeups";
const ARCHIVE = "archive";
const SCHEMA_DIR = "schema";
export const WAKEUP_SCHEMA_FILE = "agent-wakeup.schema.json";
export const MAX_WAKEUP_BYTES = 4_096;
export const MAX_FILES = 32;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.json$/;
const HOUR = 3_600_000;

const isoDateTime = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((v) => !Number.isNaN(Date.parse(v)));

const When = z.union([
  z.strictObject({ at: isoDateTime }),
  z.strictObject({ afterHours: z.number().min(0.25).max(168) }),
  z.strictObject({ quotaResetWithinHours: z.number().min(0.25).max(24) }),
  z.strictObject({ fileChanged: z.string().min(1).max(260) }),
]);

const AgentWakeupSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  when: When,
  prompt: z.string().min(1).max(1_000),
  experiment: z.string().max(128).optional(),
  expires: isoDateTime.optional(),
  repeat: z.boolean().optional(),
});

export type AgentWakeup = z.infer<typeof AgentWakeupSchema>;

export interface WakeupRequest {
  readonly file: string;
  readonly request: AgentWakeup;
  readonly firstSeenAt: number;
  readonly lastServedAt: number | null;
}

/** Lecture officielle de la jauge, demandée seulement si une demande en dépend. */
export type QuotaSource = () => Promise<readonly ProviderQuotaSnapshot[] | undefined>;

function utc(ms: number): UtcTimestamp {
  return new Date(ms).toISOString() as UtcTimestamp;
}

/** Ni lien symbolique ni jonction (Node les signale tous deux par `isSymbolicLink`). */
function isLink(stat: fs.Stats): boolean {
  return stat.isSymbolicLink();
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface AgentWakeupsOptions {
  readonly uow: UnitOfWork;
  readonly db: SqliteDatabase;
  readonly profileId: ProfileId;
  readonly workspaceDir: string;
  readonly schemaText: string;
}

export class AgentWakeups {
  readonly dir: string;
  readonly schemaPath: string;
  readonly #o: AgentWakeupsOptions;
  #unsafeReported = false;

  constructor(options: AgentWakeupsOptions) {
    this.#o = options;
    this.dir = path.join(options.workspaceDir, WAKEUPS_SEGMENT);
    this.schemaPath = path.join(this.dir, SCHEMA_DIR, WAKEUP_SCHEMA_FILE);
  }

  /** Crée le dossier et y dépose le schéma pour l'agent (sa copie n'a aucune autorité). */
  prepare(): void {
    if (!this.#safeDir()) return;
    fs.mkdirSync(path.dirname(this.schemaPath), { recursive: true });
    fs.mkdirSync(path.join(this.dir, ARCHIVE), { recursive: true });
    fs.writeFileSync(this.schemaPath, `${this.#o.schemaText}\n`);
  }

  /** Dossier présent, réel (pas un lien ni une jonction) et dans l'espace d'exploration. */
  #safeDir(): boolean {
    let stat: fs.Stats;
    try {
      fs.mkdirSync(this.#o.workspaceDir, { recursive: true });
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir);
      stat = fs.lstatSync(this.dir);
    } catch {
      return false;
    }
    if (isLink(stat) || !stat.isDirectory()) return false;
    try {
      const real = fs.realpathSync.native(this.dir);
      return within(fs.realpathSync.native(this.#o.workspaceDir), real);
    } catch {
      return false;
    }
  }

  /**
   * Lit, valide et trie les demandes. Les fichiers invalides, en double ou expirés sont
   * journalisés puis archivés : ils ne reviennent pas au tour suivant.
   */
  scan(nowMs: number): readonly WakeupRequest[] {
    if (!this.#safeDir()) {
      if (!this.#unsafeReported) {
        this.#journal(nowMs, "wakeups.dir_unsafe", { dir: WAKEUPS_SEGMENT }, true);
        this.#unsafeReported = true;
      }
      return [];
    }
    let names: string[];
    try {
      names = fs
        .readdirSync(this.dir)
        .filter((n) => n.toLowerCase().endsWith(".json"))
        .sort();
    } catch {
      return [];
    }
    const requests: WakeupRequest[] = [];
    const seen = new Set<string>();
    for (const name of names.slice(0, MAX_FILES)) {
      const parsed = this.#read(name);
      if ("reason" in parsed) {
        this.#reject(nowMs, name, parsed.reason);
        continue;
      }
      const request = parsed.request;
      if (seen.has(request.id)) {
        this.#reject(nowMs, name, "duplicate_id");
        continue;
      }
      seen.add(request.id);
      if (request.expires !== undefined && Date.parse(request.expires) <= nowMs) {
        this.#archive(nowMs, name, "expired", request.id);
        continue;
      }
      const state = this.#state(request.id, nowMs);
      requests.push({ file: name, request, ...state });
    }
    return requests;
  }

  #read(name: string): { readonly request: AgentWakeup } | { readonly reason: string } {
    if (!FILE_NAME.test(name)) return { reason: "file_name_invalid" };
    const file = path.join(this.dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return { reason: "unreadable" };
    }
    if (isLink(stat)) return { reason: "link_refused" };
    if (!stat.isFile()) return { reason: "not_a_file" };
    if (stat.nlink > 1) return { reason: "hardlink_refused" };
    if (stat.size > MAX_WAKEUP_BYTES) return { reason: "too_large" };
    let text: string;
    try {
      const fd = fs.openSync(file, "r");
      try {
        const opened = fs.fstatSync(fd);
        if (opened.ino !== stat.ino || opened.size > MAX_WAKEUP_BYTES) {
          return { reason: "changed_while_reading" };
        }
        const buffer = Buffer.alloc(Math.min(opened.size, MAX_WAKEUP_BYTES));
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        text = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { reason: "unreadable" };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { reason: "json_invalid" };
    }
    const result = AgentWakeupSchema.safeParse(json);
    if (!result.success) return { reason: "schema_invalid" };
    const when = result.data.when;
    if ("fileChanged" in when && !isConfinedPath(when.fileChanged, false)) {
      return { reason: "path_not_confined" };
    }
    return { request: result.data };
  }

  #state(id: string, nowMs: number): { firstSeenAt: number; lastServedAt: number | null } {
    const { db, profileId } = this.#o;
    db.prepare(
      "INSERT OR IGNORE INTO agent_wakeups (profile_id, id, first_seen_at, last_served_at) VALUES (?, ?, ?, NULL)",
    ).run(profileId, id, utc(nowMs));
    const row = db
      .prepare<[string, string], { first_seen_at: string; last_served_at: string | null }>(
        "SELECT first_seen_at, last_served_at FROM agent_wakeups WHERE profile_id = ? AND id = ?",
      )
      .get(profileId, id);
    return {
      firstSeenAt: Date.parse(row?.first_seen_at ?? utc(nowMs)),
      lastServedAt: row?.last_served_at == null ? null : Date.parse(row.last_served_at),
    };
  }

  /** Mtime d'un fichier de l'espace, chaque segment refusant liens et jonctions. */
  #mtime(relative: string): number | null {
    const workspace = this.#o.workspaceDir;
    let current = workspace;
    for (const segment of relative.split("/")) {
      current = path.join(current, segment);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch {
        return null;
      }
      if (isLink(stat)) return null;
    }
    try {
      if (!within(fs.realpathSync.native(workspace), fs.realpathSync.native(current))) return null;
      return fs.statSync(current).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Échéance d'une demande : instant où elle devient due (peut être passé), `null` si
   * elle ne l'est pas et qu'aucune date n'est connue. Jamais une autorisation.
   */
  dueAt(
    entry: WakeupRequest,
    nowMs: number,
    snapshots: readonly ProviderQuotaSnapshot[] | undefined,
  ): number | null {
    const when = entry.request.when;
    const since = entry.lastServedAt ?? entry.firstSeenAt;
    if ("at" in when) {
      const at = Date.parse(when.at);
      // Heure précise déjà servie : seule une répétition la rejouerait, à l'identique.
      return entry.lastServedAt !== null && entry.lastServedAt >= at ? null : at;
    }
    if ("afterHours" in when) return since + when.afterHours * HOUR;
    if ("quotaResetWithinHours" in when) {
      const resets = (snapshots ?? [])
        .filter((s) => s.provenance === "measured")
        .map((s) => Date.parse(s.resetsAt))
        .filter((ms) => Number.isFinite(ms) && ms > nowMs);
      if (resets.length === 0) return null;
      return Math.min(...resets) - when.quotaResetWithinHours * HOUR;
    }
    const mtime = this.#mtime(when.fileChanged);
    return mtime !== null && mtime > since ? nowMs : null;
  }

  /** Lit la jauge seulement si une demande en dépend (`quotaResetWithinHours`). */
  async #snapshots(
    entries: readonly WakeupRequest[],
    quota: QuotaSource | undefined,
  ): Promise<readonly ProviderQuotaSnapshot[] | undefined> {
    if (quota === undefined || !entries.some((e) => "quotaResetWithinHours" in e.request.when)) {
      return undefined;
    }
    try {
      return await quota();
    } catch {
      return undefined;
    }
  }

  /** Prochaine échéance candidate parmi les demandes valides. */
  async nextDue(nowMs: number, quota?: QuotaSource): Promise<number | null> {
    const entries = this.scan(nowMs);
    const snapshots = await this.#snapshots(entries, quota);
    const dues = entries
      .map((e) => this.dueAt(e, nowMs, snapshots))
      .filter((d): d is number => d !== null);
    return dues.length === 0 ? null : Math.min(...dues);
  }

  /**
   * Demande servie par le réveil qui commence : la plus ancienne échéance atteinte. Elle
   * est marquée servie, et archivée sauf `repeat`. Au plus une par réveil.
   */
  async takeDue(
    nowMs: number,
    quota?: QuotaSource,
  ): Promise<{ readonly id: string; readonly prompt: string } | null> {
    const entries = this.scan(nowMs);
    const snapshots = await this.#snapshots(entries, quota);
    const due = entries
      .map((entry) => ({ entry, at: this.dueAt(entry, nowMs, snapshots) }))
      .filter((d): d is { entry: WakeupRequest; at: number } => d.at !== null && d.at <= nowMs)
      .sort((a, b) => a.at - b.at)[0];
    if (due === undefined) return null;
    const { request, file } = due.entry;
    this.#o.db
      .prepare("UPDATE agent_wakeups SET last_served_at = ? WHERE profile_id = ? AND id = ?")
      .run(utc(nowMs), this.#o.profileId, request.id);
    if (request.repeat !== true) this.#archive(nowMs, file, "served", request.id);
    this.#journal(nowMs, "wakeups.served", { id: request.id, repeat: request.repeat === true });
    return { id: request.id, prompt: request.prompt };
  }

  #reject(nowMs: number, file: string, reason: string): void {
    this.#journal(nowMs, "wakeups.invalid_ignored", { file: file.slice(0, 96), reason }, true);
    this.#move(nowMs, file, "rejected");
  }

  #archive(nowMs: number, file: string, why: "served" | "expired", id: string): void {
    if (why === "expired") this.#journal(nowMs, "wakeups.expired_archived", { id });
    this.#move(nowMs, file, why);
  }

  #move(nowMs: number, file: string, suffix: string): void {
    const from = path.join(this.dir, file);
    const archive = path.join(this.dir, ARCHIVE);
    try {
      fs.mkdirSync(archive, { recursive: true });
      const target = path.join(archive, `${String(nowMs)}-${suffix}-${path.basename(file)}`);
      // Un lien est retiré sans suivre sa cible ; un fichier ordinaire est déplacé.
      if (isLink(fs.lstatSync(from))) fs.rmSync(from, { force: true });
      else fs.renameSync(from, target);
    } catch {
      // Déplacement impossible : la demande reste ignorée à chaque tour, sans effet.
    }
  }

  #journal(
    nowMs: number,
    reason: string,
    metadata: Readonly<Record<string, string | boolean>>,
    denied = false,
  ): void {
    this.#o.uow.journal.append(
      prepareJournalEvent({
        type: denied ? "action_denied" : "action_allowed",
        at: utc(nowMs),
        profileId: this.#o.profileId,
        reason,
        metadata: { action: "agent_wakeup", ...metadata },
      }),
    );
  }
}
