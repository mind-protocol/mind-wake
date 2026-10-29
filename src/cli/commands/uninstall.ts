/**
 * `uninstall` : arrête ce qui doit l'être, retire les mécanismes de lancement et
 * applique le choix explicite de l'humain sur les données (`--keep-data` ou
 * `--delete-data`, ou réponse dans le terminal). `--dry-run` liste les effets sans rien
 * modifier. Rien n'est jamais touché hors du dossier de données.
 */

import {
  deleteDataDir,
  planUninstall,
  type DataChoice,
  type DeletionResult,
  type UninstallPlan,
} from "../../export/index.js";
import type { CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";

export interface UninstallOptions {
  readonly dryRun: boolean;
  readonly choice: DataChoice | null;
  /** `--json` : jamais de saisie interactive. */
  readonly interactive: boolean;
}

export interface UninstallData {
  readonly dryRun: boolean;
  readonly outcome: "planned" | "data_kept" | "data_deleted" | "partial" | "refused" | "aborted";
  readonly detail: string;
  /** Plans par choix : un seul si le choix est fait, les deux en `--dry-run` sans choix. */
  readonly plans: readonly UninstallPlan[];
  readonly deletion: DeletionResult | null;
}

const CONFIRM_DELETE = "SUPPRIMER";

async function askChoice(ctx: CliContext): Promise<DataChoice | "abort"> {
  if (ctx.prompt === undefined) return "abort";
  const answer = (
    (await ctx.prompt(
      "Conserver ou supprimer les données de MIND Wake ? [conserver/supprimer] ",
    )) ?? ""
  )
    .trim()
    .toLowerCase();
  if (answer === "conserver" || answer === "c") return "keep";
  if (answer !== "supprimer" && answer !== "s") return "abort";
  const confirm = await ctx.prompt(`Taper ${CONFIRM_DELETE} pour confirmer la suppression : `);
  return confirm?.trim() === CONFIRM_DELETE ? "delete" : "abort";
}

export async function uninstall(
  ctx: CliContext,
  dataDir: DataDir,
  options: UninstallOptions,
): Promise<CommandResult<UninstallData>> {
  const env = { cwd: ctx.cwd, homeDir: ctx.homeDir };
  const result = (
    exitCode: number,
    data: Omit<UninstallData, "dryRun">,
  ): CommandResult<UninstallData> => ({
    exitCode,
    data: { ...data, dryRun: options.dryRun },
    human: formatUninstall,
  });

  if (options.dryRun) {
    const choices: readonly DataChoice[] =
      options.choice === null ? ["keep", "delete"] : [options.choice];
    return result(EXIT_OK, {
      outcome: "planned",
      detail: "simulation : aucun fichier modifié",
      plans: choices.map((choice) => planUninstall(dataDir.path, choice, env)),
      deletion: null,
    });
  }

  let choice = options.choice;
  if (choice === null) {
    const asked = options.interactive ? await askChoice(ctx) : "abort";
    if (asked === "abort") {
      return result(EXIT_FAILURE, {
        outcome: "aborted",
        detail:
          "choix explicite requis : répondre dans un terminal interactif, ou passer --keep-data ou --delete-data ; rien n'a été modifié",
        plans: [],
        deletion: null,
      });
    }
    choice = asked;
  }

  const plan = planUninstall(dataDir.path, choice, env);
  if (choice === "keep") {
    return result(EXIT_OK, {
      outcome: "data_kept",
      detail: "désinstallation terminée ; données conservées",
      plans: [plan],
      deletion: null,
    });
  }
  if (plan.refusal !== null) {
    return result(EXIT_FAILURE, {
      outcome: "refused",
      detail: plan.refusal,
      plans: [plan],
      deletion: null,
    });
  }
  const deletion = deleteDataDir(plan.dataDir);
  return deletion.failed.length === 0
    ? result(EXIT_OK, {
        outcome: "data_deleted",
        detail: `${String(deletion.removed)} entrée(s) supprimée(s) et dossier de données retiré`,
        plans: [plan],
        deletion,
      })
    : result(EXIT_FAILURE, {
        outcome: "partial",
        detail: `${String(deletion.removed)} entrée(s) supprimée(s), ${String(deletion.failed.length)} échec(s) : le dossier de données subsiste`,
        plans: [plan],
        deletion,
      });
}

const CHOICE_LABEL: Record<DataChoice, string> = {
  keep: "conserver les données",
  delete: "supprimer les données",
};

function formatUninstall(data: UninstallData): string {
  const lines = [
    data.dryRun ? "Désinstallation (simulation, aucun fichier modifié) :" : "Désinstallation :",
  ];
  for (const plan of data.plans) {
    lines.push(`Si « ${CHOICE_LABEL[plan.choice]} » (${plan.dataDir}) :`);
    for (const effect of plan.effects) {
      lines.push(
        `  [${effect.changes ? "MODIFIE" : "AUCUN EFFET"}] ${effect.kind} : ${effect.detail}`,
      );
    }
  }
  for (const failure of data.deletion?.failed ?? []) {
    lines.push(`  échec : ${failure.path} — ${failure.detail}`);
  }
  lines.push(`Résultat : ${data.detail}`);
  return lines.join("\n");
}
