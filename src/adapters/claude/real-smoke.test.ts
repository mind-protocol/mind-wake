/**
 * Test de fumée RÉEL, opt-in : consomme le quota d'abonnement de l'utilisateur. Désactivé
 * dans `npm test` ; activé seulement par `MIND_WAKE_REAL_SMOKE=1`, sur feu vert humain.
 *
 * - Client officiel `claude -p` en stream-json, connexion déjà configurée par l'utilisateur
 *   (configuration par défaut du CLI) : aucun credential n'est lu, copié ni journalisé ;
 *   l'environnement transmis ne contient aucun nom de secret.
 * - Poste hôte, mode supervisé : jamais `--dangerously-skip-permissions`, aucun outil,
 *   dossier de travail temporaire, modèle Opus.
 * - Trois appels au plus : session neuve (`--session-id`), reprise (`--resume`), jauge
 *   (`/usage`, sans requête au modèle). Arrêt à la première erreur ou limitation.
 *
 * Sorties dans `MIND_WAKE_REAL_SMOKE_OUT` (défaut : dossier temporaire) : flux expurgé
 * (`stream.jsonl`) et bilan (`report.json`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChildClaude } from "../../../test/fixtures/claude/child-process.js";
import type {
  AdapterEvent,
  ReservationId,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import {
  ClaudeAdapter,
  claudeSessionUuid,
  MemoryConversationStore,
  type ClaudeLauncher,
} from "./index.js";

const ENABLED = process.env["MIND_WAKE_REAL_SMOKE"] === "1";

/** Variables système nécessaires au CLI sur l'hôte ; aucune variable au nom de secret. */
const HOST_ENV_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
] as const;

function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Remplace chemins personnels et adresses par des marqueurs, y compris échappés en JSON. */
function redactor(paths: Readonly<Record<string, string>>): (line: string) => string {
  const pairs: [string, string][] = [];
  for (const [marker, value] of Object.entries(paths)) {
    for (const variant of [value, value.replaceAll("\\", "/")]) {
      pairs.push([variant, marker], [JSON.stringify(variant).slice(1, -1), marker]);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (line) => {
    let out = line;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    out = out.split(os.userInfo().username).join("<USER>");
    return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<EMAIL>");
  };
}

/** Le texte de `/usage` décrit l'activité du poste : il ne va pas dans la fixture. */
function fixtureMessage(line: string): unknown {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (message["usage_report"] === undefined) return message;
  const inner = message["message"] as { content?: { type?: string; text?: string }[] } | undefined;
  for (const block of inner?.content ?? []) {
    if (block.type === "text") block.text = "<texte /usage expurgé>";
  }
  return message;
}

function request(sessionId: string, context: string): StartRequest {
  return {
    sessionId: sessionId as SessionId,
    reservationId: "smoke" as ReservationId,
    policy: {} as StartRequest["policy"],
    context,
    maxInputTokens: 1_000,
    deadline: new Date(Date.now() + 180_000).toISOString() as UtcTimestamp,
  };
}

type Json = Record<string, unknown>;

describe.skipIf(!ENABLED)("adapter Claude Code : fumée réelle (opt-in)", () => {
  it("session neuve, reprise et jauge avec le client officiel", async () => {
    const executable =
      process.env["MIND_WAKE_CLAUDE_EXE"] ?? path.join(os.homedir(), ".local", "bin", "claude.exe");
    const out =
      process.env["MIND_WAKE_REAL_SMOKE_OUT"] ??
      fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-real-smoke-out-"));
    fs.mkdirSync(out, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-real-smoke-"));
    const promptDir = path.join(workspace, ".prompts");
    const redact = redactor({
      "<WORKSPACE>": fs.realpathSync(workspace),
      "<WORKSPACE_RAW>": workspace,
      "<HOME>": os.homedir(),
      "<TMP>": os.tmpdir(),
    });

    const raw: { call: number; line: string }[] = [];
    const argvs: string[][] = [];
    let call = 0;
    const launcher: ClaudeLauncher = {
      isolation: () => ({ kind: "host_job", detail: "fumée réelle, poste hôte" }),
      launch: (spec) => {
        call += 1;
        const current = call;
        if (current > 3) throw new Error("plus de trois appels refusés");
        argvs.push([...spec.args]);
        return new ChildClaude(spec, hostEnv(), (line) => raw.push({ call: current, line }));
      },
    };
    const key = `smoke-${String(Date.now())}`;
    const adapter = new ClaudeAdapter({
      launcher,
      autonomy: "supervised",
      executable,
      promptDir,
      systemPrompt: "Réponds en un seul mot, en minuscules, sans ponctuation.",
      workspaceFor: () => workspace,
      conversationKeyFor: () => key,
      conversations: new MemoryConversationStore(),
      model: "opus",
      tools: [],
    });

    const report: Json = {
      probe: await adapter.probe(),
      claudeSessionId: claudeSessionUuid(key, 0),
      calls: [] as Json[],
    };
    const calls = report["calls"] as Json[];
    const runOnce = async (sessionId: string, context: string): Promise<AdapterEvent[]> => {
      const handle = await adapter.start(request(sessionId, context));
      const events: AdapterEvent[] = [];
      for await (const event of adapter.events(handle)) events.push(event);
      calls.push({
        argv: (argvs.at(-1) ?? []).map(redact),
        events: events.map((e) => ({ ...e, at: undefined })),
        reconcile: await adapter.reconcile(handle.sessionId),
      });
      return events;
    };
    const blocking = (events: readonly AdapterEvent[]): AdapterEvent | undefined =>
      events.find((e) => e.type === "error" || e.type === "rate_limited");

    try {
      const first = await runOnce("smoke-1", "Choisis une couleur.");
      let stop = blocking(first);
      if (stop === undefined) {
        const second = await runOnce("smoke-2", "Quelle couleur as-tu choisie juste avant ?");
        stop = blocking(second);
      }
      if (stop === undefined) report["quota"] = await adapter.readQuota(60_000);
      report["stoppedOn"] = stop ?? null;

      // Vérification de continuité : le texte des réponses n'est lu qu'ici, pour comparer.
      const answers = [1, 2].map((n) =>
        raw
          .filter((r) => r.call === n)
          .map((r) => JSON.parse(r.line) as Json)
          .filter((m) => m["type"] === "result")
          .map((m) => (typeof m["result"] === "string" ? m["result"] : ""))
          .join(""),
      );
      report["answers"] = answers;
      report["results"] = raw
        .map((r) => ({ call: r.call, message: JSON.parse(r.line) as Json }))
        .filter((r) => r.message["type"] === "result" || r.message["type"] === "rate_limit_event")
        .map((r) => JSON.parse(redact(JSON.stringify(r))) as unknown);
    } finally {
      fs.writeFileSync(
        path.join(out, "stream.jsonl"),
        raw
          .map((r) => redact(JSON.stringify({ call: r.call, message: fixtureMessage(r.line) })))
          .join("\n") + "\n",
      );
      fs.writeFileSync(path.join(out, "report.json"), redact(JSON.stringify(report, null, 2)));
      fs.rmSync(workspace, { recursive: true, force: true });
    }

    expect(report["stoppedOn"]).toBeNull();
    expect(argvs[0]).toContain("--session-id");
    expect(argvs[1]).toContain("--resume");
    expect(argvs.flat()).not.toContain("--dangerously-skip-permissions");
    const answers = report["answers"] as string[];
    expect(answers[0]?.length).toBeGreaterThan(0);
    expect(answers[1]?.toLowerCase()).toContain(answers[0]?.toLowerCase().trim());
  }, 600_000);
});
