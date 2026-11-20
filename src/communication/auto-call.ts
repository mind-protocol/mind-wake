/**
 * Appel automatique (NLR, 20 nov. 2026 12:02Z : « add un toggle "active" a la page call qui lance
 * un call de toi vers moi toutes les 10 minutes automatiquement » ; « il y a forcément du nouveau »).
 *
 * Le minuteur vit dans le moteur (daemon), jamais dans la page ni dans une session d'agent :
 * l'état est un JSON du dossier de données (`auto-call.json`), relu à chaque passage, donc il
 * survit à un redémarrage. Aucun filtre « rien de neuf » : interrupteur actif = un appel par
 * intervalle, sauf
 * - Pause ou Force-off (profil en pause, arrêté, désactivé, arrêt d'urgence) : « sauté » ;
 * - appel déjà en cours, ou sonnerie déjà en file pour NLR : « sauté (appel en cours) ».
 *
 * Un appel lancé = une notice dans le fil du principal (ce qui a changé depuis l'appel précédent,
 * avec son horodatage) puis une sonnerie mise en file comme `call_human` (table `invitations` de
 * `mobile-calls.sqlite`, appelant `mind`, libellé « Marco »). Sonner n'est pas décrocher : « décroché »
 * n'est écrit que si la passerelle d'appel a enregistré `decision='accept'` pour cette invitation.
 * Chaque issue est tracée, datée, dans `auto-call.jsonl`.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { callSituation } from "./holder-cadence.js";
import { callConversationAllowed } from "./call-policy.js";
import { enqueueOwnerMessage } from "./owner-inbox.js";
import { readOwnerMessages } from "./owner-messages.js";
import { requestHumanWake } from "../daemon/human-wake.js";
import { openStoreReadOnly } from "../store/index.js";
import { controlDbPath } from "../daemon/paths.js";
import { resolvePolicy } from "../policy/index.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";

export const AUTO_CALL_STATE = "auto-call.json";
export const AUTO_CALL_TRACE = "auto-call.jsonl";
export const AUTO_CALL_INTERVAL_MINUTES = 10;
/** Handle d'appelant du principal (même valeur que `call_human` sans signature). */
export const AUTO_CALL_CALLER = "mind";
export const AUTO_CALL_LABEL = "Marco";
/** Lu par l'agent avant chaque appel (relatif à l'espace de travail ; modifiable dans `auto-call.json`). */
export const AUTO_CALL_READ_FIRST = [
  "artifacts/projets/emploi-remote/essai-premier-jour-soda/pieces/plan-autonome/REPRISE-SOUS-SESSIONS.md",
];

/** Durée de sonnerie d'une invitation (`phone-book.mjs`). */
const RING_MS = 45_000;

export type AutoCallOutcome = "lancé" | "décroché" | "sans réponse" | "sauté";

export interface AutoCallState {
  version: 1;
  enabled: boolean;
  intervalMinutes: number;
  /** Prochain passage, ISO ; `null` quand l'interrupteur est coupé. */
  nextAt: string | null;
  lastOutcome: string | null;
  lastAt: string | null;
  /** Dernier appel réellement lancé (sonnerie en file), ISO. Remis à l'agent pour comparer. */
  lastCallAt: string | null;
  /** Sonnerie en attente d'issue. */
  pendingInvite: { id: string; at: string; expiresAt: string } | null;
  /** Dernière activation de l'interrupteur, ISO (référence du premier appel). */
  enabledAt: string | null;
  /** Fichiers que l'agent relit avant chaque appel (chemins relatifs à l'espace de travail). */
  readFirst: string[];
  /** Dernier engagement « d'ici le prochain appel, je tente … » relevé dans le fil. */
  lastCommitment: { text: string; at: string } | null;
}

export interface AutoCallTrace {
  at: string;
  outcome: AutoCallOutcome;
  reason?: string;
  inviteId?: string;
  previousCallAt?: string | null;
}

const DEFAULT_STATE: AutoCallState = {
  version: 1,
  enabled: false,
  intervalMinutes: AUTO_CALL_INTERVAL_MINUTES,
  nextAt: null,
  lastOutcome: null,
  lastAt: null,
  lastCallAt: null,
  pendingInvite: null,
  enabledAt: null,
  readFirst: [...AUTO_CALL_READ_FIRST],
  lastCommitment: null,
};

export function readAutoCallState(dataDir: string): AutoCallState {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, AUTO_CALL_STATE), "utf8")) as Partial<AutoCallState>;
    const interval = Number(raw.intervalMinutes);
    return {
      ...DEFAULT_STATE,
      ...raw,
      version: 1,
      enabled: raw.enabled === true,
      intervalMinutes: Number.isFinite(interval) && interval >= 1 ? interval : AUTO_CALL_INTERVAL_MINUTES,
      readFirst: Array.isArray(raw.readFirst) ? raw.readFirst.filter((f): f is string => typeof f === "string") : [...AUTO_CALL_READ_FIRST],
    };
  } catch {
    return { ...DEFAULT_STATE, readFirst: [...AUTO_CALL_READ_FIRST] };
  }
}

export function saveAutoCallState(dataDir: string, state: AutoCallState): void {
  const file = path.join(dataDir, AUTO_CALL_STATE);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function appendAutoCallTrace(dataDir: string, line: AutoCallTrace): void {
  fs.appendFileSync(path.join(dataDir, AUTO_CALL_TRACE), JSON.stringify(line) + "\n");
}

export function readAutoCallTrace(dataDir: string, limit = 20): AutoCallTrace[] {
  try {
    return fs
      .readFileSync(path.join(dataDir, AUTO_CALL_TRACE), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-limit)
      .map((l) => JSON.parse(l) as AutoCallTrace);
  } catch {
    return [];
  }
}

/** Interrupteur de la page Appel. Activer programme le premier appel tout de suite. */
export function setAutoCallEnabled(dataDir: string, enabled: boolean, nowMs = Date.now()): AutoCallState {
  const state = readAutoCallState(dataDir);
  if (enabled && !state.enabled) state.nextAt = state.enabledAt = new Date(nowMs).toISOString();
  if (!enabled) state.nextAt = null;
  state.enabled = enabled;
  saveAutoCallState(dataDir, state);
  return state;
}

// ---------------------------------------------------------------- lectures réelles

/** Pause ou Force-off (motif lisible), ou `null` si l'appel est permis. Échec de lecture : bloqué. */
export function autoCallBlocker(dataDir: string): string | null {
  if (fs.existsSync(path.join(dataDir, "emergency-stop.flag"))) return "Force-off";
  try {
    const store = openStoreReadOnly(controlDbPath(dataDir));
    try {
      const profile = store.uow.profiles.get(DEFAULT_PROFILE_ID);
      if (profile === null) return "profil absent";
      if (profile.emergencyStopLocked || profile.state === "stopped") return "Force-off";
      if (profile.state === "paused" || profile.state === "checkpointing") return "Pause";
      if (profile.state === "disabled") return "profil désactivé";
      if (resolvePolicy(store.uow.policies, DEFAULT_PROFILE_ID).status !== "active") return "politique inactive";
    } finally {
      store.close();
    }
  } catch {
    return "état du profil illisible";
  }
  return callConversationAllowed(dataDir) ? null : "appel indisponible";
}

/** Appel actif (table de contrôle de la passerelle) ou sonnerie déjà en file pour NLR. */
export function autoCallBusy(dataDir: string, nowMs = Date.now()): string | null {
  if (callSituation(dataDir, [AUTO_CALL_CALLER], nowMs).state !== "none") return "appel en cours";
  const file = path.join(dataDir, "mobile-calls.sqlite");
  if (!fs.existsSync(file)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    const row = db.prepare("SELECT 1 FROM invitations WHERE human='nlr' AND decision IS NULL AND until>?").get(nowMs);
    return row === undefined ? null : "appel en cours (sonnerie déjà en file)";
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Met une sonnerie en file vers NLR, comme `call_human` (phone-book.mjs `invite`). */
export function ringOwner(dataDir: string, nowMs = Date.now()): { id: string; expiresAt: string } {
  const file = path.join(dataDir, "mobile-calls.sqlite");
  if (!fs.existsSync(file)) throw Error("passerelle d'appel jamais démarrée (mobile-calls.sqlite absent)");
  const db = new Database(file, { fileMustExist: true, timeout: 5000 });
  try {
    const columns = new Set((db.prepare("PRAGMA table_info(invitations)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("decision")) throw Error("table invitations absente");
    const id = randomUUID();
    const until = nowMs + RING_MS;
    if (columns.has("invite_humans") && columns.has("call_id"))
      db.prepare("INSERT INTO invitations(id,human,caller,label,until,invite_humans,call_id) VALUES(?,?,?,?,?,0,NULL)")
        .run(id, "nlr", AUTO_CALL_CALLER, AUTO_CALL_LABEL, until);
    else
      db.prepare("INSERT INTO invitations(id,human,caller,label,until) VALUES(?,?,?,?,?)")
        .run(id, "nlr", AUTO_CALL_CALLER, AUTO_CALL_LABEL, until);
    return { id, expiresAt: new Date(until).toISOString() };
  } finally {
    db.close();
  }
}

export type InviteStatus = "accept" | "decline" | "pending" | "expired" | "unknown";

/** Issue d'une invitation : décision écrite par la passerelle (`/chat/phone/answer`). */
export function inviteStatus(dataDir: string, id: string, nowMs = Date.now()): InviteStatus {
  const file = path.join(dataDir, "mobile-calls.sqlite");
  if (!fs.existsSync(file)) return "unknown";
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    const row = db.prepare("SELECT decision, until FROM invitations WHERE id=?").get(id) as
      { decision: string | null; until: number } | undefined;
    if (row === undefined) return "unknown";
    if (row.decision === "accept") return "accept";
    if (row.decision !== null) return "decline";
    return row.until > nowMs ? "pending" : "expired";
  } catch {
    return "unknown";
  } finally {
    db?.close();
  }
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

export const COMMITMENT = /d['’]ici le prochain appel,?\s*je tente\s+(.+)/i;

/** Dernier engagement publié dans le fil depuis `sinceIso` (messages de l'agent à NLR), ou `null`. */
export function findCommitment(
  messages: readonly { text: string; createdAt: string }[] | null,
  sinceIso: string | null,
): { text: string; at: string } | null {
  let found: { text: string; at: string } | null = null;
  const floor = sinceIso === null ? -Infinity : Date.parse(sinceIso);
  for (const m of messages ?? []) {
    if (!(Date.parse(m.createdAt) >= floor)) continue;
    for (const line of m.text.split(/\r?\n/)) {
      const match = COMMITMENT.exec(line);
      if (match?.[1]) found = { text: match[1].replace(/[*_»"]+$/g, "").trim().slice(0, 300), at: m.createdAt };
    }
  }
  return found;
}

/**
 * Consigne remise au principal avec la sonnerie : sources réelles (horodatage de référence,
 * fichiers à relire, fichiers modifiés et messages du fil depuis), puis forme de l'ouverture.
 */
export function autoCallPurpose(
  nowIso: string,
  sinceIso: string,
  readFirst: readonly string[] = AUTO_CALL_READ_FIRST,
  commitment: { text: string; at: string } | null = null,
): string {
  const since = hhmm(sinceIso);
  return [
    `[Appel automatique] Le moteur fait sonner NLR de ta part (${hhmm(nowIso)} heure de Paris, interrupteur « Actif — appel toutes les 10 min » de la page Appel).`,
    commitment === null
      ? "Engagement précédent : aucun « d'ici le prochain appel, je tente … » relevé dans le fil."
      : `Engagement précédent (${hhmm(commitment.at)}) : « je tente ${commitment.text} ». Commence par là : fait ou non, et le résultat observé.`,
    `Référence : ${sinceIso} (${since} heure de Paris), heure de l'appel automatique précédent (ou de l'activation).`,
    "Avant de parler, relis tes sources :",
    ...readFirst.map((file) => `- lis ${file}`),
    `- liste les fichiers modifiés sous artifacts/ depuis ${sinceIso} (par ex. find artifacts -newermt "${sinceIso}" -type f) ;`,
    `- relis les messages du fil avec NLR depuis ${sinceIso} (list_owner_messages).`,
    `S'il décroche, en français, moins d'une minute : ouvre par « Depuis ${since} : », puis une ligne par chantier dont l'état a changé depuis ${since}, avec le verbe qui correspond à ce que tu as observé, parmi « lancé », « fichier écrit », « relu », « vérifié en usage ». Puis un seul blocage, avec ce qui a déjà été tenté pour le lever. Puis au plus une question.`,
    "La question ne demande que ce qui revient à NLR seul : un clic d'administration, son téléphone, une information introuvable ailleurs, ou un envoi sous son nom. Jamais un choix à l'intérieur d'une direction qu'il a déjà donnée. Si une direction manque vraiment, formule-la « je fais ceci, sauf si tu dis non ».",
    "Dernière ligne, telle quelle dans ta réponse publiée au fil : « d'ici le prochain appel, je tente <X> ». Le moteur la relève et te la redonnera à l'appel suivant.",
    "Ne récite jamais le dernier rapport complet. Il y a forcément du nouveau.",
    "Sonner n'est pas décrocher : ne refais pas sonner toi-même, le moteur rappellera au prochain intervalle.",
  ].join("\n");
}

// ---------------------------------------------------------------- passage

export interface AutoCallDeps {
  readonly dataDir: string;
  readonly now?: () => number;
  readonly blocker?: () => string | null;
  readonly busy?: (nowMs: number) => string | null;
  readonly ring?: (nowMs: number) => { id: string; expiresAt: string };
  readonly status?: (id: string, nowMs: number) => InviteStatus;
  readonly notify?: (key: string, text: string, nowMs: number) => void;
  readonly messages?: () => { text: string; createdAt: string }[] | null;
  readonly log?: (message: string) => void;
}

function defaultNotify(dataDir: string) {
  return (key: string, text: string, nowMs: number) => {
    const at = new Date(nowMs).toISOString();
    enqueueOwnerMessage(dataDir, {
      id: `auto-call:${key}`,
      at,
      text,
      origin: {
        kind: "peer_message", channel: "call", author: "Appel automatique", senderRef: "auto-call",
        recipientRef: "principal", threadId: "auto-call", messageId: key, correlationId: key,
      },
    });
    requestHumanWake(dataDir, nowMs);
  };
}

/** Un passage du minuteur. Rend la ligne tracée, s'il y en a une (la dernière). */
export function autoCallTick(deps: AutoCallDeps): AutoCallTrace | null {
  const { dataDir } = deps;
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const state = readAutoCallState(dataDir);
  let traced: AutoCallTrace | null = null;
  const record = (line: AutoCallTrace) => {
    appendAutoCallTrace(dataDir, line);
    state.lastOutcome = line.reason ? `${line.outcome} (${line.reason})` : line.outcome;
    state.lastAt = line.at;
    traced = line;
    deps.log?.(`appel automatique : ${state.lastOutcome}`);
  };

  // 1. Issue de la sonnerie précédente.
  if (state.pendingInvite !== null) {
    const pending = state.pendingInvite;
    const status = (deps.status ?? ((id, n) => inviteStatus(dataDir, id, n)))(pending.id, nowMs);
    if (status === "accept") record({ at: nowIso, outcome: "décroché", inviteId: pending.id });
    else if (status === "decline") record({ at: nowIso, outcome: "sans réponse", reason: "refusé", inviteId: pending.id });
    else if (status === "expired") record({ at: nowIso, outcome: "sans réponse", inviteId: pending.id });
    else if (status === "unknown" && nowMs > Date.parse(pending.expiresAt))
      record({ at: nowIso, outcome: "sans réponse", reason: "issue illisible", inviteId: pending.id });
    if (status !== "pending" && !(status === "unknown" && nowMs <= Date.parse(pending.expiresAt)))
      state.pendingInvite = null;
  }

  // 2. Échéance.
  const due = state.enabled && state.nextAt !== null && Date.parse(state.nextAt) <= nowMs;
  if (!due) {
    if (traced !== null) saveAutoCallState(dataDir, state);
    return traced;
  }
  // Prochaine échéance posée avant d'agir : un arrêt brutal ne fait jamais sonner deux fois.
  state.nextAt = new Date(nowMs + state.intervalMinutes * 60_000).toISOString();
  saveAutoCallState(dataDir, state);

  const blocked = (deps.blocker ?? (() => autoCallBlocker(dataDir)))();
  const busy = blocked === null ? (deps.busy ?? ((n) => autoCallBusy(dataDir, n)))(nowMs) : null;
  if (blocked !== null) record({ at: nowIso, outcome: "sauté", reason: blocked });
  else if (busy !== null || state.pendingInvite !== null)
    record({ at: nowIso, outcome: "sauté", reason: busy ?? "appel en cours (sonnerie précédente sans issue)" });
  else {
    const previous = state.lastCallAt;
    try {
      let messages: { text: string; createdAt: string }[] | null = null;
      try { messages = (deps.messages ?? (() => readOwnerMessages(dataDir)))(); } catch { messages = null; }
      const commitment = findCommitment(messages, previous ?? state.enabledAt);
      if (commitment !== null) state.lastCommitment = commitment;
      const purpose = autoCallPurpose(nowIso, previous ?? state.enabledAt ?? nowIso, state.readFirst, commitment);
      (deps.notify ?? defaultNotify(dataDir))(nowIso, purpose, nowMs);
      const invite = (deps.ring ?? ((n) => ringOwner(dataDir, n)))(nowMs);
      state.pendingInvite = { id: invite.id, at: nowIso, expiresAt: invite.expiresAt };
      state.lastCallAt = nowIso;
      record({ at: nowIso, outcome: "lancé", inviteId: invite.id, previousCallAt: previous });
    } catch (error) {
      record({ at: nowIso, outcome: "sauté", reason: `échec : ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
    }
  }
  saveAutoCallState(dataDir, state);
  return traced;
}

/** Service du daemon : un passage toutes les 15 s. */
export class AutoCallService {
  #timer: NodeJS.Timeout | undefined;
  constructor(private readonly deps: AutoCallDeps, private readonly periodMs = 15_000) {}
  start(): void {
    const run = () => {
      try {
        autoCallTick(this.deps);
      } catch (error) {
        this.deps.log?.(`appel automatique : passage en échec (${String(error)})`);
      }
    };
    run();
    this.#timer = setInterval(run, this.periodMs);
    this.#timer.unref();
  }
  close(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
