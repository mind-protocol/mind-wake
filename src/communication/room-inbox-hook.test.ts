/**
 * Hook de la boîte de réception d'une room : les messages arrivés pendant un tour sont injectés
 * une fois (après un outil ou au Stop), jamais remis de nouveau à la fin du tour.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeRunArgs } from "../adapters/claude/command.js";
import { roomInboxHookLaunch, saveForkAssignment, type runAssignedClaudeTurn } from "../daemon/fork-assignment.js";
import { forkDir, runForks, sendNoticeToFork, sendToFork, setForkEnabled } from "../daemon/forks.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import { ROOM_INBOX_HEADER, roomInboxHook, roomInboxHookArgv } from "./room-inbox-hook.js";

type TurnInput = Parameters<typeof runAssignedClaudeTurn>[0];

let dir: string, workspace: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-inbox-hook-"));
  workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "ROOM.md"), "Room de test.");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (session: string, name = "PostToolUse") => ({ session_id: session, hook_event_name: name });
const contextOf = (out: object | null) =>
  (out as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext ?? null;

/** Réponses renvoyées à NLR sur Telegram (jamais de vrai envoi en test). */
let phone: string[] = [];
beforeEach(() => {
  phone = [];
});
/**
 * Un tour de la room ; `during` s'exécute pendant le tour simulé (messages, appels du hook) et
 * rend la réponse de l'agent (défaut : SILENCE).
 */
async function turn(during: (input: TurnInput, agent: string) => string | void = () => {}) {
  const calls: TurnInput[] = [];
  await runForks({
    dataDir: dir,
    workspace,
    profile: () => "run",
    claudeProfile: () => "run",
    maxTurns: 1,
    telegramReply: async (text) => {
      phone.push(text);
    },
    claudeTurn: async (input) => {
      calls.push(input);
      const agent = /agent:([a-z0-9-]+):/.exec(input.agent?.key ?? "")?.[1] ?? "room";
      const text = during(input, agent) ?? "SILENCE";
      return { outcome: "completed", text, tokens: 1, accepted: true, detail: null, retryAtMs: null, sessionId: `s-${agent}` };
    },
  });
  return calls;
}
/** Message de NLR routé depuis Telegram (même chemin que telegram-handle-route.ts). */
const fromPhone = (text: string, key: string) => sendToFork(dir, 3, text, `telegram-route:${key}`, "telegram", undefined, [], true);
/** Notice Telegram ciblée vers un agent (même chemin que telegram-handle-route.ts). */
const fromPhoneTo = (text: string, key: string, agent: string) =>
  sendNoticeToFork(dir, 3, text, `telegram-route:${key}`, `NLR (Telegram) → ${agent}`, true);
const hookFor = (input: TurnInput, session = "sess") => ({
  dataDir: dir,
  forkId: 3,
  sessionId: session,
  floor: input.inbox?.floor ?? -1,
  ...(input.inbox?.agentId === undefined ? {} : { agentId: input.inbox.agentId }),
});
const store = () => new SecondThreadStore(forkDir(dir, 3));

describe("room à un agent", () => {
  beforeEach(() => {
    saveForkAssignment(forkDir(dir, 3), { instructions: path.join(workspace, "ROOM.md"), engine: "claude", workspace });
    setForkEnabled(dir, 3, true);
  });

  it("injecte une fois un message arrivé pendant le tour, et ne le remet pas à la fin", async () => {
    sendToFork(dir, 3, "Premier message");
    const seen: (string | null)[] = [];
    const calls = await turn((input) => {
      expect(input.inbox?.floor).toBeGreaterThan(0);
      // Le message initial n'est jamais réinjecté.
      expect(roomInboxHook(hookFor(input), post("sess"))).toBeNull();
      sendToFork(dir, 3, "Arrivé pendant le tour");
      // Autre session (sous-agent ou session étrangère) : rien.
      expect(roomInboxHook(hookFor(input), post("autre"))).toBeNull();
      expect(roomInboxHook(hookFor(input), { ...post("sess"), agent_id: "sub" })).toBeNull();
      seen.push(contextOf(roomInboxHook(hookFor(input), post("sess"))));
      seen.push(contextOf(roomInboxHook(hookFor(input), post("sess"))));
      expect(roomInboxHook(hookFor(input), post("sess", "Stop"))).toBeNull();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toContain("Premier message");
    expect(calls[0]?.message).not.toContain("Arrivé pendant le tour");
    expect(seen[0]).toContain(ROOM_INBOX_HEADER);
    expect(seen[0]).toContain("NLR [");
    expect(seen[0]).toContain("Arrivé pendant le tour");
    expect(seen[1]).toBeNull();
    const s = store();
    try {
      expect(s.pendingHuman()).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("bloque le Stop avec le nouveau message, sous son étiquette", async () => {
    sendToFork(dir, 3, "Premier message");
    let out: object | null = null;
    await turn((input) => {
      sendNoticeToFork(dir, 3, "Note de la vigie", "notice-test-0001", "Vigie");
      out = roomInboxHook(hookFor(input), post("sess", "Stop"));
    });
    expect(out).toMatchObject({ decision: "block" });
    expect((out as unknown as { reason: string }).reason).toContain("Vigie [");
    expect((out as unknown as { reason: string }).reason).not.toContain("NLR [");
  });

  it("injecte les messages Telegram et application, jamais ceux de la room elle-même", async () => {
    sendToFork(dir, 3, "Premier message");
    let ctx: string | null = null;
    await turn((input) => {
      const s = store();
      try {
        s.add("agent", "Ma propre réponse");
      } finally {
        s.close();
      }
      sendToFork(dir, 3, "Écho de moi-même", "self-echo-0001", "interfil", 3);
      fromPhone("Depuis le téléphone", "phone00001");
      sendToFork(dir, 3, "Depuis l'application", "app-0000001", "app");
      ctx = contextOf(roomInboxHook(hookFor(input), post("sess")));
    });
    expect(ctx).toContain("NLR [");
    expect(ctx).toContain("Depuis le téléphone");
    expect(ctx).toContain("Depuis l'application");
    expect(ctx).not.toContain("Ma propre réponse");
    expect(ctx).not.toContain("Écho de moi-même");
  });

  it("garde une pièce écran pour le tour suivant", async () => {
    sendToFork(dir, 3, "Premier message");
    let out: object | null = {};
    await turn((input) => {
      sendToFork(dir, 3, "Regarde l'écran", undefined, "", undefined, ["planche.png"]);
      out = roomInboxHook(hookFor(input), post("sess"));
    });
    expect(out).toBeNull();
    const s = store();
    try {
      expect(s.pendingHuman().map((e) => e.text)).toEqual(["Regarde l'écran"]);
    } finally {
      s.close();
    }
  });

  it("un message Telegram injecté en cours de tour renvoie la réponse au téléphone, une fois", async () => {
    sendToFork(dir, 3, "Message du desktop");
    await turn((input) => {
      fromPhone("Tu m'entends depuis le téléphone ?", "phone00002");
      expect(contextOf(roomInboxHook(hookFor(input), post("sess")))).toContain("depuis le téléphone");
      return "Oui, je t'entends.";
    });
    expect(phone).toHaveLength(1);
    expect(phone[0]).toContain("Oui, je t'entends.");
  });

  it("sans message Telegram, ni initial ni injecté, rien ne part au téléphone", async () => {
    sendToFork(dir, 3, "Message du desktop");
    await turn((input) => {
      sendToFork(dir, 3, "Autre message du desktop");
      roomInboxHook(hookFor(input), post("sess"));
      return "Réponse.";
    });
    expect(phone).toEqual([]);
  });
});

describe("room à plusieurs agents", () => {
  beforeEach(() => {
    const prompts = path.join(workspace, "agents");
    fs.mkdirSync(prompts, { recursive: true });
    for (const id of ["coach-a", "coach-b"]) fs.writeFileSync(path.join(prompts, `${id}.md`), `Je suis ${id}.`);
    saveForkAssignment(forkDir(dir, 3), {
      instructions: path.join(workspace, "ROOM.md"),
      engine: "claude",
      workspace,
      inbox: "explicit",
      agents: [
        { id: "coach-a", name: "Coach A", instructions: path.join(prompts, "coach-a.md"), writable: [], tools: "none" },
        { id: "coach-b", name: "Coach B", instructions: path.join(prompts, "coach-b.md"), writable: [], tools: "none" },
      ],
      agentsConcurrency: 1,
    });
    setForkEnabled(dir, 3, true);
  });

  it("suit le routage : une notice ciblée ne va qu'à son agent", async () => {
    sendToFork(dir, 3, "Bonjour à tous");
    const got: Record<string, string | null> = {};
    await turn((input, agent) => {
      if (agent === "coach-a") sendNoticeToFork(dir, 3, "Pour B seulement", "target-b-0001", "@handle → Coach B");
      got[agent] = contextOf(roomInboxHook(hookFor(input, `s-${agent}`), post(`s-${agent}`)));
    });
    expect(got["coach-a"]).toBeNull();
    expect(got["coach-b"]).toContain("Pour B seulement");
    const s = store();
    try {
      expect(s.pendingHuman()).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("un message pour tous injecté à un agent n'est livré qu'une fois tous servis, et pas remis à cet agent", async () => {
    sendToFork(dir, 3, "Bonjour à tous");
    const got: Record<string, string | null> = {};
    await turn((input, agent) => {
      // Coach A a déjà fini son tour quand le message arrive pendant celui de Coach B.
      if (agent !== "coach-b") return;
      sendToFork(dir, 3, "Nouveau pour tous");
      got[agent] = contextOf(roomInboxHook(hookFor(input, `s-${agent}`), post(`s-${agent}`)));
      expect(roomInboxHook(hookFor(input, `s-${agent}`), post(`s-${agent}`, "Stop"))).toBeNull();
    });
    expect(got["coach-b"]).toContain("Nouveau pour tous");
    const s = store();
    try {
      // Coach A ne l'a pas encore reçu : toujours en attente.
      expect(s.pendingHuman().map((e) => e.text)).toEqual(["Nouveau pour tous"]);
    } finally {
      s.close();
    }
    const next = await turn();
    expect(next.map((c) => /agent:([a-z0-9-]+):/.exec(c.agent?.key ?? "")?.[1])).toEqual(["coach-a"]);
    expect(next[0]?.message).toContain("Nouveau pour tous");
    const t = store();
    try {
      expect(t.pendingHuman()).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("un message Telegram ciblé, injecté à son agent, renvoie sa réponse au téléphone (et pas celle des autres)", async () => {
    sendToFork(dir, 3, "Bonjour à tous");
    await turn((input, agent) => {
      if (agent === "coach-a") {
        fromPhoneTo("Coach B, tu peux regarder ?", "phone00003", "Coach B");
        expect(roomInboxHook(hookFor(input, "s-coach-a"), post("s-coach-a"))).toBeNull();
        return "Coach A répond dans la room.";
      }
      expect(contextOf(roomInboxHook(hookFor(input, "s-coach-b"), post("s-coach-b")))).toContain("tu peux regarder");
      return "Je regarde.";
    });
    expect(phone).toHaveLength(1);
    expect(phone[0]).toContain("Je regarde.");
  });
});

describe("lancement", () => {
  it("enregistre le hook de la room dans les réglages de la session Claude", () => {
    const hook = roomInboxHookLaunch(dir, 3, "sess-1", 42, "coach-a");
    expect(roomInboxHookArgv(hook.args.slice(1))).toEqual({ dataDir: dir, forkId: 3, sessionId: "sess-1", floor: 42, agentId: "coach-a" });
    const args = claudeRunArgs({
      model: "opus",
      systemPromptFile: "p.md",
      tools: [],
      nativeCapabilities: true,
      permission: "skip_permissions_unsandboxed",
      session: { mode: "new", id: "sess-1" },
      roomInboxHook: hook,
    });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}") as {
      disableAllHooks: boolean;
      hooks: Record<string, { hooks: { args: string[] }[] }[]>;
    };
    expect(settings.disableAllHooks).toBe(false);
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "PostToolUseFailure", "Stop"]);
    expect(settings.hooks["Stop"]?.[0]?.hooks[0]?.args).toContain("--deliver-room-inbox");
  });
});
