/**
 * Analyse des arguments et répartition des commandes. Renvoie le code de sortie au lieu
 * de terminer le processus, pour rester testable.
 */

import { parseArgs } from "node:util";
import { doctor } from "./commands/doctor.js";
import { init } from "./commands/init.js";
import { DEFAULT_JOURNAL_LIMIT, journal, MAX_JOURNAL_LIMIT } from "./commands/journal.js";
import { pause } from "./commands/pause.js";
import { policyShow } from "./commands/policy.js";
import { resume } from "./commands/resume.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
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
de transaction ou de session guest ; aucune commande n'active l'exploration.

Commandes :
  doctor        Diagnostic local, sans appel modèle ni accès réseau
  init          Prépare un profil désactivé, sans budget ni permission
  status        État, expérience active, budget, prochain réveil
  journal       Derniers événements (--limit N, --after SÉQUENCE)
  policy show   Révision de policy active, consentement et révocations
  pause         Plus aucun réveil ; la session en cours s'arrête après checkpoint
  resume        Lève une pause (refusée après un arrêt d'urgence)
  stop          Arrêt d'urgence : verrouille le profil, termine les processus

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
      },
    });
    const [first, second, ...rest] = positionals;
    command = first === "policy" && second !== undefined ? `policy ${second}` : (first ?? "help");
    const extra = first === "policy" ? rest : positionals.slice(1);

    if (values.help === true || command === "help") {
      ctx.stdout(USAGE);
      return first === undefined && values.help !== true ? EXIT_USAGE : EXIT_OK;
    }
    if (extra.length > 0) throw new UsageError(`argument inattendu : ${extra.join(" ")}`);
    if (command !== "journal" && (values.limit !== undefined || values.after !== undefined)) {
      throw new UsageError("--limit et --after ne s'appliquent qu'à `journal`");
    }

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

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS")
  );
}
