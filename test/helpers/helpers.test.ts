/**
 * Aide des sessions : mots-clés, lecture des transcriptions Claude Code / Codex, choix
 * de la session, un réveil par message de l'agent (réveil simulé), opt-in strict.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_COPY,
  fromDoc,
  ANSWERS_FILE,
  rank,
  readAnswers,
  runOnce,
  writeConfig,
} from "../../services/helpers/engine.js";
import { tokens } from "../../services/helpers/keywords.js";
import {
  discoverSessions,
  parseClaude,
  parseCodex,
  type SessionDoc,
} from "../../services/helpers/sessions.js";
import type { Waker } from "../../services/helpers/wake.js";
import { OwnerMessages } from "../../src/communication/owner-messages.js";

let dir: string;
let state: string;
let home: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "helpers-data-"));
  state = fs.mkdtempSync(path.join(os.tmpdir(), "helpers-state-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "helpers-home-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function session(
  runtime: SessionDoc["runtime"],
  id: string,
  cwd: string,
  text: string,
): SessionDoc {
  return {
    runtime,
    sessionId: id,
    cwd,
    file: `${id}.jsonl`,
    updatedAt: "2026-10-29T10:00:00Z",
    text,
  };
}

const garden = fromDoc(
  session(
    "claude",
    "s-garden",
    "C:\\projets\\jardin",
    "Le jardin génératif pousse avec une règle de croissance réagissant au vent. Plantes, croissance, vent, branches L-système.",
  ),
);
const solana = fromDoc(
  session(
    "codex",
    "s-solana",
    "C:\\projets\\rail",
    "Rail Solana devnet : transactions, wallet, frais, token-2022, mémo, signature.",
  ),
);

describe("mots-clés et choix de session", () => {
  it("jetons normalisés sans accents ni mots vides", () => {
    expect(tokens("Le Jardin génératif, avec la croissance !")).toEqual([
      "jardin",
      "generatif",
      "croissance",
    ]);
  });

  it("la session la plus proche du message gagne, avec ses termes communs", () => {
    const ranked = rank("Comment faire bouger les plantes du jardin avec le vent ?", [
      solana,
      garden,
    ]);
    expect(ranked[0]?.session.sessionId).toBe("s-garden");
    expect(ranked[0]?.shared).toEqual(expect.arrayContaining(["jardin", "vent"]));
  });
});

describe("lecture des transcriptions", () => {
  it("Claude Code : tours humain / assistant, méta et sous-agents écartés", () => {
    const raw = [
      {
        type: "user",
        cwd: "C:\\p",
        sessionId: "c1",
        message: { role: "user", content: "Question sur le jardin" },
      },
      {
        type: "user",
        cwd: "C:\\p",
        sessionId: "c1",
        isMeta: true,
        message: { content: "méta ignorée" },
      },
      {
        type: "assistant",
        cwd: "C:\\p",
        sessionId: "c1",
        message: {
          content: [
            { type: "text", text: "Réponse croissance" },
            { type: "tool_use", name: "Bash" },
          ],
        },
      },
      {
        type: "assistant",
        cwd: "C:\\p",
        sessionId: "c1",
        isSidechain: true,
        message: { content: "sous-agent ignoré" },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(parseClaude("f", raw)).toMatchObject({
      runtime: "claude",
      sessionId: "c1",
      cwd: "C:\\p",
      text: "Question sur le jardin\nRéponse croissance",
    });
  });

  it("Codex : métadonnées de session et messages, instructions injectées écartées", () => {
    const raw = [
      { type: "session_meta", payload: { id: "x1", cwd: "C:\\q" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>…" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Le rail Solana" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Frais devnet" }],
        },
      },
      { type: "response_item", payload: { type: "function_call", name: "shell" } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(parseCodex("f", raw)).toMatchObject({
      runtime: "codex",
      sessionId: "x1",
      cwd: "C:\\q",
      text: "Le rail Solana\nFrais devnet",
    });
  });

  it("opt-in : sans racine autorisée, rien n'est lu ; dossiers exclus jamais lus", () => {
    const projects = path.join(home, "claude");
    fs.mkdirSync(path.join(projects, "p"), { recursive: true });
    const line = (cwd: string): string =>
      JSON.stringify({ type: "user", cwd, sessionId: "c9", message: { content: "jardin vent" } });
    fs.writeFileSync(path.join(projects, "p", "a.jsonl"), line("C:\\autorise\\projet"));
    fs.writeFileSync(
      path.join(projects, "p", "b.jsonl"),
      line("C:\\donnees\\mind-wake-essai\\workspace"),
    );
    const base = {
      excluded: ["C:\\donnees\\mind-wake-essai"],
      claudeDir: projects,
      codexDir: path.join(home, "none"),
    };
    expect(discoverSessions({ ...base, roots: [] })).toEqual([]);
    expect(discoverSessions({ ...base, roots: ["C:\\autorise"] }).map((s) => s.cwd)).toEqual([
      "C:\\autorise\\projet",
    ]);
    expect(discoverSessions({ ...base, roots: ["C:\\"] }).map((s) => s.cwd)).toEqual([
      "C:\\autorise\\projet",
    ]);
  });
});

describe("un réveil par message de l'agent", () => {
  function publish(text: string, key: string): void {
    const store = new OwnerMessages(dir, "agent");
    try {
      store.publish(text, key);
    } finally {
      store.close();
    }
  }

  function fakeWaker(answer: string): { waker: Waker; calls: { id: string; prompt: string }[] } {
    const calls: { id: string; prompt: string }[] = [];
    return {
      calls,
      waker: (s, prompt) => {
        calls.push({ id: s.sessionId, prompt });
        return Promise.resolve({ ok: true, text: answer, detail: "simulé" });
      },
    };
  }

  it("premier lancement : l'historique existant n'est pas rejoué", async () => {
    publish("Ancien message sur le jardin et le vent", "old-0001");
    writeConfig(state, { roots: ["C:\\projets"] });
    const { waker, calls } = fakeWaker("aide");
    expect((await runOnce(dir, state, waker, { sessions: [garden] })).handled).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("nouveau message : la session la plus proche est réveillée une fois, réponse rangée et recopiée", async () => {
    writeConfig(state, { roots: ["C:\\projets"] });
    const { waker, calls } = fakeWaker(
      "Essaie une règle L-système avec un bruit de Perlin pour le vent.",
    );
    await runOnce(dir, state, waker, { sessions: [garden, solana] });
    publish("Comment faire bouger les plantes du jardin avec le vent ?", "msg-0001");
    const first = await runOnce(dir, state, waker, { sessions: [garden, solana] });
    expect(first.handled).toEqual([
      expect.objectContaining({ outcome: "answered", session: "claude:s-garden" }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Comment faire bouger les plantes");
    expect((await runOnce(dir, state, waker, { sessions: [garden, solana] })).handled).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(readAnswers(state)).toEqual([
      expect.objectContaining({
        runtime: "claude",
        sessionId: "s-garden",
        cwd: "C:\\projets\\jardin",
      }),
    ]);
    expect(fs.readFileSync(path.join(dir, AGENT_COPY), "utf8")).toContain("bruit de Perlin");
  });

  it("aucune session proche, aucun dossier autorisé ou « Rien d'utile » : rien n'est rangé", async () => {
    writeConfig(state, { roots: [] });
    const { waker, calls } = fakeWaker("Rien d'utile");
    await runOnce(dir, state, waker, { sessions: [] });
    publish("Question sans rapport : quantique et cuisine moléculaire", "msg-0002");
    expect((await runOnce(dir, state, waker, { sessions: [] })).handled[0]?.outcome).toBe(
      "no_match",
    );
    writeConfig(state, { roots: ["C:\\projets"] });
    publish("Le jardin et le vent encore", "msg-0003");
    expect((await runOnce(dir, state, waker, { sessions: [garden] })).handled[0]?.outcome).toBe(
      "nothing_useful",
    );
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(state, ANSWERS_FILE))).toBe(false);
  });
});

describe("index en cache, incrémental", () => {
  it("n'ouvre que les projets autorisés, ne relit que ce qui a changé", async () => {
    const { refreshIndex, claudeProjectName } =
      await import("../../services/helpers/session-index.js");
    const claudeDir = path.join(home, "claude");
    const codexDir = path.join(home, "codex");
    const allowed = path.join(home, "projets", "jardin");
    const line = (cwd: string, text: string): string =>
      JSON.stringify({ type: "user", cwd, sessionId: "c-1", message: { content: text } });
    fs.mkdirSync(path.join(claudeDir, claudeProjectName(allowed)), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, claudeProjectName(path.join(home, "prive"))), {
      recursive: true,
    });
    const kept = path.join(claudeDir, claudeProjectName(allowed), "a.jsonl");
    fs.writeFileSync(kept, line(allowed, "jardin vent croissance"));
    fs.writeFileSync(
      path.join(claudeDir, claudeProjectName(path.join(home, "prive")), "b.jsonl"),
      line(path.join(home, "prive"), "secret"),
    );
    fs.mkdirSync(path.join(codexDir, "2026", "10", "29"), { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "2026", "10", "29", "rollout-x.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "x-1", cwd: path.join(home, "prive") } })}\n`,
    );
    const options = { roots: [allowed], excluded: [], claudeDir, codexDir };
    const first = await refreshIndex(state, options);
    expect(first.sessions.map((s) => s.cwd)).toEqual([allowed]);
    expect(first.reread).toBe(1);
    expect(fs.readFileSync(path.join(state, "session-index.json"), "utf8")).not.toContain("secret");
    expect((await refreshIndex(state, options)).reread).toBe(0);
    const later = new Date(Date.now() + 5000);
    fs.appendFileSync(kept, `\n${line(allowed, "nouvelle branche")}`);
    fs.utimesSync(kept, later, later);
    expect((await refreshIndex(state, options)).reread).toBe(1);
  });
});
