/**
 * `doctor` : diagnostic local. Aucun appel modèle, aucun accès réseau, aucune écriture
 * (le pilote SQLite est testé sur une base `:memory:`).
 */

import type { CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import { inspectDataDir, type DataDir } from "../paths.js";

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

export type CheckStatus = "ok" | "warn" | "fail" | "not_configured";

export interface DoctorCheck {
  readonly id: "node" | "sqlite_driver" | "data_dir" | "persistence" | "isolation" | "adapter";
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorData {
  readonly dataDir: { readonly path: string; readonly source: DataDir["source"] };
  readonly modelCalls: "none";
  readonly networkAccess: "none";
  readonly checks: readonly DoctorCheck[];
}

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: "OK",
  warn: "ATTENTION",
  fail: "ÉCHEC",
  not_configured: "NON CONFIGURÉ",
};

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

  const persistence = ctx.openStore(dataDir.path);
  try {
    checks.push(
      persistence.persistence === "sqlite"
        ? { id: "persistence", status: "ok", detail: "état du profil persisté dans SQLite" }
        : {
            id: "persistence",
            status: "warn",
            detail:
              "stockage SQLite du profil non câblé : état en mémoire, perdu à la fin de la commande",
          },
    );
  } finally {
    persistence.close();
  }

  checks.push(
    {
      id: "isolation",
      status: "not_configured",
      detail: "aucune sandbox installée : exécution autonome impossible",
    },
    {
      id: "adapter",
      status: "not_configured",
      detail: "aucun adapter runtime installé : aucune session ne peut être lancée",
    },
  );

  const failed = checks.some((check) => check.status === "fail");
  return {
    exitCode: failed ? EXIT_FAILURE : EXIT_OK,
    data: {
      dataDir: { path: dataDir.path, source: dataDir.source },
      modelCalls: "none",
      networkAccess: "none",
      checks,
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
  const lines = [
    "Diagnostic MIND Wake (local, sans appel modèle ni accès réseau)",
    `Dossier de données : ${data.dataDir.path} (${SOURCE_LABEL[data.dataDir.source]})`,
    "",
    ...data.checks.map(
      (check) => `  [${STATUS_LABEL[check.status]}] ${check.id} : ${check.detail}`,
    ),
  ];
  const failed = data.checks.filter((check) => check.status === "fail").length;
  lines.push(
    "",
    failed === 0
      ? "Aucun échec bloquant. L'exploration reste désactivée tant qu'isolation et adapter ne sont pas configurés."
      : `${String(failed)} vérification(s) en échec.`,
  );
  return lines.join("\n");
}
