/**
 * `purge` : purge du journal expiré, sur demande explicite. Sans `--apply`, affiche
 * seulement le plan. Ne touche jamais aux expériences, checkpoints, policies ni au
 * ledger : la mémoire courante et le dernier checkpoint restent intacts.
 */

import fs from "node:fs";
import path from "node:path";
import type { PurgeStop } from "../../journal/index.js";
import { toUtcTimestamp } from "../../journal/index.js";
import {
  applyPurge,
  assessStorage,
  measureDataDir,
  planPurge,
  PURGE_PHYSICAL_NOTE,
  purgeRule,
  type RetentionSource,
  type StorageUsage,
} from "../../export/index.js";
import { resolvePolicy } from "../../policy/index.js";
import { openStore } from "../../store/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { CONTROL_DB_FILE } from "../store/index.js";
import { NO_PROFILE_HINT } from "./read.js";

export interface PurgeOptions {
  readonly olderThanDays: number | null;
  readonly apply: boolean;
}

export interface PurgeData {
  readonly applied: boolean;
  readonly refusal: string | null;
  readonly retention: { readonly days: number; readonly source: RetentionSource } | null;
  readonly cutoff: string | null;
  readonly purgeableEvents: number;
  readonly deletedEvents: number;
  readonly keptEvents: number;
  readonly stoppedBy: PurgeStop["kind"] | null;
  readonly storage: {
    readonly before: StorageUsage;
    readonly after: StorageUsage;
    readonly status: string;
  } | null;
  readonly untouched: readonly string[];
  readonly note: string;
}

export const PURGE_UNTOUCHED: readonly string[] = [
  "expériences et checkpoints (dont le dernier checkpoint valide)",
  "révisions de policy, consentements et révocations",
  "ledger : périodes, réservations, usage et imputations",
];

function refused(refusal: string, exitCode = EXIT_FAILURE): CommandResult<PurgeData> {
  return {
    exitCode,
    data: {
      applied: false,
      refusal,
      retention: null,
      cutoff: null,
      purgeableEvents: 0,
      deletedEvents: 0,
      keptEvents: 0,
      stoppedBy: null,
      storage: null,
      untouched: PURGE_UNTOUCHED,
      note: PURGE_PHYSICAL_NOTE,
    },
    human: formatPurge,
  };
}

export function purge(
  ctx: CliContext,
  dataDir: DataDir,
  options: PurgeOptions,
): CommandResult<PurgeData> {
  const dbPath = path.join(dataDir.path, CONTROL_DB_FILE);
  if (!fs.existsSync(dbPath)) return refused(NO_PROFILE_HINT);
  const before = measureDataDir(dataDir.path);
  const store = openStore(dbPath);
  try {
    const { uow, db } = store;
    if (uow.profiles.get(DEFAULT_PROFILE_ID) === null) return refused(NO_PROFILE_HINT);
    const rule = purgeRule(uow, DEFAULT_PROFILE_ID, options.olderThanDays);
    if (!rule.ok) return refused(rule.detail);
    const now = ctx.now();
    const events = uow.journal.list(DEFAULT_PROFILE_ID);
    const plan = planPurge(db, events, DEFAULT_PROFILE_ID, rule.rule, now);
    const deleted = options.apply
      ? applyPurge(db, uow, DEFAULT_PROFILE_ID, plan, rule.source, toUtcTimestamp(now))
          .deletedEvents
      : 0;
    const resolution = resolvePolicy(uow.policies, DEFAULT_PROFILE_ID);
    const cap =
      resolution.status === "active" ? resolution.revision.groups.data.localStorageCapBytes : null;
    const after = options.apply ? measureDataDir(dataDir.path) : before;
    return {
      exitCode: EXIT_OK,
      data: {
        applied: options.apply,
        refusal: null,
        retention: { days: rule.rule.retentionDays, source: rule.source },
        cutoff: plan.cutoff,
        purgeableEvents: plan.purgeCount,
        deletedEvents: deleted,
        keptEvents: plan.keptCount,
        stoppedBy: plan.stoppedBy.kind,
        storage: { before, after, status: assessStorage(after, cap).detail },
        untouched: PURGE_UNTOUCHED,
        note: PURGE_PHYSICAL_NOTE,
      },
      human: formatPurge,
    };
  } finally {
    store.close();
  }
}

function formatPurge(data: PurgeData): string {
  if (data.refusal !== null) return `Purge impossible : ${data.refusal}`;
  const lines = [
    `Rétention : ${String(data.retention?.days ?? 0)} jour(s) (${data.retention?.source === "option" ? "option --older-than-days" : "policy en vigueur"}), seuil ${data.cutoff ?? "—"}`,
    data.applied
      ? `Purge appliquée : ${String(data.deletedEvents)} événement(s) du journal supprimé(s).`
      : `Plan seulement : ${String(data.purgeableEvents)} événement(s) purgeable(s) ; relancer avec --apply pour appliquer.`,
    `Événements conservés : ${String(data.keptEvents)} (arrêt : ${data.stoppedBy ?? "—"})`,
  ];
  if (data.storage !== null) {
    lines.push(
      `Stockage : ${String(data.storage.before.bytes)} → ${String(data.storage.after.bytes)} octets (${data.storage.status})`,
    );
  }
  lines.push(`Jamais purgé : ${data.untouched.join(" ; ")}.`, `Note : ${data.note}.`);
  return lines.join("\n");
}
