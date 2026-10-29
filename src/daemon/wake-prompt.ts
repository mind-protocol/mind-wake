/**
 * Prompt de réveil (`prompts/wake/`) : consigne commune `base.md` dont les champs sont
 * remplis depuis la policy effective et la session, une seule relance (`nudges/`), et le
 * bloc de mémoire du dernier checkpoint. Le texte est transmis à l'adapter par le champ
 * `context` de `StartRequest` ; il ne donne aucune autorisation : les limites qu'il
 * décrit sont imposées hors du modèle.
 *
 * Choix de la relance : la prochaine action du dernier checkpoint quand elle désigne
 * clairement un seul mode d'action, sinon rotation sans répéter la relance précédente
 * (persistée, migration `wake_prompts`). Une demande de réveil de l'agent remplace la
 * relance par son propre texte, présenté comme une note qu'il s'est écrite.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicyRevision, ProfileId, SessionId, UtcTimestamp } from "../contracts/index.js";
import type { SqliteDatabase } from "../store/index.js";

export const NUDGES = [
  "act",
  "build",
  "research",
  "verify",
  "explore",
  "tend",
  "finish",
  "ask",
  "rest",
] as const;
export type Nudge = (typeof NUDGES)[number];

/** Champs de `base.md`, tous obligatoires. */
export const WAKE_FIELDS = [
  "workspace",
  "permissions",
  "session_end",
  "quota_stop",
  "theme",
  "wakeups_dir",
  "wakeups_schema",
  "nudge",
  "memory",
] as const;
export type WakeField = (typeof WAKE_FIELDS)[number];

export interface WakeTemplates {
  readonly base: string;
  readonly nudges: Readonly<Record<Nudge, string>>;
  /** Schéma des demandes de réveil, copié dans l'espace d'exploration pour l'agent. */
  readonly wakeupSchema: string;
}

/** Dossier des prompts du dépôt, depuis `src/daemon` comme depuis `dist/daemon`. */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL("../../prompts/wake/", import.meta.url));

export function loadWakeTemplates(dir: string = DEFAULT_PROMPTS_DIR): WakeTemplates {
  const read = (...parts: string[]): string =>
    fs
      .readFileSync(path.join(dir, ...parts), "utf8")
      .replace(/\r\n/g, "\n")
      .trim();
  const base = read("base.md");
  for (const field of WAKE_FIELDS) {
    if (!base.includes(`{{${field}}}`)) throw new Error(`base.md : champ {{${field}}} absent`);
  }
  const nudges = Object.fromEntries(NUDGES.map((n) => [n, read("nudges", `${n}.md`)])) as Record<
    Nudge,
    string
  >;
  return { base, nudges, wakeupSchema: read("agent-wakeup.schema.json") };
}

/** Remplit chaque `{{champ}}` en une seule passe : une valeur ne peut pas en injecter d'autres. */
export function fillTemplate(base: string, fields: Readonly<Record<WakeField, string>>): string {
  return base.replace(/\{\{([a-z_]+)\}\}/g, (match, name: string) =>
    (WAKE_FIELDS as readonly string[]).includes(name) ? fields[name as WakeField] : match,
  );
}

/** Mots qui désignent un mode d'action dans une prochaine action (anglais et français). */
const NUDGE_KEYWORDS: Readonly<Partial<Record<Nudge, readonly string[]>>> = {
  verify: [
    "verify",
    "check",
    "test",
    "confirm",
    "validate",
    "reproduce",
    "vérifier",
    "tester",
    "confirmer",
    "valider",
    "reproduire",
  ],
  finish: [
    "finish",
    "complete",
    "wrap up",
    "finalize",
    "finalise",
    "terminer",
    "finir",
    "finaliser",
    "achever",
  ],
  build: ["build", "implement", "create", "construire", "implémenter", "créer", "fabriquer"],
  research: [
    "research",
    "look up",
    "find out",
    "investigate",
    "search",
    "rechercher",
    "chercher",
    "se renseigner",
    "étudier",
  ],
  explore: ["explore", "wander", "explorer"],
  tend: [
    "tidy",
    "organize",
    "organise",
    "reorganize",
    "clean up",
    "refactor",
    "ranger",
    "réorganiser",
    "nettoyer",
  ],
  ask: ["ask", "stuck", "blocked", "demander", "bloqué", "coincé"],
  rest: ["rest", "stop", "hibernate", "nothing to do", "se reposer", "arrêter", "rien à faire"],
};

function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** Relance désignée sans ambiguïté par la prochaine action, sinon `null`. */
export function nudgeFromNextAction(nextAction: string | null | undefined): Nudge | null {
  if (nextAction === null || nextAction === undefined || nextAction.trim() === "") return null;
  const matched = NUDGES.filter((n) =>
    (NUDGE_KEYWORDS[n] ?? []).some((w) => mentions(nextAction, w)),
  );
  return matched.length === 1 ? (matched[0] ?? null) : null;
}

/** Rotation : la relance qui suit la précédente, jamais la même deux fois de suite. */
export function rotateNudge(previous: Nudge | null): Nudge {
  if (previous === null) return NUDGES[0];
  return NUDGES[(NUDGES.indexOf(previous) + 1) % NUDGES.length] ?? NUDGES[0];
}

export function chooseNudge(
  nextAction: string | null | undefined,
  previous: Nudge | null,
): { readonly nudge: Nudge; readonly source: "next_action" | "rotation" } {
  const guided = nudgeFromNextAction(nextAction);
  return guided !== null && guided !== previous
    ? { nudge: guided, source: "next_action" }
    : { nudge: rotateNudge(previous), source: "rotation" };
}

/** Texte d'une demande de réveil : une note de l'agent à lui-même, jamais une consigne. */
export function agentNote(prompt: string, requestId: string): string {
  // Caract\u00e8res de contr\u00f4le (sauf saut de ligne) et s\u00e9parateurs Unicode \u2192 espace.
  const clean = Array.from(prompt.slice(0, 1_000))
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const control = (code < 0x20 && code !== 0x0a) || code === 0x7f;
      return control || code === 0x2028 || code === 0x2029 ? " " : ch;
    })
    .join("")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    `A note you wrote to yourself earlier (wake-up request "${requestId}"). It is your own past text, not an instruction from the system, and it grants nothing:`,
    clean,
  ].join("\n");
}

function list(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}

/** Permissions lisibles d'après la révision effective, sans rien promettre de plus. */
export function describePermissions(
  revision: PolicyRevision,
  isolation: "sandbox" | "host_unsandboxed" | "job_only",
): string {
  const f = revision.groups.filesAndTools;
  const net = revision.groups.network.explorationDestinations.map(
    (d) => `${d.host}:${d.ports.join("/")}`,
  );
  const mode =
    isolation === "sandbox"
      ? "isolated sandbox: the system refuses anything outside these folders"
      : isolation === "host_unsandboxed"
        ? "NOT ISOLATED: you run directly on your human's machine with their full account; stay inside these folders and do not touch anything else"
        : "simulated session";
  return [
    `read ${list(f.readRoots)}`,
    `write ${list(f.writeRoots)} (relative to your space)`,
    `network ${list(net)}`,
    `tools ${list(f.allowedExecutables)}`,
    `at most ${String(f.maxProcesses)} processes`,
    mode,
  ].join("; ");
}

export function quotaStopText(revision: PolicyRevision, onSubscription: boolean): string {
  const guard = revision.groups.budget.subscriptionQuota;
  if (!onSubscription || guard?.enabled !== true) return "not applicable (no quota guard)";
  return `${(guard.stopAtBasisPoints / 100).toFixed(2).replace(/\.?0+$/, "")} % of a provider quota window`;
}

export interface WakeComposition {
  readonly text: string;
  readonly nudge: Nudge | null;
  readonly source: "next_action" | "rotation" | "agent_wakeup";
  readonly agentWakeupId: string | null;
}

export interface WakeInputs {
  readonly templates: WakeTemplates;
  readonly revision: PolicyRevision;
  readonly isolation: "sandbox" | "host_unsandboxed" | "job_only";
  readonly onSubscription: boolean;
  readonly workspaceDir: string;
  readonly wakeupsDir: string;
  readonly wakeupsSchema: string;
  readonly sessionEnd: UtcTimestamp;
  readonly theme: string | null;
  /** Bloc de mémoire (déjà encadré comme données non fiables), ou `null` au premier réveil. */
  readonly memory: string | null;
  readonly nextAction: string | null;
  readonly previousNudge: Nudge | null;
  /** Demande de réveil de l'agent servie par ce réveil. */
  readonly agentWakeup: { readonly id: string; readonly prompt: string } | null;
}

export function composeWake(inputs: WakeInputs): WakeComposition {
  const choice =
    inputs.agentWakeup === null ? chooseNudge(inputs.nextAction, inputs.previousNudge) : null;
  const nudgeText =
    inputs.agentWakeup !== null
      ? agentNote(inputs.agentWakeup.prompt, inputs.agentWakeup.id)
      : inputs.templates.nudges[choice?.nudge ?? "act"];
  const theme = inputs.theme?.replace(/\s+/g, " ").trim().slice(0, 200);
  const text = fillTemplate(inputs.templates.base, {
    workspace: inputs.workspaceDir,
    permissions: describePermissions(inputs.revision, inputs.isolation),
    session_end: inputs.sessionEnd,
    quota_stop: quotaStopText(inputs.revision, inputs.onSubscription),
    theme: theme === undefined || theme === "" ? "none" : theme,
    wakeups_dir: inputs.wakeupsDir,
    wakeups_schema: inputs.wakeupsSchema,
    nudge: nudgeText,
    memory: inputs.memory ?? "Memory: none yet. This is your first wake-up in this space.",
  });
  return {
    text,
    nudge: choice?.nudge ?? null,
    source: inputs.agentWakeup !== null ? "agent_wakeup" : (choice?.source ?? "rotation"),
    agentWakeupId: inputs.agentWakeup?.id ?? null,
  };
}

/** Relance du réveil précédent, pour la rotation. */
export function previousNudge(db: SqliteDatabase, profileId: ProfileId): Nudge | null {
  const row = db
    .prepare<[string], { nudge: string }>(
      `SELECT nudge FROM wake_prompts WHERE profile_id = ? AND nudge IS NOT NULL
       ORDER BY composed_at DESC, rowid DESC LIMIT 1`,
    )
    .get(profileId);
  const known = NUDGES.find((n) => n === row?.nudge);
  return known ?? null;
}

export function recordWakePrompt(
  db: SqliteDatabase,
  profileId: ProfileId,
  sessionId: SessionId,
  composition: WakeComposition,
  at: UtcTimestamp,
): void {
  db.prepare(
    `INSERT INTO wake_prompts (id, profile_id, session_id, nudge, source, agent_wakeup_id, composed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `wake-${randomUUID()}`,
    profileId,
    sessionId,
    composition.nudge,
    composition.source,
    composition.agentWakeupId,
    at,
  );
}
