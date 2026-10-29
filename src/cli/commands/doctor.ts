/**
 * `doctor` : diagnostic local. Aucun appel modèle, aucun accès réseau, aucune écriture
 * (le pilote SQLite est testé sur une base `:memory:`, le stockage n'est ouvert que si
 * le dossier de données existe). Sépare l'environnement (`checks`) de la disponibilité
 * réelle des composants (`capabilities`).
 */

import { capabilities, formatCapability, type Capability } from "../capabilities.js";
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
  readonly notes: readonly string[];
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK", warn: "ATTENTION", fail: "ÉCHEC" };

export const DOCTOR_NOTES: readonly string[] = [
  "Aucune commande de cette CLI n'active l'exploration, n'appelle de modèle, n'envoie de message ni n'installe de service ou de démarrage automatique.",
  "Seul `daemon run --simulated` lance des sessions : au premier plan, avec l'adapter factice, tout marqué SIMULÉ.",
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

  const caps = withReadStore(ctx, dataDir, ({ uow, persistence }) => {
    const profile = uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null;
    const policy =
      profile?.activePolicyRevisionId == null
        ? null
        : (uow?.policies.getRevision(profile.activePolicyRevisionId) ?? null);
    return capabilities(persistence ?? ctx.storeBackend, policy);
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
    "",
    ...data.notes,
    failed === 0
      ? "Environnement sans échec bloquant. Ce build ne peut lancer aucune session réelle : isolation et adapter Codex non implémentés."
      : `${String(failed)} vérification(s) d'environnement en échec.`,
  ].join("\n");
}
