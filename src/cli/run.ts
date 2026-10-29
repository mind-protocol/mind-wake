/**
 * Analyse des arguments et répartition des commandes. Renvoie le code de sortie au lieu
 * de terminer le processus, pour rester testable.
 */

import { parseArgs } from "node:util";
import { doctor } from "./commands/doctor.js";
import { enable } from "./commands/enable.js";
import { exportCommand } from "./commands/export.js";
import { init } from "./commands/init.js";
import { DEFAULT_JOURNAL_LIMIT, journal, MAX_JOURNAL_LIMIT } from "./commands/journal.js";
import { pause } from "./commands/pause.js";
import { policyConfigure } from "./commands/policy-configure.js";
import { policyShow } from "./commands/policy.js";
import { purge } from "./commands/purge.js";
import { resume } from "./commands/resume.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { uninstall } from "./commands/uninstall.js";
import type { CliContext } from "./context.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  renderError,
  renderResult,
  type CommandResult,
} from "./output.js";
import { resolveDataDir } from "./paths.js";

export const USAGE = `Usage : mind-wake <commande> [options]

Interface locale de MIND Wake pour votre propre agent. Aucune commande de paiement,
de transaction ou de session guest ; aucune commande ne lance de session.

Commandes :
  doctor        Diagnostic local, sans appel modèle ni accès réseau
  init          Prépare un profil désactivé, sans budget ni permission
  status        État, expérience active, budget, prochain réveil
  journal       Derniers événements (--limit N, --after SÉQUENCE)
  policy show   Révision de policy active, consentement et révocations
  pause         Plus aucun réveil ; la session en cours s'arrête après checkpoint
  resume        Lève une pause (refusée après un arrêt d'urgence)
  stop          Arrêt d'urgence : verrouille le profil, termine les processus
  policy configure FICHIER.json
                Propose une révision validée, sans effet avant \`enable\`
  enable        Active la révision proposée après confirmation humaine : code saisi
                dans le terminal, ou --confirm CODE (--revision ID). Refusé tant que
                l'isolation et l'adapter ne sont pas livrés
  export CHEMIN Copie cohérente et expurgée de l'état et des artefacts, avec manifeste
  purge         Plan de purge du journal expiré (--older-than-days N) ; --apply l'applique
  uninstall     --dry-run liste les effets ; --keep-data ou --delete-data, sinon
                question dans le terminal

Réservés à l'humain : --confirm et la saisie du code de \`enable\`, le choix de
\`uninstall\`. Ni la skill ni l'espace d'exploration ne doivent les utiliser.

Options :
  --json             Sortie JSON versionnée (schema mind-wake.cli, schemaVersion 1)
  --data-dir CHEMIN  Dossier de données (sinon MIND_WAKE_DATA_DIR, sinon défaut)
  --help             Affiche cette aide
`;

class UsageError extends Error {
  override readonly name = "UsageError";
}

function parseIntegerOption(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} attend un entier`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new UsageError(`--${name} doit être compris entre ${String(min)} et ${String(max)}`);
  }
  return value;
}

export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const json = argv.includes("--json");
  let command = "help";
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        "data-dir": { type: "string" },
        limit: { type: "string" },
        after: { type: "string" },
        confirm: { type: "string" },
        revision: { type: "string" },
        "older-than-days": { type: "string" },
        apply: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "keep-data": { type: "boolean" },
        "delete-data": { type: "boolean" },
      },
    });
    const [first, second, ...rest] = positionals;
    command = first === "policy" && second !== undefined ? `policy ${second}` : (first ?? "help");
    const args = first === "policy" ? rest : positionals.slice(1);
    // Seuls `export` et `policy configure` prennent un argument positionnel.
    const takesArgument = command === "export" || command === "policy configure";
    const argument = takesArgument ? args[0] : undefined;
    const extra = takesArgument ? args.slice(1) : args;

    if (values.help === true || command === "help") {
      ctx.stdout(USAGE);
      return first === undefined && values.help !== true ? EXIT_USAGE : EXIT_OK;
    }
    if (extra.length > 0) throw new UsageError(`argument inattendu : ${extra.join(" ")}`);
    if (takesArgument && argument === undefined) {
      throw new UsageError(`\`${command}\` attend un chemin`);
    }
    if (command !== "journal" && (values.limit !== undefined || values.after !== undefined)) {
      throw new UsageError("--limit et --after ne s'appliquent qu'à `journal`");
    }
    rejectOptions(command, values);

    const dataDir = resolveDataDir(ctx, values["data-dir"]);
    let result: CommandResult<unknown>;
    switch (command) {
      case "doctor":
        result = (await doctor(ctx, dataDir)) as CommandResult<unknown>;
        break;
      case "init":
        result = init(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "status":
        result = status(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "journal":
        result = journal(ctx, dataDir, {
          limit:
            parseIntegerOption("limit", values.limit, 1, MAX_JOURNAL_LIMIT) ??
            DEFAULT_JOURNAL_LIMIT,
          afterSequence: parseIntegerOption("after", values.after, 0, Number.MAX_SAFE_INTEGER),
        }) as CommandResult<unknown>;
        break;
      case "policy show":
        result = policyShow(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "pause":
        result = pause(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "resume":
        result = resume(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "stop":
        result = stop(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "policy configure":
        result = policyConfigure(ctx, dataDir, argument ?? "") as CommandResult<unknown>;
        break;
      case "enable":
        result = (await enable(ctx, dataDir, {
          revisionId: values.revision ?? null,
          confirm: values.confirm ?? null,
          interactive: !json,
        })) as CommandResult<unknown>;
        break;
      case "export":
        result = exportCommand(ctx, dataDir, argument ?? "") as CommandResult<unknown>;
        break;
      case "purge":
        result = purge(ctx, dataDir, {
          olderThanDays: parseIntegerOption(
            "older-than-days",
            values["older-than-days"],
            1,
            MAX_RETENTION_DAYS,
          ),
          apply: values.apply === true,
        }) as CommandResult<unknown>;
        break;
      case "uninstall":
        result = (await uninstall(ctx, dataDir, {
          dryRun: values["dry-run"] === true,
          choice:
            values["keep-data"] === true
              ? "keep"
              : values["delete-data"] === true
                ? "delete"
                : null,
          interactive: !json,
        })) as CommandResult<unknown>;
        break;
      default:
        throw new UsageError(`commande inconnue : ${command}`);
    }
    ctx.stdout(renderResult(command, result, json));
    return result.exitCode;
  } catch (error) {
    const usage = error instanceof UsageError || isParseArgsError(error);
    const message = error instanceof Error ? error.message : String(error);
    const rendered = renderError(command, usage ? "usage" : "internal", message, json);
    if (json) ctx.stdout(rendered);
    else ctx.stderr(usage ? `${rendered}\n${USAGE}` : rendered);
    return usage ? EXIT_USAGE : EXIT_FAILURE;
  }
}

const MAX_RETENTION_DAYS = 36_500;

/** Options propres à certaines commandes : ailleurs, refusées plutôt qu'ignorées. */
const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  confirm: ["enable"],
  revision: ["enable"],
  "older-than-days": ["purge"],
  apply: ["purge"],
  "dry-run": ["uninstall"],
  "keep-data": ["uninstall"],
  "delete-data": ["uninstall"],
};

function rejectOptions(command: string, values: Readonly<Record<string, unknown>>): void {
  for (const [option, commands] of Object.entries(COMMAND_OPTIONS)) {
    if (values[option] !== undefined && !commands.includes(command)) {
      throw new UsageError(
        `--${option} ne s'applique qu'à ${commands.map((c) => `\`${c}\``).join(", ")}`,
      );
    }
  }
  if (values["keep-data"] === true && values["delete-data"] === true) {
    throw new UsageError("choisir --keep-data ou --delete-data, pas les deux");
  }
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS")
  );
}
