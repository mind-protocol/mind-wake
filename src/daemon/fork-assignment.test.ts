import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignedForkPrompt,
  forkOwnerMcpConfig,
  forkOwnsPrompt,
  forkWritableDirs,
  LOADED_PROMPT_MARK,
  reloadsPromptOnChange,
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

  // NLR, 16 nov. 2026 02:03 : « PATTERN ACCESS BY DEFAULT » (la Room 2 ne pouvait pas
  // modifier son propre prompt). Le dossier du fichier instructions s'ajoute au writable.
  it("une room écrit dans le dossier de son fichier instructions, en plus de son writable", () => {
    const { root } = space();
    const own = path.join(root, "artifacts", "projets", "mind-representant-ia", "room-fixeurs");
    fs.mkdirSync(own, { recursive: true });
    const instructions = path.join(own, "ROOM2-FIXEURS.md");
    fs.writeFileSync(instructions, "Tu es la Room 2.");
    const a = validateAssignment({
      instructions,
      workspace: root,
      writable: ["artifacts/pattern-holders/fixeur-colony"],
    });
    expect(forkWritableDirs(a)).toEqual([
      path.join(root, "artifacts", "pattern-holders", "fixeur-colony"),
      own,
    ]);
    expect(forkOwnsPrompt(a)).toBe(true);
    const prompt = assignedForkPrompt(2, a);
    expect(prompt).toContain(`Tu écris seulement dans ${path.join(root, "artifacts", "pattern-holders", "fixeur-colony")}, ${own}.`);
    expect(prompt).toContain("est à toi : modifie-le directement quand NLR le demande");
    expect(prompt).toContain("Jamais de fichiers de clés.");
    // Déjà couvert par le writable : pas de doublon.
    const b = validateAssignment({ instructions, workspace: root, writable: ["artifacts/projets"] });
    expect(forkWritableDirs(b)).toEqual([path.join(root, "artifacts", "projets")]);
    // Room 7 (writable vide) : tout son espace, prompt compris, comme avant.
    const vox = validateAssignment({ instructions, workspace: root });
    expect(forkWritableDirs(vox)).toEqual([root]);
    expect(assignedForkPrompt(7, vox)).toContain("modifie-le directement quand NLR le demande");
  });

  it("une room n'écrit jamais hors de son workspace, même pour son prompt", () => {
    const { root } = space();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fork-outside-"));
    dirs.push(outside);
    const instructions = path.join(outside, "PROMPT.md");
    fs.writeFileSync(instructions, "Prompt hors de l'espace.");
    const workspace = path.join(root, "espace");
    fs.mkdirSync(workspace);
    const a = validateAssignment({ instructions, workspace, writable: ["carnet"] });
    const granted = forkWritableDirs(a);
    expect(granted).toEqual([path.join(workspace, "carnet")]);
    for (const d of granted) expect(path.relative(workspace, d).startsWith("..")).toBe(false);
    expect(forkOwnsPrompt(a)).toBe(false);
    const prompt = assignedForkPrompt(2, a);
    expect(prompt).not.toContain(outside + path.sep);
    expect(prompt).not.toContain("est à toi");
    expect(() => validateAssignment({ instructions, workspace, writable: ["../dehors"] })).toThrow();
  });

  // Room 4 : prompt à la racine de son workspace, writable restreint (jeu, journal).
  it("prompt à la racine du workspace : seul le fichier s'ajoute, pas tout le workspace", () => {
    const { root, instructions } = space();
    const a = validateAssignment({ instructions, workspace: root, writable: ["jeu", "journal"] });
    const granted = forkWritableDirs(a);
    expect(granted).toEqual([path.join(root, "jeu"), path.join(root, "journal"), instructions]);
    expect(granted).not.toContain(root);
    expect(forkOwnsPrompt(a)).toBe(true);
    const prompt = assignedForkPrompt(4, a);
    expect(prompt).toContain(`Tu écris seulement dans ${path.join(root, "jeu")}, ${path.join(root, "journal")}, ${instructions}.`);
    expect(prompt).toContain("est à toi : modifie-le directement quand NLR le demande");
  });

  // Room 7 (VOX) : writable vide, prompt à la racine de son workspace, canal historique.
  it("Room 7 garde le même comportement : tout son espace, canal et rechargement inchangés", () => {
    const { root, instructions } = space();
    const vox = validateAssignment({ instructions, workspace: root, holder: "vox-holder" });
    expect(forkWritableDirs(vox)).toEqual([root]);
    const prompt = assignedForkPrompt(7, vox);
    expect(prompt).toContain(
      `Tu peux lire et écrire partout où ton travail le demande : ton espace ${root}, tout l'espace Wake, le dépôt MIND et tes propres fichiers, ton prompt système compris.`,
    );
    expect(prompt).toContain("signé « VOX (Room 7) »");
    expect(prompt).toContain("Aucun envoi externe.");
    expect(prompt).not.toContain("colony_call_tool");
    expect(reloadsPromptOnChange(7, vox)).toBe(true);
    const env = (JSON.parse(forkOwnerMcpConfig(7, "D:/data", "node", "R:/repo", vox) ?? "{}") as {
      mcpServers: { mind: { env: Record<string, string> } };
    }).mcpServers.mind.env;
    expect(env["MIND_WAKE_OWNER_SIGNATURE"]).toBe("VOX (Room 7)");
    expect(env["MIND_WAKE_OWNER_PROFILE"]).toBeUndefined();
    expect(env["MIND_WAKE_OWNER_COLONY"]).toBeUndefined();
  });

  it("une room sans bloc owner n'a aucun outil de publication", () => {
    const { root, instructions } = space();
    for (const id of [2, 3, 4, 5, 6, 8]) {
      const a = validateAssignment({ instructions, workspace: root, writable: ["carnet"] });
      expect(a.owner).toBeNull();
      expect(forkOwnerMcpConfig(id, "D:/data", "node", "R:/repo", a)).toBeUndefined();
      const prompt = assignedForkPrompt(id, a);
      expect(prompt).toContain("Aucun envoi externe.");
      expect(prompt).not.toContain("message_owner");
      expect(prompt).not.toContain("colony_call_tool");
      expect(reloadsPromptOnChange(id, a)).toBe(false);
    }
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
      expect(assignedForkPrompt(7, a)).toContain("« VOX (Room 7) »");
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
        MIND_WAKE_OWNER_SIGNATURE: "VOX (Room 7)",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("canal propriétaire posé par affectation (Room 2)", () => {
  it("profil publish : environnement MCP de la room, Room 7 inchangée", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-owner-room2-"));
    try {
      const instructions = path.join(root, "ROOM2.md");
      fs.writeFileSync(instructions, "Tu es la Room 2.");
      const a = validateAssignment({
        instructions,
        workspace: root,
        owner: { signature: "Fixeur (Room 2)", colony: "colony-fixeur.json", profile: "publish" },
      });
      const config = JSON.parse(forkOwnerMcpConfig(2, "D:/data", "node", "R:/repo", a) ?? "{}") as {
        mcpServers: { mind: { env: Record<string, string> } };
      };
      expect(config.mcpServers.mind.env).toMatchObject({
        MIND_WAKE_OWNER_SIGNATURE: "Fixeur (Room 2)",
        MIND_WAKE_OWNER_PROFILE: "publish",
        MIND_WAKE_OWNER_COLONY: "colony-fixeur.json",
        MIND_WAKE_OWNER_FORK: "2",
      });
      expect(assignedForkPrompt(2, a)).toContain("signé « Fixeur (Room 2) »");
      expect(assignedForkPrompt(2, a)).toContain("Reddit en lecture seule");
      // Sans bloc owner : aucun outil, aucune publication.
      expect(forkOwnerMcpConfig(2, "D:/data", "node", "R:/repo", { ...a, owner: null })).toBeUndefined();
      expect(assignedForkPrompt(2, { ...a, owner: null })).toContain("Aucun envoi externe.");
      // Room 7 : son canal historique, sans variables de profil, même avec un bloc owner.
      const vox = JSON.parse(forkOwnerMcpConfig(7, "D:/data", "node", "R:/repo", a) ?? "{}") as {
        mcpServers: { mind: { env: Record<string, string> } };
      };
      expect(vox.mcpServers.mind.env["MIND_WAKE_OWNER_SIGNATURE"]).toBe("VOX (Room 7)");
      expect(vox.mcpServers.mind.env["MIND_WAKE_OWNER_PROFILE"]).toBeUndefined();
      expect(() =>
        validateAssignment({ instructions, workspace: root, owner: { signature: "VOX (Room 7)", colony: "c.json", profile: "publish" } }),
      ).toThrow("réservée");
      expect(() =>
        validateAssignment({ instructions, workspace: root, owner: { signature: "Fixeur", colony: "colony.json", profile: "publish" } }),
      ).toThrow("colony.json");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
