/**
 * Origine automatique d'un job de fond (Viz, 18 nov. 2026 : 9 jobs sur 615 seulement reliés au
 * message qui les avait lancés). Calculée par le serveur MCP au moment de `start_background_job`
 * à partir de l'environnement que le daemon lui a donné, jamais à partir de ce que l'agent écrit :
 * qui a lancé (principal, agent de salle, holder), la salle, la session, le message qui a
 * déclenché le tour s'il est connu, et le job parent. Ce que l'agent déclare (`why`, id de
 * message) est gardé à part, dans `declared`.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const JOB_ORIGIN_SCHEMA = "mind.job-origin/1";
/** Variables posées par le daemon dans l'env du serveur MCP d'un tour (voir `withTurnOriginEnv`). */
export const TURN_TRIGGER_ENV = "MIND_WAKE_TURN_TRIGGER";
export const PATTERN_HOLDER_ENV = "MIND_WAKE_PATTERN_HOLDER";

export type JobLauncherKind = "principal" | "room-agent" | "holder";
export interface JobTrigger {
  /** Id du message : id de la boîte du principal, ou `room<N>:entry:<id>` / `room<N>:relay:<clé>`. */
  readonly id: string;
  readonly kind: "human" | "peer";
  readonly at: string | null;
  /**
   * `turn` : posé par le daemon pour ce tour précis. `last-delivered` : dernier message humain ou
   * pair remis au principal avant le lancement (approximation : un réveil sans message garde
   * celui d'avant ; comparer `deliveredAt` à `createdAt` du job).
   */
  readonly basis: "turn" | "last-delivered";
  readonly deliveredAt?: string | null;
}
export interface JobOrigin {
  readonly schema: typeof JOB_ORIGIN_SCHEMA;
  /** Nom lisible, compatible avec l'ancien `origin.launchedBy` : « principal » ou la signature. */
  readonly launchedBy: string;
  readonly launcher: {
    readonly kind: JobLauncherKind;
    /** Id de l'agent de salle ou slug du holder ; `null` pour le principal et le canal d'une salle. */
    readonly agentId: string | null;
    readonly signature: string | null;
  };
  /** `room:<N>`, même forme que l'ancien `origin.room` ; `null` hors salle. */
  readonly room: string | null;
  readonly roomNumber: number | null;
  /** Session Wake (principal) ou session Claude du tour (salle) ; `null` si inconnue. */
  readonly session: string | null;
  readonly trigger: JobTrigger | null;
  readonly parent: {
    readonly jobId: string;
    readonly title: string | null;
    readonly launchedBy: string | null;
    readonly room: string | null;
  } | null;
  /** Premier job de la chaîne (le parent du parent…) ; `null` si lancé hors job. */
  readonly rootJobId: string | null;
  /** Déclaré par l'agent, facultatif ; l'origine automatique n'en dépend pas. */
  readonly declared: { readonly why?: string; readonly triggerMessageId?: string } | null;
  readonly recordedAt: string;
}

type Env = Readonly<Record<string, string | undefined>>;
const JOB_ID = /^job_[0-9a-f-]{36}$/;
const text = (value: string | undefined): string | null => {
  const t = value?.trim() ?? "";
  return t === "" ? null : t;
};

/** Origine d'un lancement ; `lookupJob` lit le job parent (titre, origine) s'il existe. */
export function autoJobOrigin(
  env: Env,
  options: {
    lookupJob?: (id: string) => { title: string; origin?: JobOrigin } | null;
    declared?: { why?: string | undefined; triggerMessageId?: string | undefined };
    now?: () => Date;
  } = {},
): JobOrigin {
  const holder = text(env[PATTERN_HOLDER_ENV]);
  const signature = text(env["MIND_WAKE_OWNER_SIGNATURE"]);
  const kind: JobLauncherKind =
    holder !== null ? "holder" : signature !== null ? "room-agent" : "principal";
  const agentId = holder ?? (kind === "room-agent" ? text(env["MIND_WAKE_OWNER_AGENT"]) : null);
  const roomRaw =
    kind === "principal"
      ? null
      : (text(env["MIND_WAKE_OWNER_FORK"]) ??
        text(env["MIND_WAKE_DESKTOP_ROOM"]) ??
        text(env["MIND_WAKE_FORK_ID"]));
  const parsedRoom = roomRaw === null ? NaN : Number(roomRaw);
  let roomNumber = Number.isInteger(parsedRoom) && parsedRoom >= 1 ? parsedRoom : null;

  const parentId = text(env["MIND_WAKE_JOB_ID"]);
  let parent: JobOrigin["parent"] = null;
  let rootJobId: string | null = null;
  if (parentId !== null && JOB_ID.test(parentId)) {
    const found = ((): { title: string; origin?: JobOrigin } | null => {
      try {
        return options.lookupJob?.(parentId) ?? null;
      } catch {
        return null;
      }
    })();
    parent = {
      jobId: parentId,
      title: found?.title ?? null,
      launchedBy: found?.origin?.launchedBy ?? null,
      room: found?.origin?.room ?? null,
    };
    rootJobId = found?.origin?.rootJobId ?? parentId;
    // Un job lancé depuis un job de salle reste rattaché à cette salle.
    if (roomNumber === null) roomNumber = found?.origin?.roomNumber ?? null;
  }

  let trigger = turnTrigger(env[TURN_TRIGGER_ENV]);
  if (trigger === null && kind === "principal" && parent === null) {
    const dataDir = text(env["MIND_WAKE_DATA_DIR"]);
    if (dataDir !== null) trigger = lastDeliveredOwnerMessage(dataDir);
  }

  const why = text(options.declared?.why);
  const declaredTrigger = text(options.declared?.triggerMessageId);
  return {
    schema: JOB_ORIGIN_SCHEMA,
    launchedBy: kind === "principal" ? "principal" : (signature ?? agentId ?? kind),
    launcher: { kind, agentId, signature },
    room: roomNumber === null ? null : `room:${String(roomNumber)}`,
    roomNumber,
    session: text(env["MIND_WAKE_SESSION"]),
    trigger,
    parent,
    rootJobId,
    declared:
      why === null && declaredTrigger === null
        ? null
        : {
            ...(why === null ? {} : { why }),
            ...(declaredTrigger === null ? {} : { triggerMessageId: declaredTrigger }),
          },
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

function turnTrigger(raw: string | undefined): JobTrigger | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const value = JSON.parse(raw) as Partial<JobTrigger>;
    if (typeof value.id !== "string" || value.id === "") return null;
    return {
      id: value.id,
      kind: value.kind === "peer" ? "peer" : "human",
      at: typeof value.at === "string" ? value.at : null,
      basis: "turn",
    };
  } catch {
    return null;
  }
}

/**
 * Dernier message humain ou pair remis au principal (boîte `owner-inbox.sqlite`), hors copies de
 * contexte. Lecture seule ; `null` si la boîte manque ou ne se lit pas.
 */
export function lastDeliveredOwnerMessage(dataDir: string): JobTrigger | null {
  const file = path.join(dataDir, "owner-inbox.sqlite");
  if (!fs.existsSync(file)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const columns = new Set(
      (db.prepare("PRAGMA table_info(inbox)").all() as { name: string }[]).map((c) => c.name),
    );
    const origin = columns.has("origin_json") ? "origin_json" : "NULL AS origin_json";
    const rows = db
      .prepare(
        `SELECT id, at, emitted_at, ${origin} FROM inbox
         WHERE emitted_session IS NOT NULL AND id NOT LIKE 'shared-inbox:%' AND id NOT LIKE 'fast-reply-fyi:%'
         ORDER BY emitted_at DESC, rowid DESC LIMIT 32`,
      )
      .all() as { id: string; at: string; emitted_at: string | null; origin_json: string | null }[];
    for (const row of rows) {
      let kind: JobTrigger["kind"] = "human";
      if (row.origin_json !== null) {
        const parsed = JSON.parse(row.origin_json) as { kind?: string };
        if (parsed.kind === "context_copy") continue;
        if (parsed.kind === "peer_message") kind = "peer";
      }
      return { id: row.id, kind, at: row.at, basis: "last-delivered", deliveredAt: row.emitted_at };
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Ajoute des variables d'environnement au serveur MCP `mind` d'une configuration JSON (session et
 * message déclencheur d'un tour de salle). Une configuration en fichier ou illisible reste telle quelle.
 */
export function withTurnOriginEnv(
  mcpConfig: string | undefined,
  extra: Readonly<Record<string, string>>,
): string | undefined {
  if (mcpConfig === undefined || !mcpConfig.trimStart().startsWith("{")) return mcpConfig;
  try {
    const config = JSON.parse(mcpConfig) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    const mind = config.mcpServers?.["mind"];
    if (mind === undefined) return mcpConfig;
    mind.env = { ...(mind.env ?? {}), ...extra };
    return JSON.stringify(config);
  } catch {
    return mcpConfig;
  }
}

/** Variables d'origine pour le script du job (voir docs/BACKGROUND-JOBS.md). */
export function jobOriginEnv(origin: JobOrigin | undefined): Record<string, string> {
  if (origin === undefined) return {};
  const json = JSON.stringify(origin);
  // `MIND_WAKE_JOB_ORIGIN` absent veut déjà dire « agent principal » pour les scripts existants
  // (jobs/atelier-worker-claude.mjs) : il n'est posé que pour un autre lanceur.
  return {
    MIND_WAKE_JOB_ORIGIN_AUTO: json,
    ...(origin.launcher.kind === "principal" ? {} : { MIND_WAKE_JOB_ORIGIN: json }),
  };
}

/** Fichier lisible du job : `jobs/runs/<id>/job.json` (pas `origin.json`, réservé aux lanceurs). */
export const JOB_RECORD_FILE = "job.json";
