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

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

interface Step {
  readonly notify?: string;
  /** Requête du serveur vers le client (identifiant propre au faux serveur). */
  readonly request?: string;
  readonly params?: unknown;
  readonly sleepMs?: number;
  readonly exit?: number;
  readonly hang?: boolean;
}

interface Handler {
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
  const handler = flow.on[method];
  chain = chain.then(() => {
    if (handler?.noReply === true) return;
    if (handler === undefined) {
      write({ id, error: { code: -32601, message: `méthode non rejouée : ${method}` } });
      return;
    }
    if (handler.error !== undefined) write({ id, error: handler.error });
    else write({ id, result: handler.result ?? {} });
    // Les notifications suivent la réponse, sans bloquer les requêtes suivantes.
    void play(handler.then ?? []);
  });
});
