import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignedForkPrompt,
  forkOwnerMcpConfig,
  LOADED_PROMPT_MARK,
  runAssignedClaudeTurn,
  saveForkAssignment,
  validateAssignment,
} from "./fork-assignment.js";
import { promptDigest } from "../adapters/claude/conversation.js";
import type { runClaudeTurn, SecondThreadEntry } from "./second-thread.js";

// Règle NLR : accès ouvert par défaut ; une limite n'existe que si sa raison est écrite à côté.
describe("écriture d'un fork affecté", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function space(): { root: string; instructions: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-assign-"));
    dirs.push(root);
    const instructions = path.join(root, "DEPART.md");
    fs.writeFileSync(instructions, "Consignes de départ v1");
    return { root, instructions };
  }

  it("sans `writable`, le fork écrit dans tout son espace (pas seulement un sous-dossier)", () => {
    const { root, instructions } = space();
    const a = validateAssignment({ instructions, workspace: root });
    expect(a.writable).toEqual([]);
    const prompt = assignedForkPrompt(7, a);
    expect(prompt).toContain("Tu peux lire et écrire partout");
    expect(prompt).toContain(root);
    expect(prompt).not.toContain("seulement");
    expect(prompt).not.toContain("lecture seule");
  });

  it("une liste `writable` explicite reste la seule façon de restreindre", () => {
    const { root, instructions } = space();
    const a = validateAssignment({ instructions, workspace: root, writable: ["carnet"] });
    expect(assignedForkPrompt(7, a)).toContain(`Tu écris seulement dans ${path.join(root, "carnet")}`);
  });

  it("relit le fichier d'instructions à chaque construction du prompt", () => {
    const { root, instructions } = space();
    const a = saveForkAssignment(path.join(root, "fork"), { instructions, workspace: root, writable: [] });
    expect(assignedForkPrompt(7, a)).toContain("Consignes de départ v1");
    fs.writeFileSync(instructions, "Consignes de départ v2");
    const after = assignedForkPrompt(7, a);
    expect(after).toContain("Consignes de départ v2");
    expect(after).not.toContain("v1");
  });
});

// Mesuré le 6 nov. 2026 : `claude --resume` garde le prompt système du lancement.
describe("rechargement du prompt système (Fork 7)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function setup(id = 7) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-reload-"));
    dirs.push(root);
    const instructions = path.join(root, "DEPART.md");
    fs.writeFileSync(instructions, "Consignes v1");
    const assignment = validateAssignment({ instructions, workspace: root, assignedAt: "2026-11-06T03:06:03.412Z" });
    const kv = new Map<string, string>();
    const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) };
    const calls: { mode: string; id: string; prompt: string; message: string }[] = [];
    const turn = (async (t: Parameters<typeof runClaudeTurn>[0]) => {
      calls.push({ mode: t.session.mode, id: t.session.id, prompt: fs.readFileSync(t.promptFile, "utf8"), message: t.message });
      return { outcome: "completed", text: "réponse", sessionConfirmed: true, tokens: 1, retryAtMs: null, detail: null };
    }) as unknown as typeof runClaudeTurn;
    const history = () =>
      [
        { id: 1, at: "t1", role: "human", text: "bonjour VOX", turn: 1, projectId: null, delivered: true },
        { id: 2, at: "t2", role: "agent", text: `salut\n\n${LOADED_PROMPT_MARK} abc`, turn: 1, projectId: null, delivered: true },
        { id: 3, at: "t3", role: "human", text: "message en attente", turn: null, projectId: null, delivered: false },
      ] as SecondThreadEntry[];
    const run = (message = "NLR [t3] : message en attente") =>
      runAssignedClaudeTurn({ dataDir: root, dir: path.join(root, "fork"), id, assignment, store, message, control: () => "run", turn, history, now: () => new Date("2026-11-06T05:30:00Z") });
    return { root, instructions, kv, calls, run };
  }

  it("un prompt modifié ouvre une session neuve qui le charge, avec rappel du fil, et affiche la version chargée", async () => {
    const { root, instructions, calls, run } = setup();
    fs.mkdirSync(path.join(root, "carnet"));
    fs.writeFileSync(path.join(root, "carnet", "a-trier-pour-la-bible.md"), "notes");
    const first = await run();
    const digestV1 = promptDigest(calls[0]!.prompt).slice(0, 16);
    expect(calls[0]!.mode).toBe("new");
    expect(first.text).toContain(`${LOADED_PROMPT_MARK} ${digestV1} · chargé 2026-11-06T05:30:00.000Z`);
    await run();
    expect(calls[1]!.mode).toBe("resume");
    expect(calls[1]!.id).toBe(calls[0]!.id);
    expect(calls[1]!.message).not.toContain("Note du runtime");

    fs.writeFileSync(instructions, "Consignes v2");
    const third = await run();
    expect(calls[2]!.mode).toBe("new");
    expect(calls[2]!.id).not.toBe(calls[0]!.id);
    expect(calls[2]!.prompt).toContain("Consignes v2");
    expect(calls[2]!.message).toContain("ton prompt système a changé");
    expect(calls[2]!.message).toContain(calls[0]!.id);
    expect(calls[2]!.message).toContain("NLR [t1] : bonjour VOX");
    // Ses propres propos ne sont ni recopiés ni reformulés : renvoi à son carnet.
    expect(calls[2]!.message).not.toContain("salut");
    expect(calls[2]!.message).toContain(path.join(root, "carnet", "a-trier-pour-la-bible.md"));
    expect(calls[2]!.message.endsWith("NLR [t3] : message en attente")).toBe(true);
    const digestV2 = promptDigest(calls[2]!.prompt).slice(0, 16);
    expect(third.text).toContain(`${LOADED_PROMPT_MARK} ${digestV2}`);
    expect(third.text).not.toContain("≠");
    await run();
    expect(calls[3]!.mode).toBe("resume");
    expect(calls[3]!.id).toBe(calls[2]!.id);
    expect(calls[3]!.message).not.toContain("Note du runtime");
  });

  it("une session confirmée sans version de lancement connue est relancée une fois (état actuel de VOX)", async () => {
    const { kv, calls, run } = setup();
    await run();
    const old = calls[0]!.id;
    kv.delete(`claudePromptDigest:${old}`);
    await run();
    expect(calls[1]!.mode).toBe("new");
    expect(calls[1]!.message).toContain(old);
  });

  it("hors Fork 7 : reprise inchangée, pas de pied de version", async () => {
    const { instructions, calls, run } = setup(8);
    await run();
    fs.writeFileSync(instructions, "Consignes v2");
    const second = await run();
    expect(calls[1]!.mode).toBe("resume");
    expect(calls[1]!.id).toBe(calls[0]!.id);
    expect(second.text).toBe("réponse");
  });
});

// NLR 6 nov. 2026 : VOX (Fork 7) écrit elle-même à NLR par message_owner, signé ; pas le Fork 8.
describe("canal propriétaire du Fork 7", () => {
  it("note du runtime et configuration MCP pour le Fork 7 seulement", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-owner-"));
    try {
      const instructions = path.join(root, "DEPART.md");
      fs.writeFileSync(instructions, "Tu es VOX.");
      const a = validateAssignment({ instructions, workspace: root });
      expect(assignedForkPrompt(7, a)).toContain("Tu peux écrire à NLR dans le fil principal avec message_owner");
      expect(assignedForkPrompt(7, a)).toContain("« VOX (Fork 7) »");
      expect(assignedForkPrompt(8, a)).not.toContain("message_owner");
      expect(assignedForkPrompt(7, { ...a, engine: "codex" })).not.toContain("message_owner");
      expect(forkOwnerMcpConfig(8, "D:/data", "node", "R:/repo")).toBeUndefined();
      const config = JSON.parse(forkOwnerMcpConfig(7, "D:/data", "node", "R:/repo")!) as {
        mcpServers: { mind: { command: string; args: string[]; env: Record<string, string> } };
      };
      expect(Object.keys(config.mcpServers)).toEqual(["mind"]);
      expect(config.mcpServers.mind.args.at(-1)).toBe(path.join("R:/repo", "services", "mcp", "fork-owner-main.ts"));
      expect(config.mcpServers.mind.env).toMatchObject({
        MIND_WAKE_DATA_DIR: "D:/data",
        MIND_WAKE_OWNER_MESSAGES: "1",
        MIND_WAKE_OWNER_SIGNATURE: "VOX (Fork 7)",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
