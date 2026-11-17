/**
 * Agent local (moteur `ollama`) d'une room : Ollama simulé, aucun appel réseau ni modèle.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkDir, runForks, sendNoticeToFork, sendToFork, setForkEnabled } from "./forks.js";
import { saveForkAssignment, validateAssignment, type runAssignedClaudeTurn } from "./fork-assignment.js";
import {
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_HISTORY_KEY,
  buildOllamaMessages,
  ollamaAgentPrompt,
  readOllamaHistory,
  runOllamaAgentTurn,
  stripThinking,
  validateOllamaConfig,
} from "./ollama-agent.js";
import { SecondThreadStore } from "./second-thread.js";
import { routeTelegramHandle, telegramHandleTable } from "../communication/telegram-handle-route.js";

type ClaudeInput = Parameters<typeof runAssignedClaudeTurn>[0];

let dir: string, workspace: string, localPrompt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-agent-"));
  workspace = path.join(dir, "workspace");
  const own = path.join(workspace, "agent-local");
  fs.mkdirSync(own, { recursive: true });
  localPrompt = path.join(own, "LOCAL.md");
  fs.writeFileSync(localPrompt, "# Local\nJe suis Local, le modèle qui tourne sur le PC de NLR.");
  fs.writeFileSync(path.join(workspace, "ROOM.md"), "Room de test.");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const LOCAL = (extra: Record<string, unknown> = {}) => ({
  id: "local",
  name: "Local",
  instructions: localPrompt,
  writable: ["agent-local"],
  engine: "ollama",
  ollama: { model: "mistral-small3.2:24b", url: "http://192.168.1.20:11434" },
  ...extra,
});
const CLAUDE_AGENT = {
  id: "coach-colony",
  name: "Coach Colony",
  instructions: path.join("C:/", "x"),
  writable: [],
  tools: "none",
};

function memoryStore() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), map: m };
}

/** Réponse d'Ollama simulée ; garde le corps envoyé. */
function fakeOllama(reply: string | { status: number; error: string } | Error) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    if (reply instanceof Error) throw reply;
    if (typeof reply !== "string")
      return { ok: false, status: reply.status, text: async () => JSON.stringify({ error: reply.error }) };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: { role: "assistant", content: reply }, done: true, prompt_eval_count: 40, eval_count: 7 }),
    };
  };
  return { calls, fetch };
}

describe("affectation d'un agent ollama", () => {
  const base = () => ({ instructions: path.join(workspace, "ROOM.md"), workspace });

  it("accepte engine ollama avec ses réglages ; un agent sans engine reste Claude", () => {
    const a = validateAssignment({ ...base(), agents: [LOCAL(), CLAUDE_AGENT] });
    expect(a.agents?.[0]).toMatchObject({ id: "local", engine: "ollama", ollama: { model: "mistral-small3.2:24b", url: "http://192.168.1.20:11434" } });
    expect(a.agents?.[1]).not.toHaveProperty("engine");
    expect(validateAssignment({ ...base(), agents: [LOCAL({ ollama: undefined })] }).agents?.[0]?.ollama).toEqual({ model: DEFAULT_OLLAMA_MODEL });
  });

  it("refuse les réglages invalides et tout outil pour un agent local", () => {
    const bad = (extra: Record<string, unknown>) => () => validateAssignment({ ...base(), agents: [LOCAL(extra)] });
    expect(bad({ engine: "gpt" })).toThrow("engine attendu");
    expect(bad({ engine: undefined })).toThrow("bloc ollama sans engine");
    expect(bad({ tools: "publish" })).toThrow("aucun outil");
    expect(bad({ ollama: { model: "x y" } })).toThrow("nom de modèle");
    expect(bad({ ollama: { model: "m", url: "ftp://h" } })).toThrow("URL");
    expect(bad({ ollama: { model: "m", url: "http://u:p@h:11434" } })).toThrow("URL");
    expect(bad({ ollama: { model: "m", numCtx: 100 } })).toThrow("numCtx");
    expect(bad({ ollama: { model: "m", gpu: 1 } })).toThrow("inconnu");
    expect(validateOllamaConfig({ model: "qwen3:32b", think: false, numCtx: 8192, temperature: 0.2 }, "local")).toEqual({
      model: "qwen3:32b",
      think: false,
      numCtx: 8192,
      temperature: 0.2,
    });
  });
});

describe("tour d'un agent ollama", () => {
  it("envoie système, historique et message à /api/chat sans streaming, puis garde l'échange", async () => {
    const store = memoryStore();
    const o = fakeOllama("Bonjour NLR.");
    const r = await runOllamaAgentTurn({ config: { model: "m:1", url: "http://pc:11434/" }, system: "SYS", message: "salut", store, control: () => "run", fetch: o.fetch });
    expect(r).toMatchObject({ outcome: "completed", text: "Bonjour NLR.", accepted: true, tokens: 47 });
    expect(o.calls[0]!.url).toBe("http://pc:11434/api/chat");
    expect(o.calls[0]!.body).toMatchObject({ model: "m:1", stream: false, options: { num_ctx: 16384 } });
    expect(o.calls[0]!.body).not.toHaveProperty("think");
    expect(o.calls[0]!.body["messages"]).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "salut" },
    ]);
    expect(readOllamaHistory(store)).toEqual([
      { role: "user", content: "salut" },
      { role: "assistant", content: "Bonjour NLR." },
    ]);
    const o2 = fakeOllama("<think>hmm</think>Ça va.");
    const r2 = await runOllamaAgentTurn({ config: { model: "qwen3:32b", think: false }, system: "SYS", message: "ça va ?", store, control: () => "run", fetch: o2.fetch, env: {} });
    expect(r2.text).toBe("Ça va.");
    expect(o2.calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(o2.calls[0]!.body["think"]).toBe(false);
    expect((o2.calls[0]!.body["messages"] as unknown[]).length).toBe(4);
  });

  it("tronque l'historique pour tenir dans la fenêtre : les plus anciens tombent d'abord", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), content: `${String(i)}:${"x".repeat(1000)}` }));
    const msgs = buildOllamaMessages("SYS", history, "dernier", 4096);
    const total = msgs.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual((4096 - 1200) * 3);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "dernier" });
    expect(msgs.at(-2)!.content.startsWith("29:")).toBe(true);
    expect(msgs.some((m) => m.content.startsWith("0:"))).toBe(false);
    expect(stripThinking("<think>a\nb</think>\nok")).toBe("ok");
  });

  it("Ollama injoignable ou modèle absent : message traité avec une réponse qui le dit ; interruption : rien de consommé", async () => {
    const store = memoryStore();
    const down = await runOllamaAgentTurn({ config: { model: "m" }, system: "S", message: "x", store, control: () => "run", fetch: fakeOllama(new TypeError("fetch failed")).fetch, env: {} });
    expect(down).toMatchObject({ outcome: "error", accepted: true });
    expect(down.text).toContain("Ollama injoignable à http://127.0.0.1:11434");
    const missing = await runOllamaAgentTurn({ config: { model: "m" }, system: "S", message: "x", store, control: () => "run", fetch: fakeOllama({ status: 404, error: "model 'm' not found" }).fetch });
    expect(missing.text).toContain("ollama pull m");
    expect(store.map.has(OLLAMA_HISTORY_KEY)).toBe(false);
    const paused = await runOllamaAgentTurn({ config: { model: "m" }, system: "S", message: "x", store, control: () => "hold", fetch: fakeOllama("non").fetch });
    expect(paused).toMatchObject({ outcome: "interrupted", accepted: false });
  });

  it("prompt : instructions de l'agent puis note du runtime (local, aucun outil, SILENCE)", () => {
    const p = ollamaAgentPrompt("# Local\nQui je suis.", { room: 6, id: "local", name: "Local", others: [], model: "mistral-small3.2:24b" });
    expect(p.startsWith("# Local")).toBe(true);
    expect(p).toContain("@local");
    expect(p).toContain("aucun outil");
    expect(p).toContain("SILENCE");
  });
});

describe("agent ollama dans la room (forks.ts, room-agents.ts)", () => {
  function assign(enabled: boolean, agents: unknown[] = [LOCAL()]) {
    saveForkAssignment(forkDir(dir, 6), { instructions: path.join(workspace, "ROOM.md"), engine: "claude", workspace, inbox: "explicit", agents });
    setForkEnabled(dir, 6, enabled);
    if (!enabled) {
      // Room 4 (Claude simulé), active, garde le worker vivant le temps d'un tour, comme forks.test.ts.
      saveForkAssignment(forkDir(dir, 4), { instructions: path.join(workspace, "ROOM.md"), engine: "claude", workspace });
      setForkEnabled(dir, 4, true);
      sendToFork(dir, 4, "tour de la room 4");
    }
  }
  async function turn(content: string) {
    const claude: ClaudeInput[] = [];
    const telegram: string[] = [];
    const real = globalThis.fetch;
    const o = fakeOllama(content);
    globalThis.fetch = o.fetch as unknown as typeof fetch;
    try {
      await runForks({
        dataDir: dir,
        workspace,
        profile: () => "run",
        claudeProfile: () => "run",
        maxTurns: 1,
        telegramInbound: false,
        telegramReply: async (text) => {
          telegram.push(text);
        },
        claudeTurn: async (input) => {
          claude.push(input);
          return { outcome: "completed", text: "SILENCE", tokens: 1, accepted: true, detail: null, retryAtMs: null, sessionId: "s" };
        },
      });
    } finally {
      globalThis.fetch = real;
    }
    return { calls: o.calls, claude, telegram };
  }
  const entries = () => {
    const s = new SecondThreadStore(forkDir(dir, 6));
    try {
      return s.entries();
    } finally {
      s.close();
    }
  };

  it("room active : un message de NLR réveille l'agent local, qui répond signé, sans session Claude", async () => {
    assign(true);
    sendToFork(dir, 6, "@local tu m'entends ?");
    const r = await turn("Oui, je t'entends.");
    expect(r.claude).toHaveLength(0);
    expect(r.calls).toHaveLength(1);
    const sys = (r.calls[0]!.body["messages"] as { content: string }[])[0]!.content;
    expect(sys).toContain("Je suis Local");
    expect(sys).toContain("aucun outil");
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual(["Local : Oui, je t'entends."]);
    expect(entries().filter((e) => e.role === "human").every((e) => e.delivered)).toBe(true);
  });

  it("room désactivée : @local depuis Telegram donne un tour unique, et la réponse repart sur Telegram", async () => {
    assign(false);
    // Démarrage du worker : `oneshot-since` posé ; un message antérieur ne réveillerait personne.
    const s = new SecondThreadStore(forkDir(dir, 6));
    s.set("oneshot-since", new Date(Date.now() - 1000).toISOString());
    s.close();
    const table = telegramHandleTable(dir, undefined, () => []);
    expect(table.get("local")).toMatchObject({ room: 6, label: "Local (Room 6)" });
    const routed = routeTelegramHandle(dir, "@local", "résume-moi ça en une phrase", "tg-msg-12345678", table);
    expect(routed).toMatchObject({ status: "routed", room: 6, agent: "local" });
    const r = await turn("Voici une phrase.");
    expect(r.calls).toHaveLength(1);
    expect(r.claude.every((c) => c.id === 4)).toBe(true);
    expect(r.telegram.join("\n")).toContain("Voici une phrase.");
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual(["Local : Voici une phrase."]);
  });

  it("room partagée : la notice ciblée vers Local ne réveille ni ne facture aucun agent Claude", async () => {
    assign(true, [LOCAL(), { ...CLAUDE_AGENT, instructions: localPrompt }]);
    sendNoticeToFork(dir, 6, "une question pour toi", "k-local-1", "NLR (Telegram) → Local", true);
    const r = await turn("Réponse locale.");
    expect(r.claude).toHaveLength(0);
    expect(r.calls).toHaveLength(1);
  });
});
