/**
 * Rappels martelés : consignes de l'humain réinjectées dans le message de réveil tous les
 * `every` réveils jusqu'à `expiresAt` (24 h par défaut). Store JSON `<dataDir>/wake-reminders.json`.
 * Un fichier absent ou corrompu signifie « aucun rappel » et ne casse jamais le réveil.
 *
 * Compteur : le numéro de réveil du daemon (nombre de `wake_prompts` du profil). Le daemon
 * conserve `lastWake` dans le store ; un ajout fixe `startWake = lastWake + 1`, donc la
 * première injection a lieu au réveil suivant. Sans `lastWake` connu, `startWake` reste
 * `null` et le daemon le fixe au premier réveil qui le voit.
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

export interface ReminderStore {
  readonly lastWake: number | null;
  readonly reminders: readonly WakeReminder[];
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
    return {
      ok: true,
      store: {
        lastWake,
        reminders: list.filter(validReminder).map((r) => ({
          ...r,
          createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
          source: typeof r.source === "string" ? r.source : "",
          startWake: r.startWake ?? null,
        })),
      },
    };
  } catch {
    return { ok: false, store: { lastWake: null, reminders: [] } };
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
  if (reminders.length === store.reminders.length) return false;
  writeReminders(dataDir, { ...store, reminders });
  return true;
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
): { readonly block: string; readonly due: readonly WakeReminder[]; readonly expired: readonly WakeReminder[] } {
  try {
    const { store, ok } = readRemindersChecked(dataDir);
    // Absent ou corrompu : aucun rappel, et on n'écrase pas un fichier illisible.
    if (!ok) return { block: "", due: [], expired: [] };
    const t = now.getTime();
    const expired = store.reminders.filter((r) => Date.parse(r.expiresAt) <= t);
    const active = store.reminders
      .filter((r) => Date.parse(r.expiresAt) > t)
      .map((r) => (r.startWake === null ? { ...r, startWake: wakeNumber } : r));
    const due = active.filter((r) => isDue(r, wakeNumber));
    try {
      writeReminders(dataDir, { lastWake: wakeNumber, reminders: active });
    } catch {
      /* lecture seule : on injecte quand même */
    }
    return { block: reminderBlock(due, expired), due, expired };
  } catch {
    return { block: "", due: [], expired: [] };
  }
}
