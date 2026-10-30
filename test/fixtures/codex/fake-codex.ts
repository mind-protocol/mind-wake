/**
 * Faux exécutable `codex` pour les tests de l'adapter : aucune connexion, aucun appel
 * modèle, aucun credential. `--version` affiche une version ; `app-server` rejoue un flux
 * enregistré (fichier JSON désigné par `FAKE_CODEX_FLOW`) en réponse aux requêtes
 * JSON-RPC reçues sur stdin, et journalise les requêtes, arguments et noms de variables
 * d'environnement reçus dans `FAKE_CODEX_LOG` (une ligne JSON par entrée).
 *
 * Exécuté par le type stripping de Node : syntaxe effaçable seulement, modules `node:`.
 *
 * Format d'un flux :
 * { "version": "codex-cli 0.165.0", "extends"?: "common.json",
 *   "on": { "<méthode>": { "result"?: {...}, "error"?: {...}, "noReply"?: true,
 *                          "then"?: [ { "notify" | "request": "<méthode>", "params": {...} }
 *                                   | { "sleepMs": n } | { "exit": code } | { "hang": true } ] } } }
 */

import { appendFileSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

interface FixtureStepsRequest {
  requestId: string;
  projectId: string;
  snapshotRef: string;
}
function readFixtureRequest(folder: string): FixtureStepsRequest {
  const first = readdirSync(folder)[0];
  if (!first) throw new Error("No fixture steps request");
  return JSON.parse(readFileSync(resolve(folder, first), "utf8")) as FixtureStepsRequest;
}

interface Step {
  readonly stepsRepoLaunch?: boolean;
  readonly stepsRepoDecision?: boolean;
  readonly stepsDecision?: boolean;
  readonly notify?: string;
  /** Requête du serveur vers le client (identifiant propre au faux serveur). */
  readonly request?: string;
  readonly params?: unknown;
  readonly sleepMs?: number;
  readonly exit?: number;
  readonly hang?: boolean;
}

interface Handler {
  readonly before?: readonly Step[];
  readonly result?: unknown;
  readonly error?: unknown;
  readonly noReply?: boolean;
  readonly then?: readonly Step[];
}

interface Flow {
  readonly version?: string;
  /** Flux de base (chemin relatif), dont `on` est complété ou remplacé. */
  readonly extends?: string;
  readonly on: Readonly<Record<string, Handler>>;
}

const args = process.argv.slice(2);
const logPath = process.env["FAKE_CODEX_LOG"];

function log(entry: Record<string, unknown>): void {
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function loadFlow(flowPath: string): Flow {
  const flow = JSON.parse(readFileSync(flowPath, "utf8")) as Flow;
  if (flow.extends === undefined) return flow;
  const base = loadFlow(resolve(dirname(flowPath), flow.extends));
  return { ...base, ...flow, on: { ...base.on, ...flow.on } };
}

const flowPath = process.env["FAKE_CODEX_FLOW"];
const flow: Flow = flowPath === undefined ? { on: {} } : loadFlow(flowPath);

if (args.includes("--version")) {
  process.stdout.write(`${flow.version ?? "codex-cli 0.165.0"}\n`);
  process.exit(0);
}

log({ kind: "launch", args, envKeys: Object.keys(process.env).sort() });

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let chain: Promise<void> = Promise.resolve();
let serverRequestId = 1000;

async function play(steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    if (step.stepsRepoLaunch || step.stepsRepoDecision) {
      const folder = resolve(process.cwd(), "artifacts/steps-requests");
      const r = readFixtureRequest(folder);
      const thread = {
        id: "direct_" + "a".repeat(32),
        repo: "C:/fixture",
        runtime: "codex",
        sessionId: "peer",
        transcript: "fixture",
      };
      if (step.stepsRepoLaunch) {
        const question = { target: "codex:peer", context: r.requestId + " " + r.snapshotRef };
        appendFileSync(
          resolve(process.cwd(), "../repo-conversations.jsonl"),
          JSON.stringify({
            thread,
            message: {
              id: "q",
              at: new Date().toISOString(),
              from: "wake",
              text: question.context,
            },
          }) + "\n",
        );
        write({
          method: "item/completed",
          params: {
            threadId: "thr_1",
            turnId: "turn_2",
            item: {
              type: "mcpToolCall",
              id: "send",
              status: "completed",
              tool: "send_repo_request",
              arguments: question,
              result: {
                structuredContent: {
                  thread_id: thread.id,
                  job_id: "job_fixture",
                  status: "queued",
                },
              },
            },
          },
        });
        write({
          method: "item/completed",
          params: {
            threadId: "thr_1",
            turnId: "turn_2",
            item: {
              type: "agentMessage",
              text: JSON.stringify({
                etat: "proposal_pending",
                requestId: r.requestId,
                projectId: r.projectId,
                snapshotRef: r.snapshotRef,
              }),
            },
          },
        });
      } else {
        write({
          method: "item/completed",
          params: {
            threadId: "thr_1",
            turnId: "turn_1",
            item: {
              type: "agentMessage",
              text: JSON.stringify({
                etat: "accepted",
                requestId: r.requestId,
                projectId: r.projectId,
                snapshotRef: r.snapshotRef,
                propositionRef: "answer",
                decisionPrincipale: "Avis relu, contrôle retenu et budget total2 motivé.",
                plan: {
                  version: 1,
                  travail: "Reprise async",
                  statut: "actif",
                  horizonWakes: {
                    nombre: 2,
                    origine: "fixe_agent",
                    source: "Vérifier puis corriger",
                  },
                  etapes: [
                    { id: "async", wake: 1, texte: "Vérifier le retour", statut: "a_faire" },
                  ],
                  prochaineEtape: "async",
                },
              }),
            },
          },
        });
      }
    }
    if (step.stepsDecision) {
      const folder = resolve(process.cwd(), "artifacts/steps-requests");
      const r = readFixtureRequest(folder);
      for (const item of [
        {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          id: "spawn",
          senderThreadId: "thr_1",
          receiverThreadIds: ["child"],
          agentsStates: { child: { status: "running", message: null } },
          status: "completed",
          prompt: r.requestId + " " + r.snapshotRef,
        },
        {
          type: "collabAgentToolCall",
          tool: "wait",
          id: "wait",
          senderThreadId: "thr_1",
          receiverThreadIds: ["child"],
          agentsStates: {
            child: {
              status: "completed",
              message: "2directions. Recommandation : contrôler la reprise en2wakes TOTAL.",
            },
          },
          status: "completed",
        },
        {
          type: "agentMessage",
          text: JSON.stringify({
            etat: "accepted",
            requestId: r.requestId,
            projectId: r.projectId,
            snapshotRef: r.snapshotRef,
            propositionRef: "wait:child",
            decisionPrincipale:
              "Contrôle de reprise retenu ;2wakes TOTAL pour vérifier puis corriger.",
            plan: {
              version: 1,
              travail: "Contrôler la reprise",
              statut: "actif",
              horizonWakes: {
                nombre: 2,
                origine: "fixe_agent",
                source: "un contrôle puis une correction",
              },
              etapes: [
                { id: "e1", wake: 1, texte: "Vérifier la reprise réelle", statut: "a_faire" },
              ],
              prochaineEtape: "e1",
            },
          }),
        },
      ])
        write({ method: "item/completed", params: { threadId: "thr_1", turnId: "turn_2", item } });
    }
    if (step.sleepMs !== undefined) await sleep(step.sleepMs);
    if (step.notify !== undefined) write({ method: step.notify, params: step.params ?? {} });
    if (step.request !== undefined) {
      serverRequestId += 1;
      write({ method: step.request, id: serverRequestId, params: step.params ?? {} });
    }
    if (step.exit !== undefined) process.exit(step.exit);
    if (step.hang === true) await new Promise<void>(() => undefined);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const method = message["method"];
  const id = message["id"];
  if (typeof method !== "string") {
    log({ kind: "reply", message });
    return;
  }
  log({ kind: id === undefined ? "notification" : "request", method, params: message["params"] });
  if (id === undefined) return;
  if (
    method === "turn/start" &&
    flowPath?.includes("steps-stop") &&
    !JSON.stringify(message["params"]).includes("ÉTAPES — coordination")
  ) {
    const f = resolve(process.cwd(), "artifacts/projets-compteur.json");
    const c = JSON.parse(readFileSync(f, "utf8")) as { current: string };
    const text = JSON.stringify(message["params"]);
    if (text.includes("project-action:missing")) unlinkSync(f);
    else {
      c.current =
        text.includes("project-action:stable") || text.includes("project-action:roundtrip")
          ? "A"
          : "B";
      writeFileSync(f, JSON.stringify(c));
    }
  }
  const handler =
    method === "turn/start" && JSON.stringify(message["params"]).includes("ÉTAPES — coordination")
      ? (flow.on["turn/steps"] ?? flow.on[method])
      : flow.on[method];
  chain = chain.then(async () => {
    if (handler?.noReply === true) return;
    if (handler === undefined) {
      write({ id, error: { code: -32601, message: `méthode non rejouée : ${method}` } });
      return;
    }
    if (handler.before !== undefined) await play(handler.before);
    if (handler.error !== undefined) write({ id, error: handler.error });
    else write({ id, result: handler.result ?? {} });
    // Les notifications suivent la réponse, sans bloquer les requêtes suivantes.
    void play(handler.then ?? []);
  });
});
