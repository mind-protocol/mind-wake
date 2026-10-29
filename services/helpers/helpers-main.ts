/**
 * Aide des sessions Claude Code / Codex de l'humain à son agent Wake (opt-in).
 *
 *   node --experimental-transform-types --import ./test/fixtures/store-ledger/ts-hooks.ts \
 *     services/helpers/helpers-main.ts <commande> [--json]
 *
 * Commandes :
 *   allow <dossier>     autorise les sessions dont le dossier de travail est dessous
 *   deny <dossier>      retire une autorisation
 *   candidates          dossiers où l'humain a des sessions (rien n'est autorisé par là)
 *   list                sessions autorisées et leurs mots-clés
 *   match <texte>       session la plus proche d'un texte, sans réveil
 *   run-once            traite les nouveaux messages de l'agent (un réveil chacun au plus)
 *   watch               run-once toutes les 20 s, jusqu'à Ctrl+C
 *   answers             réponses déjà rangées
 *
 * Dossier de l'agent : MIND_WAKE_DATA_DIR (sinon %LOCALAPPDATA%\mind-wake), lu seulement,
 * sauf la note d'aide qu'il lit. État de l'aide : MIND_WAKE_HELPERS_DIR (sinon
 * %LOCALAPPDATA%\mind-wake-helpers).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Matchable,
  describeSessions,
  excludedRoots,
  rank,
  readAnswers,
  readConfig,
  runOnce,
  writeConfig,
} from "./engine.js";
import { refreshIndex } from "./session-index.js";
import { isUnder, normalizeDir, parseClaude } from "./sessions.js";
import { officialWaker } from "./wake.js";

const SCHEMA = "mind.helpers.cli";
/** Vérification des nouveaux messages de l'agent (lecture SQLite, quasi gratuite). */
const WATCH_MS = 3_000;
/** Rafraîchissement incrémental de l'index en arrière-plan. */
const INDEX_EVERY_MS = 60_000;

/** État de l'aide, hors du dossier de l'agent : MIND_WAKE_HELPERS_DIR, sinon %LOCALAPPDATA%\mind-wake-helpers. */
function stateDir(): string {
  const env = process.env["MIND_WAKE_HELPERS_DIR"];
  const dir =
    env !== undefined && env !== ""
      ? path.resolve(env)
      : path.join(
          process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local"),
          "mind-wake-helpers",
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dataDir(): string {
  const env = process.env["MIND_WAKE_DATA_DIR"];
  if (env !== undefined && env !== "") return path.resolve(env);
  return path.join(
    process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local"),
    "mind-wake",
  );
}

function out(json: boolean, command: string, ok: boolean, data: unknown, human: string): void {
  process.stdout.write(
    json
      ? `${JSON.stringify({ schema: SCHEMA, schemaVersion: 1, command, ok, data }, null, 2)}\n`
      : `${human}\n`,
  );
}

/** Dossiers de travail où l'humain a des sessions, comptés (lecture des seules métadonnées). */
function candidates(dir: string): { cwd: string; sessions: number; runtimes: string[] }[] {
  const counts = new Map<string, { cwd: string; sessions: number; runtimes: Set<string> }>();
  const add = (cwd: string, runtime: string): void => {
    if (excludedRoots(dir).some((r) => isUnder(cwd, r))) return;
    const key = normalizeDir(cwd);
    const entry = counts.get(key) ?? { cwd, sessions: 0, runtimes: new Set<string>() };
    entry.sessions += 1;
    entry.runtimes.add(runtime);
    counts.set(key, entry);
  };
  const claudeRoot = path.join(os.homedir(), ".claude", "projects");
  for (const project of safeDir(claudeRoot)) {
    for (const file of safeDir(path.join(claudeRoot, project)).filter((f) =>
      f.endsWith(".jsonl"),
    )) {
      const head = firstBytes(path.join(claudeRoot, project, file));
      const doc = parseClaude(file, head);
      if (doc !== null) add(doc.cwd, "claude");
    }
  }
  const codexRoot = path.join(os.homedir(), ".codex", "sessions");
  for (const file of walkFiles(codexRoot, 3)) {
    const meta = firstBytes(file).split("\n")[0] ?? "";
    try {
      const o = JSON.parse(meta) as { type?: string; payload?: { cwd?: string } };
      if (o.type === "session_meta" && typeof o.payload?.cwd === "string")
        add(o.payload.cwd, "codex");
    } catch {
      // Ligne de métadonnées absente ou tronquée : session ignorée.
    }
  }
  return [...counts.values()]
    .map((c) => ({ cwd: c.cwd, sessions: c.sessions, runtimes: [...c.runtimes] }))
    .sort((a, b) => b.sessions - a.sessions);
}

function safeDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function walkFiles(dir: string, depth: number): string[] {
  const files: string[] = [];
  for (const name of safeDir(dir)) {
    const full = path.join(dir, name);
    let isDir: boolean;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir && depth > 0) files.push(...walkFiles(full, depth - 1));
    else if (name.endsWith(".jsonl")) files.push(full);
  }
  return files;
}

function firstBytes(file: string, n = 64_000): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(n);
      const read = fs.readSync(fd, buffer, 0, n, 0);
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const [command = "help", ...rest] = args;
  const dir = dataDir();
  if (!fs.existsSync(dir)) {
    out(json, command, false, { dataDir: dir }, `Dossier de l'agent introuvable : ${dir}`);
    return 1;
  }
  const state = stateDir();
  const config = readConfig(state);

  switch (command) {
    case "allow":
    case "deny": {
      const target = rest.join(" ").trim();
      if (target === "") {
        out(json, command, false, null, `Usage : ${command} <dossier>`);
        return 2;
      }
      const resolved = path.resolve(target);
      if (
        command === "allow" &&
        excludedRoots(dir).some((r) => isUnder(resolved, r) || isUnder(r, resolved))
      ) {
        out(
          json,
          command,
          false,
          { root: resolved },
          "Refusé : ce dossier contient ou recouvre les données de l'agent Wake.",
        );
        return 1;
      }
      const roots = config.roots.filter((r) => normalizeDir(r) !== normalizeDir(resolved));
      if (command === "allow") roots.push(resolved);
      writeConfig(state, { roots });
      out(
        json,
        command,
        true,
        { roots },
        `Dossiers autorisés :\n${roots.map((r) => `  ${r}`).join("\n") || "  (aucun)"}`,
      );
      return 0;
    }
    case "candidates": {
      const list = candidates(dir);
      out(
        json,
        command,
        true,
        { candidates: list, allowed: config.roots },
        list
          .slice(0, 40)
          .map(
            (c) => `${String(c.sessions).padStart(4)}  ${c.runtimes.join("+").padEnd(12)} ${c.cwd}`,
          )
          .join("\n") || "Aucune session trouvée.",
      );
      return 0;
    }
    case "list": {
      const { sessions } = await refreshIndex(state, {
        roots: config.roots,
        excluded: excludedRoots(dir),
      });
      const described = describeSessions(sessions);
      out(
        json,
        command,
        true,
        {
          allowed: config.roots,
          sessions: described.map(({ session, keywords }) => ({
            runtime: session.runtime,
            sessionId: session.sessionId,
            cwd: session.cwd,
            updatedAt: session.updatedAt,
            keywords,
          })),
        },
        config.roots.length === 0
          ? "Aucun dossier autorisé : rien n'est lu. Utiliser `allow <dossier>`."
          : described
              .map(
                ({ session, keywords }) =>
                  `${session.runtime} ${session.sessionId} ${session.cwd}\n    ${keywords.join(", ")}`,
              )
              .join("\n") || "Aucune session dans les dossiers autorisés.",
      );
      return 0;
    }
    case "match": {
      const text = rest.join(" ");
      const { sessions } = await refreshIndex(state, {
        roots: config.roots,
        excluded: excludedRoots(dir),
      });
      const ranked = rank(text, sessions).slice(0, 5);
      out(
        json,
        command,
        true,
        {
          matches: ranked.map((c) => ({
            runtime: c.session.runtime,
            sessionId: c.session.sessionId,
            cwd: c.session.cwd,
            score: c.score,
            shared: c.shared,
          })),
        },
        ranked
          .map(
            (c) =>
              `${c.score.toFixed(3)}  ${c.session.runtime} ${c.session.sessionId}  ${c.session.cwd}\n    ${c.shared.join(", ")}`,
          )
          .join("\n") || "Aucune session proche.",
      );
      return 0;
    }
    case "run-once": {
      const result = await runOnce(dir, state, officialWaker);
      out(
        json,
        command,
        true,
        result,
        result.handled
          .map(
            (h) =>
              `${h.messageId} v${String(h.version)} : ${h.outcome} ${h.session ?? ""} ${h.detail}`,
          )
          .join("\n") || "Aucun nouveau message de l'agent.",
      );
      return 0;
    }
    case "watch": {
      const control = { stop: false };
      process.on("SIGINT", () => {
        control.stop = true;
      });
      out(
        json,
        command,
        true,
        { dataDir: dir, everyMs: WATCH_MS },
        `Surveillance des messages de l'agent (${dir}). Index des sessions en arrière-plan. Ctrl+C pour arrêter.`,
      );
      const log = (line: string): void => {
        process.stdout.write(`${new Date().toISOString()} ${line}
`);
      };
      // Index tenu à jour en arrière-plan, jamais attendu par l'appariement.
      const index: { sessions: Matchable[] | null; running: boolean } = {
        sessions: null,
        running: false,
      };
      const refresh = (): void => {
        if (index.running) return;
        index.running = true;
        const roots = readConfig(state).roots;
        const started = Date.now();
        refreshIndex(state, { roots, excluded: excludedRoots(dir) })
          .then(({ sessions, reread }) => {
            const first = index.sessions === null;
            index.sessions = sessions;
            if (first || reread > 0) {
              log(
                `index : ${String(sessions.length)} sessions, ${String(reread)} relues en ${String(Date.now() - started)} ms`,
              );
            }
          })
          .catch((error: unknown) => {
            log(`index : échec ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            index.running = false;
          });
      };
      refresh();
      const timer = setInterval(refresh, INDEX_EVERY_MS);
      while (!control.stop) {
        // Tant que le premier index n'est pas prêt, les messages attendent (rien n'est perdu).
        if (index.sessions !== null) {
          // Sans attendre : les réveils tournent pendant que la surveillance continue.
          runOnce(dir, state, officialWaker, { sessions: index.sessions })
            .then((result) => {
              for (const h of result.handled) {
                log(
                  `${h.messageId} v${String(h.version)} : ${h.outcome} ${h.session ?? ""} ${h.detail}`,
                );
              }
            })
            .catch((error: unknown) => {
              log(`réveil : échec ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        await new Promise((r) => setTimeout(r, WATCH_MS));
      }
      clearInterval(timer);
      return 0;
    }
    case "answers": {
      const answers = readAnswers(state);
      out(
        json,
        command,
        true,
        { answers },
        answers
          .map((a) => `${a.at} ${a.runtime} ${a.cwd} (pour ${a.forMessageId})\n${a.text}\n`)
          .join("\n") || "Aucune réponse.",
      );
      return 0;
    }
    default:
      out(
        json,
        command,
        false,
        null,
        "Commandes : allow, deny, candidates, list, match, run-once, watch, answers",
      );
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
