import { parseWakeScreenshotSurface } from "../daemon/wake-screenshot.js";
/**
 * Analyse des arguments et répartition des commandes. Renvoie le code de sortie au lieu
 * de terminer le processus, pour rester testable.
 */

import { parseArgs } from "node:util";
import { daemonRun } from "./commands/daemon.js";
import { changeExecutionMode } from "./commands/execution-mode.js";
import { workspaceSync } from "./commands/workspace-sync.js";
import { wakeOrder } from "./commands/wake-order.js";
import { wakePassages } from "./commands/wake-passages.js";
import { secondThread } from "./commands/second-thread.js";
import { mainThread } from "./commands/main-thread.js";
import { fastReply } from "./commands/fast-reply.js";
import { elevenlabs } from "./commands/elevenlabs.js";
import { patternHolders } from "./commands/pattern-holders.js";
import { forks } from "./commands/forks.js";
import { coach } from "./commands/coach.js";
import { doctor } from "./commands/doctor.js";
import { enable } from "./commands/enable.js";
import { exportCommand } from "./commands/export.js";
import { init } from "./commands/init.js";
import { DEFAULT_JOURNAL_LIMIT, journal, MAX_JOURNAL_LIMIT } from "./commands/journal.js";
import { pause } from "./commands/pause.js";
import { policyConfigure } from "./commands/policy-configure.js";
import { policyShow } from "./commands/policy.js";
import { purge } from "./commands/purge.js";
import { reactivate } from "./commands/reactivate.js";
import { resume } from "./commands/resume.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { wake } from "./commands/wake.js";
import { broadcastTargets, broadcastHuman } from "../communication/broadcast.js";
import { relayAppError } from "../communication/app-error-relay.js";
import { messages, reply, MAX_MESSAGES_LIMIT } from "./commands/messages.js";
import { wakeHistory } from "./commands/wake-history.js";
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
de transaction ou de session guest. Seul \`daemon run\` lance des sessions, au premier
plan, et seulement avec l'adapter factice (--simulated).

Commandes :
  coach status|on|off|send|duo-status|duo-on|duo-off
                Coach : relit le dernier wake et intervient par la messagerie du principal
  forks status|on|off|send|run
                Forks Codex 2 à 8 ; on/off/send lisent un objet JSON {id,text?} sur stdin
  wake-order    Réordonne les blocs futurs (JSON sur l’entrée standard)
  app-error     Relaie au principal une erreur affichée par une app (JSON {app,screen,text,at} sur stdin)
  wake-passages Importe/valide les passages ou prépare un passage (JSON explicite)
  elevenlabs status|enable
                Voix ElevenLabs : état du disjoncteur crédits ; enable réactive
                (action humaine), sans appel de test
  fast-reply status|on|off
                Réponse rapide sans outils à chaque message humain (défaut off),
                injectée ensuite dans la session principale
  pattern-holders status|on|off|check|try
                Accords portés par des conversations-semence qui se réveillent quand
                le fil touche leur domaine (défaut off) ; try --slug S --since ISO
                essaie sans publier
  main-thread status|on|off
                Fil principal On/Off (défaut On) : Off empêche les prochains réveils
                de l'agent principal sans toucher aux forks, au second fil ni à la pause
  second-thread status|on|off|send|run
                Second fil Claude Code (défaut off) : fil séparé, autre ordre de projets ;
                send lit le message sur l’entrée standard
  doctor        Diagnostic local, sans appel modèle ni accès réseau
  init          Prépare un profil désactivé, sans budget ni permission
  always-on     Enchaîne les réveils dès la fin de chaque réponse
  on            Revient aux réveils planifiés
  status        État, expérience active, budget, prochain réveil
  journal       Derniers événements (--limit N, --after SÉQUENCE)
  policy show   Révision de policy active, consentement et révocations
  pause         Plus aucun réveil ; la session en cours s'arrête après checkpoint
  resume        Lève une pause (refusée après un arrêt d'urgence)
  stop          Arrêt d'urgence : verrouille le profil, termine les processus
  reactivate    Lève un arrêt d'urgence (action de l'humain), policy revérifiée
  wake          Demande un réveil au plus tôt ; n'accorde rien (fenêtres, priorité,
                budgets revérifiés), refusé en pause, arrêt ou blocage
  messages      Fil avec ton agent : sa note artifacts/questions-for-human.md et tes réponses
                --limit N : seulement les N éléments les plus récents du fil (desktop)
  reply         Répond à ton agent : texte lu sur l'entrée standard
                (--idempotency-key K) ; ne le réveille pas, n'accorde rien
                --capture-screen joint une capture ponctuelle de l’écran principal
                (profil natif Codex/Claude), sans modifier la collecte ambiante
  policy configure FICHIER.json
                Propose une révision validée, sans effet avant \`enable\`
  enable        Active la révision proposée, sans code à saisir (ADR-008) ; --confirm
                CODE reste vérifié s'il est passé (--revision ID). Refusé tant que
                l'isolation et l'adapter ne sont pas livrés
  export CHEMIN Copie cohérente et expurgée de l'état et des artefacts, avec manifeste
  purge         Plan de purge du journal expiré (--older-than-days N) ; --apply l'applique
  uninstall     --dry-run liste les effets ; --keep-data ou --delete-data, sinon
                question dans le terminal
  daemon run --simulated
                Daemon au premier plan (Ctrl+C pour l'arrêter) avec l'adapter factice :
                tout est marqué SIMULÉ, aucun appel modèle. Sans --simulated : refus,
                aucun adapter réel n'existe dans ce build. Options : --wake-screenshot primary|wake-window|off, --recheck-ms N,
                --exit-after-sessions N

Réservé à l'humain : le choix de \`uninstall\`. Ni la skill ni l'espace d'exploration
ne doivent l'utiliser.

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
        simulated: { type: "boolean" },
        "recheck-ms": { type: "string" },
        "wake-screenshot": { type: "string" },
        "exit-after-sessions": { type: "string" },
        "idempotency-key": { type: "string" },
        "message-id": { type: "string" },
        slug: { type: "string" },
        since: { type: "string" },
        "capture-screen": { type: "boolean" },
        "voice-screen-refs": { type: "string" },
        workspace: { type: "string" },
        "github-url": { type: "string" },
        enabled: { type: "string" },
      },
    });
    const [first, second, ...rest] = positionals;
    const grouped = (first === "policy" || first === "daemon" || first === "workspace-sync" || first === "second-thread" || first === "main-thread" || first === "fast-reply" || first === "elevenlabs" || first === "pattern-holders" || first === "forks" || first === "coach") && second !== undefined;
    command = grouped ? `${first} ${second}` : (first ?? "help");
    const args = grouped ? rest : positionals.slice(1);
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
    if (values.after !== undefined && command !== "journal") {
      throw new UsageError("--after ne s'applique qu'à `journal`");
    }
    if (values.limit !== undefined && command !== "journal" && command !== "messages") {
      throw new UsageError("--limit ne s'applique qu'à `journal` et `messages`");
    }
    rejectOptions(command, values);

    const dataDir = resolveDataDir(ctx, values["data-dir"]);
    let result: CommandResult<unknown>;
    switch (command) {
      case "coach duo-status":
      case "coach duo-on":
      case "coach duo-off":
      case "coach status":
      case "coach on":
      case "coach off":
      case "coach send":
        result = await coach(ctx, dataDir, second ?? "status");
        break;
      case "forks status":
      case "forks on":
      case "forks off":
      case "forks send":
      case "forks run":
      case "forks assign":
      case "forks unassign":
        result = await forks(ctx, dataDir, second ?? "status");
        break;
      case "elevenlabs status":
      case "elevenlabs enable":
        result = elevenlabs(dataDir, second);
        break;
      case "fast-reply status":
      case "fast-reply on":
      case "fast-reply off":
      case "fast-reply run":
        result = await fastReply(ctx, dataDir, second, values["message-id"]);
        break;
      case "pattern-holders status":
      case "pattern-holders on":
      case "pattern-holders off":
      case "pattern-holders check":
      case "pattern-holders try":
        result = await patternHolders(ctx, dataDir, second, values.slug, values.since);
        break;
      case "main-thread status":
      case "main-thread on":
      case "main-thread off":
        result = mainThread(ctx, dataDir, second) as CommandResult<unknown>;
        break;
      case "second-thread status":
      case "second-thread on":
      case "second-thread off":
      case "second-thread send":
      case "second-thread run":
        result = await secondThread(ctx, dataDir, second);
        break;
      case "wake-order":
        result = await wakeOrder(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "wake-passages":
        result = await wakePassages(ctx, dataDir);
        break;
      case "workspace-sync status":
      case "workspace-sync configure":
      case "workspace-sync now":
        result=await workspaceSync(ctx,dataDir,second??"status",{
          ...(values.workspace===undefined?{}:{workspaceDir:values.workspace}),
          ...(values["github-url"]===undefined?{}:{githubUrl:values["github-url"]}),
          ...(values.enabled===undefined?{}:{enabled:values.enabled}),
        }) as CommandResult<unknown>;
        break;
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
      case "reactivate":
        result = reactivate(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "always-on":
        result = changeExecutionMode(ctx, dataDir, "always-on") as CommandResult<unknown>;
        break;
      case "on":
        result = changeExecutionMode(ctx, dataDir, "on") as CommandResult<unknown>;
        break;
      case "wake":
        result = wake(ctx, dataDir) as CommandResult<unknown>;
        break;
      case "messages":
        result = messages(ctx, dataDir, parseIntegerOption("limit", values.limit, 1, MAX_MESSAGES_LIMIT)) as CommandResult<unknown>;
        break;
      case "wake-history":
        result = wakeHistory(dataDir) as CommandResult<unknown>;
        break;
      case "app-error": {
        // Erreur affichée par l'app desktop : JSON {app,screen,text,at} sur stdin → file du Réparateur.
        const raw = (await ctx.readStdin?.()) ?? "";
        let input: unknown;
        try { input = JSON.parse(raw); } catch { throw new UsageError("app-error attend un objet JSON sur stdin"); }
        const sent = relayAppError(dataDir.path, input);
        result = { exitCode: EXIT_OK, data: { id: sent.id, app: sent.report.app, screen: sent.report.screen }, human: () => "Incident enregistré pour Réparateur." };
        break;
      }
      case "broadcast-status":
        result = {exitCode:EXIT_OK,data:{recipients:broadcastTargets(dataDir.path),scope:'Principal + rôles keeper actifs ; jobs CLI sans canal signalés. Forks 2-8 exclus. Sous-agents natifs non exposés.'},human:d=>JSON.stringify(d)};
        break;
      case "broadcast-send": {
        const text=await ctx.readStdin?.() ?? '';
        const key=values["idempotency-key"] ?? '';
        const receipt=await broadcastHuman(dataDir.path,key,text,async()=>{
          const sent=await reply({...ctx,readStdin:async()=>text},dataDir,key,false,undefined,true);
          if(sent.exitCode!==EXIT_OK)throw Error(JSON.stringify(sent.data));
        });
        result={exitCode:EXIT_OK,data:receipt,human:d=>JSON.stringify(d)};
        break;
      }
      case "reply":
        result = (await reply(ctx, dataDir, values["idempotency-key"], values["capture-screen"] === true,
          undefined, false, values["voice-screen-refs"])) as CommandResult<unknown>;
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
      case "daemon run":
        result = (await daemonRun(ctx, dataDir, {
          simulated: values.simulated === true,
          recheckMs: parseIntegerOption("recheck-ms", values["recheck-ms"], 1_000, 3_600_000),
          exitAfterSessions: parseIntegerOption(
            "exit-after-sessions",
            values["exit-after-sessions"],
            1,
            1_000,
          ),
          quiet: json,
          ...(values["wake-screenshot"] === undefined
            ? {}
            : { wakeScreenshot: parseWakeScreenshotSurface(values["wake-screenshot"])! }),
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
  workspace:["workspace-sync configure"],
  "github-url":["workspace-sync configure"],
  enabled:["workspace-sync configure"],
  confirm: ["enable"],
  revision: ["enable"],
  "older-than-days": ["purge"],
  apply: ["purge"],
  "dry-run": ["uninstall"],
  "keep-data": ["uninstall"],
  "delete-data": ["uninstall"],
  simulated: ["daemon run"],
  "recheck-ms": ["daemon run"],
  "wake-screenshot": ["daemon run"],
  "exit-after-sessions": ["daemon run"],
  "idempotency-key": ["reply", "broadcast-send"],
  "message-id": ["fast-reply run"],
  slug: ["pattern-holders try"],
  since: ["pattern-holders try"],
  "capture-screen": ["reply"],
  "voice-screen-refs": ["reply"],
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
