/**
 * `doctor` : diagnostic local. Aucun appel modèle, aucun accès réseau, aucune écriture
 * dans le dossier de données (le pilote SQLite est testé sur une base `:memory:`, le
 * stockage n'est ouvert que si le dossier de données existe). Sépare l'environnement
 * (`checks`) de la disponibilité réelle des composants (`capabilities`).
 *
 * L'isolation n'est « présente » que si l'autotest de refus réussit sur le poste
 * (`src/sandbox/self-test.ts`) : il crée un profil AppContainer et des ACE temporaires
 * dans le dossier temporaire, les retire, et vérifie ce retrait. Ses seules connexions
 * sont locales (loopback et pipes nommés du test) et doivent être refusées au conteneur.
 */

import type { IsolationSelfTestReport } from "../../sandbox/index.js";
import {
  BUILD_COMPONENTS,
  capabilities,
  formatCapability,
  type Capability,
  type IsolationAssessment,
} from "../capabilities.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import { inspectDataDir, type DataDir } from "../paths.js";
import { withReadStore } from "./read.js";

export const SUPPORTED_NODE_RANGE = "^24.17.0 || ^26.13.0";

const SUPPORTED_NODE: readonly (readonly [major: number, minor: number, patch: number])[] = [
  [24, 17, 0],
  [26, 13, 0],
];

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return SUPPORTED_NODE.some(
    ([m, mi, p]) => major === m && (minor > mi || (minor === mi && patch >= p)),
  );
}

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: "node" | "sqlite_driver" | "data_dir";
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorData {
  readonly dataDir: { readonly path: string; readonly source: DataDir["source"] };
  readonly modelCalls: "none";
  readonly networkAccess: "none";
  readonly checks: readonly DoctorCheck[];
  readonly capabilities: readonly Capability[];
  /** Résumé de l'autotest de refus ; absent s'il n'a pas été exécuté. */
  readonly isolationSelfTest?: IsolationSelfTestSummary;
  readonly notes: readonly string[];
}

export interface IsolationSelfTestSummary {
  readonly passed: boolean;
  readonly checks: number;
  readonly failed: readonly string[];
  readonly notDemonstrated: readonly string[];
  readonly terminationMs: number | null;
  readonly cleanup: IsolationSelfTestReport["cleanup"];
  readonly durationMs: number;
  readonly error?: string;
}

/** Verdict d'isolation dérivé de l'autotest : « présente » seulement si tout a passé. */
export function assessIsolation(report: IsolationSelfTestReport): IsolationAssessment {
  const termination =
    report.termination === null
      ? ""
      : `, arborescence terminée en ${report.termination.elapsedMs.toFixed(1)} ms`;
  if (report.passed) {
    return {
      passed: true,
      detail: `AppContainer sans capacité + Job Object : ${String(report.checks.length)} refus système vérifiés sur ce poste${termination}, nettoyage vérifié`,
      blockers: [],
    };
  }
  const blockers = report.checks.filter((c) => !c.passed).map((c) => `refus non obtenu : ${c.id}`);
  if (report.error !== undefined) blockers.push(report.error);
  const cleanup = report.cleanup;
  if (cleanup !== null && !(cleanup.aclRemoved && cleanup.profileRemoved && cleanup.tempRemoved)) {
    blockers.push("nettoyage de l'autotest non vérifié");
  }
  return {
    passed: false,
    detail: "autotest de refus en échec : exécution autonome impossible",
    blockers: blockers.length === 0 ? ["autotest de refus en échec"] : blockers,
  };
}

function summarize(report: IsolationSelfTestReport): IsolationSelfTestSummary {
  return {
    passed: report.passed,
    checks: report.checks.length,
    failed: report.checks.filter((c) => !c.passed).map((c) => c.id),
    notDemonstrated: report.notDemonstrated,
    terminationMs: report.termination?.elapsedMs ?? null,
    cleanup: report.cleanup,
    durationMs: report.durationMs,
    ...(report.error === undefined ? {} : { error: report.error }),
  };
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK", warn: "ATTENTION", fail: "ÉCHEC" };

export const DOCTOR_NOTES: readonly string[] = [
  "Aucune commande de cette CLI n'active l'exploration, n'appelle de modèle, n'envoie de message ni n'installe de service ou de démarrage automatique.",
  "`daemon run --simulated` lance des sessions au premier plan avec l'adapter factice, tout marqué SIMULÉ ; `daemon run` (mode réel) exige un adapter réel enregistré et disponible, lancé seulement dans la sandbox après un autotest de refus réussi.",
  "Voie abonnement : avant toute activation future, désactiver l'achat automatique de crédits du forfait (ADR-004) ; cette CLI ne le vérifie pas.",
];

export async function doctor(
  ctx: CliContext,
  dataDir: DataDir,
): Promise<CommandResult<DoctorData>> {
  const checks: DoctorCheck[] = [];

  checks.push(
    isSupportedNodeVersion(ctx.nodeVersion)
      ? {
          id: "node",
          status: "ok",
          detail: `Node ${ctx.nodeVersion} (requis : ${SUPPORTED_NODE_RANGE})`,
        }
      : {
          id: "node",
          status: "fail",
          detail: `Node ${ctx.nodeVersion} non pris en charge (requis : ${SUPPORTED_NODE_RANGE})`,
        },
  );

  const sqlite = await ctx.probeSqlite();
  checks.push(
    sqlite.status === "ok"
      ? {
          id: "sqlite_driver",
          status: "ok",
          detail: `${sqlite.driver}, SQLite ${sqlite.sqliteVersion}`,
        }
      : {
          id: "sqlite_driver",
          status: "fail",
          detail: `${sqlite.driver} indisponible : ${sqlite.detail}`,
        },
  );

  const dirState = inspectDataDir(dataDir.path);
  switch (dirState.status) {
    case "missing":
      checks.push({
        id: "data_dir",
        status: "warn",
        detail: "dossier absent : il sera créé par `mind-wake init`",
      });
      break;
    case "not_directory":
      checks.push({
        id: "data_dir",
        status: "fail",
        detail: "le chemin existe mais n'est pas un dossier",
      });
      break;
    case "ok":
      checks.push(
        dirState.writable
          ? { id: "data_dir", status: "ok", detail: "dossier présent et accessible en écriture" }
          : {
              id: "data_dir",
              status: "fail",
              detail: "dossier présent mais non accessible en écriture",
            },
      );
      break;
  }

  const selfTest = ctx.isolationSelfTest === undefined ? undefined : await ctx.isolationSelfTest();
  const isolation = selfTest === undefined ? undefined : assessIsolation(selfTest);
  const caps = withReadStore(ctx, dataDir, ({ uow, persistence }) => {
    const profile = uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null;
    const policy =
      profile?.activePolicyRevisionId == null
        ? null
        : (uow?.policies.getRevision(profile.activePolicyRevisionId) ?? null);
    return capabilities(persistence ?? ctx.storeBackend, policy, isolation);
  });

  const failed = checks.some((check) => check.status === "fail");
  return {
    exitCode: failed ? EXIT_FAILURE : EXIT_OK,
    data: {
      dataDir: { path: dataDir.path, source: dataDir.source },
      modelCalls: "none",
      networkAccess: "none",
      checks,
      capabilities: caps,
      ...(selfTest === undefined ? {} : { isolationSelfTest: summarize(selfTest) }),
      notes: DOCTOR_NOTES,
    },
    human: formatDoctor,
  };
}

const SOURCE_LABEL: Record<DataDir["source"], string> = {
  option: "option --data-dir",
  environment: "variable MIND_WAKE_DATA_DIR",
  default: "emplacement par défaut",
};

function formatDoctor(data: DoctorData): string {
  const failed = data.checks.filter((check) => check.status === "fail").length;
  return [
    "Diagnostic MIND Wake (local, sans appel modèle ni accès réseau)",
    `Dossier de données : ${data.dataDir.path} (${SOURCE_LABEL[data.dataDir.source]})`,
    "",
    "Environnement :",
    ...data.checks.map(
      (check) => `  [${STATUS_LABEL[check.status]}] ${check.id} : ${check.detail}`,
    ),
    "",
    "Composants (présent, simulé, expérimental, bloqué, non implémenté) :",
    ...data.capabilities.map(formatCapability),
    ...formatSelfTest(data.isolationSelfTest),
    "",
    ...data.notes,
    failed === 0
      ? BUILD_COMPONENTS.runtimeAdapter
        ? "Environnement sans échec bloquant. Sessions réelles possibles seulement dans la sandbox, après autotest de refus réussi."
        : "Environnement sans échec bloquant. Ce build ne peut lancer aucune session réelle : aucun adapter réel enregistré (codex, claude, gemini)."
      : `${String(failed)} vérification(s) d'environnement en échec.`,
  ].join("\n");
}

function formatSelfTest(summary: IsolationSelfTestSummary | undefined): string[] {
  if (summary === undefined) return [];
  const lines = [
    "",
    `Autotest d'isolation : ${summary.passed ? "réussi" : "ÉCHEC"} (${String(summary.checks)} vérifications, ${(summary.durationMs / 1000).toFixed(1)} s)`,
  ];
  if (summary.failed.length > 0) lines.push(`  refus non obtenus : ${summary.failed.join(", ")}`);
  if (summary.error !== undefined) lines.push(`  erreur : ${summary.error}`);
  for (const item of summary.notDemonstrated) lines.push(`  non démontré : ${item}`);
  const cleanup = summary.cleanup;
  if (cleanup !== null) {
    const ok = cleanup.aclRemoved && cleanup.profileRemoved && cleanup.tempRemoved;
    lines.push(`  nettoyage (ACE, profil, dossiers temporaires) : ${ok ? "vérifié" : "INCOMPLET"}`);
  }
  return lines;
}
