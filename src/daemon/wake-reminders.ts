/**
 * Rappels martelés : consignes de l'humain réinjectées dans le message de réveil tous les
 * `every` réveils jusqu'à `expiresAt` (24 h par défaut). Store JSON `<dataDir>/wake-reminders.json`.
 * Un fichier absent ou corrompu signifie « aucun rappel » et ne casse jamais le réveil.
 *
 * Compteur : le numéro de réveil du daemon (nombre de `wake_prompts` du profil). Le daemon
 * conserve `lastWake` dans le store ; un ajout fixe `startWake = lastWake + 1`, donc la
 * première injection a lieu au réveil suivant. Sans `lastWake` connu, `startWake` reste
 * `null` et le daemon le fixe au premier réveil qui le voit.
 *
 * Rappels ponctuels (`oneShots`, même fichier) : posés par l'agent pour lui-même, livrés une
 * seule fois, soit au réveil `dueWake` (délai en réveils), soit dès `dueAt` (délai en minutes :
 * en cours de session par le hook d'inbox / le steering Codex, sinon au premier réveil après
 * l'échéance). Livré mais non acquitté → signalé « en souffrance » à chaque réveil suivant
 * jusqu'à `ack_reminder`.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REMINDERS_FILE = "wake-reminders.json";
export const DEFAULT_EVERY = 10;
export const DEFAULT_HOURS = 24;

export interface WakeReminder {
  readonly id: string;
  readonly text: string;
  readonly every: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly source: string;
  readonly startWake: number | null;
}

export interface OneShotReminder {
  readonly id: string;
  readonly text: string;
  readonly why: string;
  readonly createdAt: string;
  readonly source: string;
  readonly inWakes: number | null;
  readonly inMinutes: number | null;
  /** Délai en réveils : numéro du réveil de livraison (null tant que le compteur est inconnu). */
  readonly dueWake: number | null;
  /** Délai en minutes : échéance UTC. */
  readonly dueAt: string | null;
  readonly deliveredAt: string | null;
  readonly deliveredVia: "wake" | "session" | null;
  readonly deliveredWake: number | null;
  /** Réservation en cours de session (hook/steering), libérée si non confirmée. */
  readonly claim: string | null;
  readonly claimedAt: string | null;
  readonly ackedAt: string | null;
  readonly overdueSignals: number;
}

export interface ReminderStore {
  readonly lastWake: number | null;
  readonly reminders: readonly WakeReminder[];
  readonly oneShots?: readonly OneShotReminder[];
}

export function remindersPath(dataDir: string): string {
  return path.join(dataDir, REMINDERS_FILE);
}

function validReminder(r: unknown): r is WakeReminder {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["text"] === "string" &&
    o["text"].trim() !== "" &&
    Number.isInteger(o["every"]) &&
    (o["every"] as number) >= 1 &&
    typeof o["expiresAt"] === "string" &&
    !Number.isNaN(Date.parse(o["expiresAt"])) &&
    (o["startWake"] === null || o["startWake"] === undefined || Number.isInteger(o["startWake"]))
  );
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);

function parseOneShot(r: unknown): OneShotReminder | null {
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  const id = str(o["id"]);
  const text = str(o["text"]);
  const why = str(o["why"]);
  if (!id || !text?.trim() || !why?.trim()) return null;
  const inWakes = int(o["inWakes"]);
  const inMinutes = int(o["inMinutes"]);
  const dueAt = str(o["dueAt"]);
  if ((inWakes === null) === (inMinutes === null)) return null;
  if (inMinutes !== null && (dueAt === null || Number.isNaN(Date.parse(dueAt)))) return null;
  const via = o["deliveredVia"];
  return {
    id,
    text,
    why,
    createdAt: str(o["createdAt"]) ?? new Date().toISOString(),
    source: str(o["source"]) ?? "",
    inWakes,
    inMinutes,
    dueWake: int(o["dueWake"]),
    dueAt: inMinutes === null ? null : dueAt,
    deliveredAt: str(o["deliveredAt"]),
    deliveredVia: via === "wake" || via === "session" ? via : null,
    deliveredWake: int(o["deliveredWake"]),
    claim: str(o["claim"]),
    claimedAt: str(o["claimedAt"]),
    ackedAt: str(o["ackedAt"]),
    overdueSignals: int(o["overdueSignals"]) ?? 0,
  };
}

/** Lecture tolérante : fichier absent/corrompu → store vide ; entrées invalides ignorées. */
export function readReminders(dataDir: string): ReminderStore {
  return readRemindersChecked(dataDir).store;
}

function readRemindersChecked(dataDir: string): { store: ReminderStore; ok: boolean } {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(remindersPath(dataDir), "utf8"));
    const obj = (Array.isArray(raw) ? { reminders: raw } : raw) as Record<string, unknown>;
    const list = Array.isArray(obj["reminders"]) ? obj["reminders"] : [];
    const lastWake = Number.isInteger(obj["lastWake"]) ? (obj["lastWake"] as number) : null;
    const oneShots = (Array.isArray(obj["oneShots"]) ? obj["oneShots"] : [])
      .map(parseOneShot)
      .filter((r): r is OneShotReminder => r !== null);
    return {
      ok: true,
      store: {
        lastWake,
        oneShots,
        reminders: list.filter(validReminder).map((r) => ({
          ...r,
          createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
          source: typeof r.source === "string" ? r.source : "",
          startWake: r.startWake ?? null,
        })),
      },
    };
  } catch (error) {
    // Absent : store vide valide (le compteur de réveils peut s'y inscrire). Illisible : ok=false.
    const absent = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
    return { ok: absent, store: { lastWake: null, reminders: [], oneShots: [] } };
  }
}

export function writeReminders(dataDir: string, store: ReminderStore): void {
  const file = remindersPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function addReminder(
  dataDir: string,
  input: { text: string; every?: number; hours?: number; source: string },
  now: Date = new Date(),
): WakeReminder {
  const every = input.every ?? DEFAULT_EVERY;
  const hours = input.hours ?? DEFAULT_HOURS;
  if (!Number.isInteger(every) || every < 1) throw new Error("every doit être un entier ≥ 1");
  if (!(hours > 0)) throw new Error("hours doit être > 0");
  const text = input.text.trim();
  if (text === "") throw new Error("text vide");
  const store = readReminders(dataDir);
  const reminder: WakeReminder = {
    id: `rappel-${randomUUID().slice(0, 8)}`,
    text,
    every,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    source: input.source,
    startWake: store.lastWake === null ? null : store.lastWake + 1,
  };
  writeReminders(dataDir, { ...store, reminders: [...store.reminders, reminder] });
  return reminder;
}

export function removeReminder(dataDir: string, id: string): boolean {
  const store = readReminders(dataDir);
  const reminders = store.reminders.filter((r) => r.id !== id);
  const oneShots = (store.oneShots ?? []).filter((r) => r.id !== id);
  if (reminders.length === store.reminders.length && oneShots.length === (store.oneShots ?? []).length)
    return false;
  writeReminders(dataDir, { ...store, reminders, oneShots });
  return true;
}

/** Pose un rappel ponctuel : exactement un délai, en réveils ou en minutes. */
export function setOneShotReminder(
  dataDir: string,
  input: {
    text: string;
    why: string;
    inWakes?: number | undefined;
    inMinutes?: number | undefined;
    source?: string | undefined;
  },
  now: Date = new Date(),
): OneShotReminder {
  const text = input.text.trim();
  const why = input.why.trim();
  if (text === "") throw new Error("text vide");
  if (why === "" || /[\r\n]/.test(why)) throw new Error("why : une ligne non vide est obligatoire");
  const inWakes = input.inWakes ?? null;
  const inMinutes = input.inMinutes ?? null;
  if ((inWakes === null) === (inMinutes === null))
    throw new Error("indiquer exactement un délai : in_wakes ou in_minutes");
  for (const [name, v] of [
    ["in_wakes", inWakes],
    ["in_minutes", inMinutes],
  ] as const)
    if (v !== null && (!Number.isInteger(v) || v < 1)) throw new Error(`${name} doit être un entier ≥ 1`);
  const { store, ok } = readRemindersChecked(dataDir);
  // Ne jamais écraser un fichier existant mais illisible (on perdrait les autres rappels).
  if (!ok && fs.existsSync(remindersPath(dataDir)))
    throw new Error(`${REMINDERS_FILE} illisible : le réparer avant de poser un rappel`);
  const reminder: OneShotReminder = {
    id: `ponctuel-${randomUUID().slice(0, 8)}`,
    text,
    why,
    createdAt: now.toISOString(),
    source: input.source ?? "",
    inWakes,
    inMinutes,
    dueWake: inWakes !== null && store.lastWake !== null ? store.lastWake + inWakes : null,
    dueAt: inMinutes !== null ? new Date(now.getTime() + inMinutes * 60_000).toISOString() : null,
    deliveredAt: null,
    deliveredVia: null,
    deliveredWake: null,
    claim: null,
    claimedAt: null,
    ackedAt: null,
    overdueSignals: 0,
  };
  writeReminders(dataDir, { ...store, oneShots: [...(store.oneShots ?? []), reminder] });
  return reminder;
}

/** Acquitte un rappel ponctuel livré (ou annule un rappel pas encore livré). */
export function ackOneShotReminder(
  dataDir: string,
  id: string,
  now: Date = new Date(),
): { readonly acked: boolean; readonly wasDelivered: boolean } {
  const store = readReminders(dataDir);
  const target = (store.oneShots ?? []).find((r) => r.id === id);
  if (!target) return { acked: false, wasDelivered: false };
  if (target.ackedAt === null)
    writeReminders(dataDir, {
      ...store,
      oneShots: (store.oneShots ?? []).map((r) => (r.id === id ? { ...r, ackedAt: now.toISOString() } : r)),
    });
  return { acked: true, wasDelivered: target.deliveredAt !== null };
}

function utc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function oneShotDueLabel(r: OneShotReminder): string {
  if (r.dueAt !== null) return utc(r.dueAt);
  return r.dueWake !== null
    ? `le réveil n° ${String(r.dueWake)}`
    : `dans ${String(r.inWakes)} réveil(s) (compteur pas encore connu)`;
}

function oneShotLine(r: OneShotReminder, now: Date): string {
  const lateMin = r.dueAt === null ? 0 : Math.round((now.getTime() - Date.parse(r.dueAt)) / 60_000);
  const late = lateMin > 5 ? ` (échu depuis ${String(lateMin)} min, livré en retard)` : "";
  return `- [${r.id}] ${r.text}\n  Pourquoi : ${r.why}\n  Posé le ${utc(r.createdAt)} pour ${oneShotDueLabel(r)}${late}.`;
}

function overdueLine(r: OneShotReminder): string {
  const via =
    r.deliveredVia === "session" ? "en cours de session" : `au réveil n° ${String(r.deliveredWake)}`;
  return `- [${r.id}] ${r.text}\n  Pourquoi : ${r.why}\n  Posé le ${utc(r.createdAt)}, livré ${via} le ${utc(r.deliveredAt ?? r.createdAt)}, toujours non acquitté (signalé ${String(r.overdueSignals)} fois).`;
}

const ACK_HINT =
  "Une fois traité (ou abandonné en connaissance de cause), acquitte chaque rappel avec ack_reminder(id) ; sinon il reviendra « en souffrance » au réveil suivant.";

/** Bloc des rappels ponctuels, sans effet de bord (testable). */
export function oneShotBlock(
  due: readonly OneShotReminder[],
  overdue: readonly OneShotReminder[],
  now: Date = new Date(),
): string {
  const parts: string[] = [];
  if (due.length)
    parts.push(
      `Rappels ponctuels arrivés à échéance (posés par toi-même, livrés une seule fois) :\n${due.map((r) => oneShotLine(r, now)).join("\n")}`,
    );
  if (overdue.length)
    parts.push(`Rappels en souffrance (livrés mais non acquittés) :\n${overdue.map(overdueLine).join("\n")}`);
  if (parts.length) parts.push(ACK_HINT);
  return parts.join("\n");
}

const CLAIM_TTL_MS = 60_000;
const ACKED_RETENTION_MS = 7 * 24 * 3_600_000;

function claimFree(r: OneShotReminder, t: number): boolean {
  return r.claim === null || !(t - Date.parse(r.claimedAt ?? "") < CLAIM_TTL_MS);
}

/**
 * En cours de session (hook Claude, steering Codex) : réserve les rappels en minutes échus et
 * non livrés, retourne le texte à pousser ; `finishSessionReminders` confirme ou libère.
 * Ne lève jamais ; n'écrit rien s'il n'y a rien à livrer ou si le fichier est illisible.
 */
export function claimSessionReminders(
  dataDir: string,
  claim: string,
  now: Date = new Date(),
): string | null {
  try {
    const { store, ok } = readRemindersChecked(dataDir);
    if (!ok) return null;
    const t = now.getTime();
    const due = (store.oneShots ?? []).filter(
      (r) =>
        r.deliveredAt === null &&
        r.ackedAt === null &&
        r.dueAt !== null &&
        Date.parse(r.dueAt) <= t &&
        claimFree(r, t),
    );
    if (!due.length) return null;
    const ids = new Set(due.map((r) => r.id));
    writeReminders(dataDir, {
      ...store,
      oneShots: (store.oneShots ?? []).map((r) =>
        ids.has(r.id) ? { ...r, claim, claimedAt: now.toISOString() } : r,
      ),
    });
    return `MIND runtime / rappel ponctuel (posé par toi-même, pas un message de ton humain) :\n${oneShotBlock(due, [], now)}`;
  } catch {
    return null;
  }
}

export function finishSessionReminders(
  dataDir: string,
  claim: string,
  accepted: boolean,
  now: Date = new Date(),
): void {
  try {
    const { store, ok } = readRemindersChecked(dataDir);
    if (!ok || !(store.oneShots ?? []).some((r) => r.claim === claim)) return;
    writeReminders(dataDir, {
      ...store,
      oneShots: (store.oneShots ?? []).map((r) =>
        r.claim !== claim
          ? r
          : accepted
            ? {
                ...r,
                claim: null,
                claimedAt: null,
                deliveredAt: now.toISOString(),
                deliveredVia: "session" as const,
              }
            : { ...r, claim: null, claimedAt: null },
      ),
    });
  } catch {
    /* non confirmé : livré au prochain réveil */
  }
}

export function isDue(r: WakeReminder, wakeNumber: number): boolean {
  const start = r.startWake ?? wakeNumber;
  return wakeNumber >= start && (wakeNumber - start) % r.every === 0;
}

function parisTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function reminderLine(r: WakeReminder): string {
  return `Rappel de NLR (actif jusqu'au ${parisTime(r.expiresAt)}, tous les ${String(r.every)} réveils) : ${r.text}`;
}

export function expiredLine(r: WakeReminder): string {
  return `Le rappel "${r.text}" a expiré : faut-il l'inscrire durablement (semence d'un holder ou config de room) ? Sinon il s'efface.`;
}

/** Bloc à injecter, sans effet de bord (testable). */
export function reminderBlock(due: readonly WakeReminder[], expired: readonly WakeReminder[]): string {
  const lines = [...due.map(reminderLine), ...expired.map(expiredLine)];
  return lines.length === 0 ? "" : `Rappels martelés (consignes persistantes de l'humain) :\n${lines.join("\n")}`;
}

/**
 * Appelé une fois par réveil : enregistre `lastWake`, fixe les `startWake` manquants,
 * retourne les rappels dus et les rappels expirés (signalés une seule fois puis supprimés).
 * Ne lève jamais.
 */
export function takeWakeReminders(
  dataDir: string,
  wakeNumber: number,
  now: Date = new Date(),
): {
  readonly block: string;
  readonly due: readonly WakeReminder[];
  readonly expired: readonly WakeReminder[];
  readonly oneShotsDue: readonly OneShotReminder[];
  readonly oneShotsOverdue: readonly OneShotReminder[];
} {
  const none = { block: "", due: [], expired: [], oneShotsDue: [], oneShotsOverdue: [] };
  try {
    const { store, ok } = readRemindersChecked(dataDir);
    // Absent ou corrompu : aucun rappel, et on n'écrase pas un fichier illisible.
    if (!ok) return none;
    const t = now.getTime();
    const expired = store.reminders.filter((r) => Date.parse(r.expiresAt) <= t);
    const active = store.reminders
      .filter((r) => Date.parse(r.expiresAt) > t)
      .map((r) => (r.startWake === null ? { ...r, startWake: wakeNumber } : r));
    const due = active.filter((r) => isDue(r, wakeNumber));
    const oneShotsDue: OneShotReminder[] = [];
    const oneShotsOverdue: OneShotReminder[] = [];
    const oneShots = (store.oneShots ?? [])
      .filter((r) => r.ackedAt === null || t - Date.parse(r.ackedAt) < ACKED_RETENTION_MS)
      .map((r): OneShotReminder => {
        if (r.ackedAt !== null) return r;
        if (r.deliveredAt !== null) {
          // Livré à un réveil précédent ou en cours de session, jamais acquitté : on le redit.
          if (r.deliveredVia === "wake" && r.deliveredWake === wakeNumber) return r;
          const next = { ...r, overdueSignals: r.overdueSignals + 1 };
          oneShotsOverdue.push(next);
          return next;
        }
        const fixed =
          r.inWakes !== null && r.dueWake === null ? { ...r, dueWake: wakeNumber + r.inWakes - 1 } : r;
        const dueNow =
          (fixed.dueWake !== null && wakeNumber >= fixed.dueWake) ||
          (fixed.dueAt !== null && Date.parse(fixed.dueAt) <= t);
        if (!dueNow) return fixed;
        const delivered = {
          ...fixed,
          claim: null,
          claimedAt: null,
          deliveredAt: now.toISOString(),
          deliveredVia: "wake" as const,
          deliveredWake: wakeNumber,
        };
        oneShotsDue.push(delivered);
        return delivered;
      });
    try {
      writeReminders(dataDir, { lastWake: wakeNumber, reminders: active, oneShots });
    } catch {
      /* lecture seule : on injecte quand même */
    }
    const block = [reminderBlock(due, expired), oneShotBlock(oneShotsDue, oneShotsOverdue, now)]
      .filter(Boolean)
      .join("\n\n");
    return { block, due, expired, oneShotsDue, oneShotsOverdue };
  } catch {
    return none;
  }
}
