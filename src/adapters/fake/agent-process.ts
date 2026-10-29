/**
 * Processus agent SIMULÉ lancé par l'adapter factice : exécute un scénario d'étapes,
 * sans aucun appel modèle ni accès réseau. Autonome (modules `node:` seulement) pour
 * être exécutable tel quel, en `.js` compilé ou en `.ts` par le type stripping de Node.
 *
 * Protocole, une ligne JSON par message :
 * - stdout → adapter : `started`, `activity`, `usage`, `action`, `checkpoint`,
 *   `proposal`, `rate_limited`, `error`, `ended` ;
 * - stdin ← adapter : `verdict` (réponse à une action), `checkpoint_request`.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

interface Step {
  readonly do: string;
  readonly [key: string]: unknown;
}

interface Scenario {
  readonly steps: readonly Step[];
  readonly stubborn?: boolean;
  readonly pidFile?: string;
}

const scenario = JSON.parse(
  Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"),
) as Scenario;
const verdicts = new Map<number, (allowed: boolean) => void>();
let checkpointRequested: (() => void) | null = null;
let nextActionId = 1;
/** Artefacts écrits par cette session, joints aux checkpoints `withArtifacts`. */
const artifacts: { id: string; path: string; sha256: string; bytes: number }[] = [];

function emit(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function recordPid(pid: number | undefined): void {
  if (scenario.pidFile !== undefined && pid !== undefined) {
    appendFileSync(scenario.pidFile, `${String(pid)}\n`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: { t?: unknown; id?: unknown; allowed?: unknown };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return;
  }
  if (message.t === "verdict" && typeof message.id === "number") {
    verdicts.get(message.id)?.(message.allowed === true);
    verdicts.delete(message.id);
  } else if (message.t === "checkpoint_request" && scenario.stubborn !== true) {
    checkpointRequested?.();
  }
});
if (scenario.stubborn !== true) {
  process.stdin.on("end", () => process.exit(0));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Descendant détaché qui lance lui-même un petit-enfant détaché, puis attend. */
const DESCENDANT = `
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const file = process.argv[1];
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
if (file) appendFileSync(file, g.pid + "\\n");
g.unref();
setInterval(() => {}, 1000);
`;

function spawnDescendants(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const child = spawn(process.execPath, ["-e", DESCENDANT, scenario.pidFile ?? ""], {
      detached: true,
      stdio: "ignore",
    });
    recordPid(child.pid);
    child.unref();
  }
}

async function requestAction(action: unknown): Promise<boolean> {
  const id = nextActionId;
  nextActionId += 1;
  const verdict = new Promise<boolean>((resolve) => verdicts.set(id, resolve));
  emit({ t: "action", id, action });
  return verdict;
}

async function run(): Promise<void> {
  recordPid(process.pid);
  const pause = new Promise<"checkpoint">((resolve) => {
    checkpointRequested = () => {
      resolve("checkpoint");
    };
  });
  emit({ t: "started" });
  for (const step of scenario.steps) {
    const outcome = await Promise.race([pause, execute(step)]);
    if (outcome === "checkpoint") {
      emit({ t: "checkpoint", summary: "checkpoint demandé : état courant enregistré" });
      emit({ t: "ended", reason: "checkpoint_requested" });
      process.exit(0);
    }
    if (outcome === "stop") return;
  }
}

async function execute(step: Step): Promise<"next" | "stop"> {
  switch (step.do) {
    case "activity":
      emit({ t: "activity", summary: step["summary"] });
      return "next";
    case "usage":
      emit({ t: "usage", tokens: step["tokens"] });
      return "next";
    case "action": {
      const allowed = await requestAction(step["action"]);
      emit({ t: "activity", summary: allowed ? "action effectuée (simulée)" : "action refusée" });
      return "next";
    }
    case "sleep":
      await sleep(Number(step["ms"]));
      return "next";
    case "spawn_descendants":
      spawnDescendants(Number(step["count"]));
      // Laisse aux petits-enfants le temps de démarrer et d'être enregistrés.
      await sleep(300);
      return "next";
    case "checkpoint": {
      const fields: Record<string, unknown> = { ...step };
      delete fields["do"];
      delete fields["withArtifacts"];
      emit({
        t: "checkpoint",
        ...fields,
        ...(step["withArtifacts"] === true ? { artifacts: [...artifacts] } : {}),
      });
      return "next";
    }
    case "propose":
      emit({ t: "proposal", proposal: step["proposal"] });
      return "next";
    case "write_artifact": {
      const allowed = await requestAction({ kind: "file_write", path: step["actionPath"] });
      if (!allowed) {
        emit({ t: "activity", summary: "écriture d'artefact refusée : rien n'est écrit" });
        return "next";
      }
      const content = Buffer.from(String(step["content"]), "utf8");
      const target = join(String(step["root"]), String(step["path"]));
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.agent-tmp`;
      writeFileSync(tmp, content);
      renameSync(tmp, target);
      artifacts.push({
        id: String(step["id"]),
        path: String(step["path"]),
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      });
      emit({ t: "activity", summary: `artefact écrit : ${String(step["path"])}` });
      return "next";
    }
    case "rate_limited":
      emit({ t: "rate_limited", retryAfterMs: step["retryAfterMs"] });
      return "next";
    case "error":
      emit({ t: "error", code: step["code"], message: step["message"] });
      process.exit(1);
      return "stop";
    case "crash":
      process.exit(Number(step["exitCode"]));
      return "stop";
    case "end":
      emit({ t: "ended", reason: step["reason"] });
      process.exit(0);
      return "stop";
    case "idle":
      await new Promise(() => undefined);
      return "stop";
    case "repeat": {
      const steps = step["steps"] as readonly Step[];
      for (let i = 0; i < Number(step["times"]); i += 1) {
        for (const inner of steps) {
          if ((await execute(inner)) === "stop") return "stop";
        }
      }
      return "next";
    }
    default:
      return "next";
  }
}

void run();
