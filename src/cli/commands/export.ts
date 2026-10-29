/**
 * `export <chemin>` : copie cohérente et expurgée de l'état et des artefacts vers un
 * dossier choisi par l'humain (src/export). Lecture seule de la base, sauf l'événement
 * `data_exported` ajouté au journal une fois l'export terminé.
 */

import fs from "node:fs";
import path from "node:path";
import { JournalWriter, toUtcTimestamp } from "../../journal/index.js";
import {
  DEFAULT_ARTIFACTS_SUBDIR,
  ExportError,
  exportData,
  type ExportManifest,
} from "../../export/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { CONTROL_DB_FILE } from "../store/index.js";

export interface ExportCommandData {
  readonly exported: boolean;
  readonly target: string;
  readonly refusal: { readonly code: string; readonly detail: string } | null;
  readonly manifest: ExportManifest | null;
}

export function exportCommand(
  ctx: CliContext,
  dataDir: DataDir,
  targetArg: string,
): CommandResult<ExportCommandData> {
  const target = path.resolve(ctx.cwd, targetArg);
  const artifactsRoot = path.join(dataDir.path, DEFAULT_ARTIFACTS_SUBDIR);
  try {
    const { manifest } = exportData({
      dbPath: path.join(dataDir.path, CONTROL_DB_FILE),
      dataDir: dataDir.path,
      target,
      artifactsRoot: fs.existsSync(artifactsRoot) ? artifactsRoot : null,
      now: ctx.now(),
    });
    recordExport(ctx, dataDir, manifest);
    return {
      exitCode: EXIT_OK,
      data: { exported: true, target, refusal: null, manifest },
      human: formatExport,
    };
  } catch (error) {
    if (!(error instanceof ExportError)) throw error;
    return {
      exitCode: EXIT_FAILURE,
      data: {
        exported: false,
        target,
        refusal: { code: error.code, detail: error.message },
        manifest: null,
      },
      human: formatExport,
    };
  }
}

function recordExport(ctx: CliContext, dataDir: DataDir, manifest: ExportManifest): void {
  const store = ctx.openStore(dataDir.path, "write");
  try {
    store.uow.transaction((tx) => {
      if (tx.profiles.get(DEFAULT_PROFILE_ID) === null) return;
      new JournalWriter(tx.journal).record({
        type: "data_exported",
        at: toUtcTimestamp(ctx.now()),
        profileId: DEFAULT_PROFILE_ID,
        reason: "export demandé par l'humain",
        metadata: {
          files: manifest.files.length,
          artifactsCopied: manifest.artifacts.copied,
          artifactsExcluded: manifest.artifacts.excluded.length,
          manifestSchemaVersion: manifest.schemaVersion,
        },
      });
    });
  } finally {
    store.close();
  }
}

function formatExport(data: ExportCommandData): string {
  if (!data.exported || data.manifest === null) {
    return `Export refusé : ${data.refusal?.detail ?? "—"}`;
  }
  const m = data.manifest;
  const charges =
    m.budget.charges.length === 0
      ? "aucune"
      : m.budget.charges
          .map(
            (c) => `${String(c.amount)} ${c.unit}${c.qualifier === "" ? "" : ` (${c.qualifier})`}`,
          )
          .join(", ");
  const lines = [
    `Export créé : ${data.target}`,
    `Manifeste : ${m.schema} v${String(m.schemaVersion)}, lecture dans une transaction SQLite`,
    `Fichiers : ${String(m.files.length)} ; artefacts copiés : ${String(m.artifacts.copied)}, exclus : ${String(m.artifacts.excluded.length)}`,
    ...m.artifacts.excluded.map((a) => `  exclu : ${a.path} (${a.reason})`),
    `Budget copié tel quel : consommation imputée ${charges}`,
    "Expurgé : secrets masqués (heuristique), aucune variable d'environnement.",
    ...m.limits.map((limit) => `Limite : ${limit}`),
  ];
  return lines.join("\n");
}
