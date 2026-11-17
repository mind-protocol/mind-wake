/** Desktop and mobile incidents share the repair agent's durable queue. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";

export const APP_ERROR_CHANNEL = "app-error";
export const APP_ERROR_AUTHOR = "Erreur app";
export const APP_ERROR_APPS = ["desktop", "mobile"] as const;
export type AppErrorApp = (typeof APP_ERROR_APPS)[number];
const MAX_TEXT = 1_000;
const MAX_SCREEN = 120;
const MASK = "[masqué]";

export interface AppErrorReport {
  app: AppErrorApp;
  screen: string;
  text: string;
  /** Moment où l'erreur a été affichée (horloge de l'app), ISO 8601. */
  at: string;
}

const SECRET_PATTERNS: readonly [RegExp, string | ((match: string, ...groups: string[]) => string)][] = [
  // En-têtes et schémas d'authentification.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme: string) => `${scheme} ${MASK}`],
  // Identifiants dans une URL : scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_m, scheme: string) => `${scheme}${MASK}@`],
  // clé=valeur / clé: valeur / "clé":"valeur" pour les noms sensibles.
  [
    /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|pass|api[_-]?key|apikey|api[_-]?hash|authorization|auth|cookie|session[_-]?id|session|signature|sig|private[_-]?key|pairing[_-]?code|otp|code2fa|2fa)["']?\s*[:=]\s*["']?)([^\s"'&,;}]{4,})/gi,
    (_m, key: string) => `${key}${MASK}`,
  ],
  // JWT.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // Préfixes de clés connus (OpenAI/Anthropic/ElevenLabs/Stripe, GitHub, Slack, Google, AWS).
  [/\b(?:sk|pk|rk)[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  // Jeton de bot Telegram.
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, MASK],
  // Jetons opaques : hexadécimal long (sessions du Chat Wake : 64 hex) ou base64url long
  // (majuscule + minuscule + chiffre ; « / » exclu pour garder les chemins lisibles).
  [/\b[a-f0-9]{32,}\b/gi, MASK],
  [/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[A-Z])[A-Za-z0-9+_-]{40,}={0,2}/g, MASK],
];

/** Masque les secrets plausibles. Conservateur : mieux vaut masquer un identifiant qu'exposer un jeton. */
export function redactSecrets(text: string): string {
  let value = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    value = value.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
  return value;
}

function clean(value: string, max: number): string {
  // Caractères de contrôle retirés (sauf saut de ligne), espaces compactés.
  const text = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ").replace(/[ \t]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class AppErrorReportError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Projection stricte : seuls app, écran, texte et horodatage traversent ; rien d'autre n'est conservé. */
export function validateAppErrorReport(input: unknown, now = Date.now): AppErrorReport {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new AppErrorReportError("invalid_app_error");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["app", "screen", "text", "at"].includes(key)))
    throw new AppErrorReportError("invalid_app_error");
  const { app, screen, text, at } = value;
  if (typeof app !== "string" || !(APP_ERROR_APPS as readonly string[]).includes(app))
    throw new AppErrorReportError("invalid_app_error");
  if (typeof text !== "string" || !text.trim() || text.length > 20_000)
    throw new AppErrorReportError("invalid_app_error");
  if (screen !== undefined && (typeof screen !== "string" || screen.length > 1_000))
    throw new AppErrorReportError("invalid_app_error");
  if (at !== undefined && (typeof at !== "string" || !Number.isFinite(Date.parse(at))))
    throw new AppErrorReportError("invalid_app_error");
  return {
    app: app as AppErrorApp,
    screen: clean(redactSecrets(typeof screen === "string" && screen.trim() ? screen : "inconnu"), MAX_SCREEN),
    text: clean(redactSecrets(text), MAX_TEXT),
    at: typeof at === "string" ? new Date(Date.parse(at)).toISOString() : new Date(now()).toISOString(),
  };
}

export function appErrorMessageText(report: AppErrorReport): string {
  const label = report.app === "desktop" ? "app desktop" : "app mobile";
  return (
    `Erreur affichée à NLR — ${label}, écran « ${report.screen} », ${report.at} :\n${report.text}\n` +
    "(Relais automatique, pas un message humain : diagnostiquer et corriger si utile ; ne pas répondre à ce message.)"
  );
}

export function openRepairQueue(dataDir: string): Database.Database {
  const db = new Database(path.join(dataDir, "repair-incidents.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, report TEXT NOT NULL,
    last_seen INTEGER NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1,
    pending INTEGER NOT NULL DEFAULT 1, result TEXT, next_attempt INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS incident_lookup ON incidents(fingerprint, last_seen);`);
  return db;
}

export function relayAppError(dataDir: string, input: unknown, now = Date.now) {
  const report = validateAppErrorReport(input, now);
  const seen = now();
  const shape = report.text.replace(/src posé il y a \d+ s/g, "src posé").replace(/\s+/g, " ").trim();
  const fingerprint = JSON.stringify([report.app, report.screen, shape]);
  const db = openRepairQueue(dataDir);
  try {
    const id = db.transaction(() => {
      const recent = db.prepare(
        "SELECT id FROM incidents WHERE fingerprint = ? AND (pending = 1 OR last_seen >= ?) ORDER BY last_seen DESC LIMIT 1",
      ).get(fingerprint, seen - 15 * 60_000) as { id: string } | undefined;
      if (recent) {
        db.prepare("UPDATE incidents SET last_seen = ?, occurrences = occurrences + 1 WHERE id = ?").run(seen, recent.id);
        return recent.id;
      }
      const id = `app-error-${randomUUID()}`;
      db.prepare("INSERT INTO incidents(id, fingerprint, report, last_seen) VALUES (?, ?, ?, ?)").run(id, fingerprint, JSON.stringify(report), seen);
      return id;
    }).immediate();
    return { id, report };
  } finally { db.close(); }
}
