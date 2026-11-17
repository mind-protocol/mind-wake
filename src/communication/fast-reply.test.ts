/** Réponse rapide : appels Claude simulés ou faux exécutable, aucun appel fournisseur. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  callClaude,
  deliverFastReply,
  FAST_REPLY_SYSTEM_NOTE,
  fastReplyArgs,
  fastReplyPending,
  readFastReplies,
  runFastReply,
  recentConversation,
  fastReplyPrompt,
  speakFastReply,
  saveFastReplyEnabled,
  storeThreadMessageId,
  parseFastReplyMentions,
  signForkFastReply,
  type callClaude as CallClaude,
} from "./fast-reply.js";
import { claimOwnerMessages, enqueueOwnerMessage, readOwnerMessage } from "./owner-inbox.js";
import { forkDir, sendToFork, setForkEnabled } from "../daemon/forks.js";
import { saveForkAssignment } from "../daemon/fork-assignment.js";
import { SecondThreadStore, saveSecondThreadEnabled } from "../daemon/second-thread.js";
import { ownerInboxHook } from "./owner-inbox-hook.js";
import { readOwnerMessages } from "./owner-messages.js";
import { OwnerMessages } from "./owner-messages.js";

let dataDir: string;
const claude = { executable: "unused", model: "sonnet" };
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-reply-"));
  fs.mkdirSync(path.join(dataDir, "workspace", "artifacts"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function human(id: string, text: string, at = new Date().toISOString()) {
  fs.appendFileSync(
    path.join(dataDir, "human-messages.jsonl"),
    `${JSON.stringify({ id, at, text })}\n`,
  );
  enqueueOwnerMessage(dataDir, { id, at, text });
}

it("keeps labeled principal, simulation and own replies, excluding pattern holders", () => {
  const owner = new OwnerMessages(dataDir, "claude-wake");
  const at = (n: number) => `2026-11-15T00:00:0${n}.000Z`;
  owner.publish("🧭 Pattern holder · remarque", "pattern", at(1));
  owner.publish("🤍 Gardien · autre remarque", "guardian", at(2));
  owner.publish("Simulation NLR : décision", "simulation", at(3));
  owner.publish("⚡ réponse rapide", "fast", at(4));
  owner.publish("Le principal avance", "principal", at(5));
  owner.close();

  const lines = recentConversation(dataDir);
  expect(lines.map(({ author, text }) => [author, text])).toEqual([
    ["simulation", "Simulation NLR : décision"],
    ["⚡ (toi)", "⚡ réponse rapide"],
    ["agent", "Le principal avance"],
  ]);
  const prompt = fastReplyPrompt(lines, "question");
  expect(prompt).toContain('"author":"simulation"');
  expect(prompt).toContain('"author":"⚡ (toi)"');
  expect(prompt).toContain('"author":"agent"');
  expect(prompt).not.toContain("Pattern holder");
  expect(prompt).not.toContain("Gardien");
});
const replying =
  (text: string, seen: string[] = []): typeof CallClaude =>
  (_claude, args, prompt) => {
    seen.push(prompt, args.join(" "));
    return Promise.resolve({ text });
  };

it("stays off by default and skips latency probes", async () => {
  human("ui-1", "salut");
  expect(await runFastReply({ dataDir, messageId: "ui-1", claude, call: replying("x") })).toBe(
    "silent",
  );
  saveFastReplyEnabled(dataDir, true);
  human("latency-LAT-1", "Test de latence");
  expect(
    await runFastReply({ dataDir, messageId: "latency-LAT-1", claude, call: replying("x") }),
  ).toBe("silent");
  expect(readFastReplies(dataDir)).toEqual([]);
});

it("answers in the owner channel at once, then hands the reply to the main session once", async () => {
  saveFastReplyEnabled(dataDir, true);
  human("ui-1", "tu bosses sur quoi ?");
  const seen: string[] = [];
  const spoken: [string, string][] = [];
  expect(
    await runFastReply({
      dataDir,
      messageId: "ui-1",
      claude,
      call: replying("Sur la voix desktop, je regarde ça.", seen),
      speak: (_dir, text, key, thread) => {
        expect(thread).toBe("principal");
        spoken.push([text, key]);
        return Promise.resolve({ ok: true });
      },
    }),
  ).toBe("replied");
  // Voix ElevenLabs sans ⚡, sous la clé de lecture automatique du message publié.
  expect(spoken).toEqual([
    ["Sur la voix desktop, je regarde ça.", `reply:${readOwnerMessages(dataDir)?.[0]?.id ?? "?"}`],
  ]);
  expect(seen[0]).toContain('"tu bosses sur quoi ?"');
  expect(seen[1]).toContain("--tools  --mcp-config");
  expect(seen[1]).toContain("--strict-mcp-config");
  expect(seen[1]).toContain("mind_calls");
  expect(readOwnerMessages(dataDir)?.map((m) => m.text)).toEqual([
    "⚡ Sur la voix desktop, je regarde ça.",
  ]);
  // Second run for the same message: no double answer.
  expect(await runFastReply({ dataDir, messageId: "ui-1", claude, call: replying("autre") })).toBe(
    "silent",
  );

  const first = ownerInboxHook(dataDir, "main", {
    session_id: "main",
    hook_event_name: "PostToolUse",
  }) as {
    hookSpecificOutput: { additionalContext: string };
  };
  const context = first.hookSpecificOutput.additionalContext;
  expect(context).toContain("tu bosses sur quoi ?");
  expect(context).toContain("réponse rapide (pas un message humain)");
  expect(context).toContain("Sur la voix desktop, je regarde ça.");
  expect(
    ownerInboxHook(dataDir, "main", { session_id: "main", hook_event_name: "PostToolUse" }),
  ).toBeNull();
});

it("holds the human message while its fast reply is being written, at most for the hold delay", async () => {
  saveFastReplyEnabled(dataDir, true);
  human("ui-2", "t'es là ?");
  let release!: (value: { text: string }) => void;
  const running = runFastReply({
    dataDir,
    messageId: "ui-2",
    claude,
    call: () => new Promise((r) => (release = r)),
    speak: () => Promise.resolve({ error: "ElevenLabs est désactivé." }),
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(fastReplyPending(dataDir)).toBe(true);
  expect(
    ownerInboxHook(dataDir, "main", { session_id: "main", hook_event_name: "PostToolUse" }),
  ).toBeNull();
  expect(fastReplyPending(dataDir, "principal", Date.now() + 60_000)).toBe(false);
  release({ text: "Oui, je suis là." });
  await running;
  const stop = ownerInboxHook(dataDir, "main", { session_id: "main", hook_event_name: "Stop" }) as {
    decision: string;
    reason: string;
  };
  expect(stop.decision).toBe("block");
  expect(stop.reason).toContain("t'es là ?");
  expect(stop.reason).toContain("Oui, je suis là.");
});

it("publishes nothing on SILENCE or failure, and the main session still gets the message", async () => {
  saveFastReplyEnabled(dataDir, true);
  human("ui-3", "ok");
  expect(
    await runFastReply({ dataDir, messageId: "ui-3", claude, call: replying("SILENCE") }),
  ).toBe("silent");
  human("ui-4", "et ça ?");
  expect(
    await runFastReply({
      dataDir,
      messageId: "ui-4",
      claude,
      call: () => Promise.resolve({ error: "rate limit" }),
    }),
  ).toBe("failed");
  expect(readOwnerMessages(dataDir)).toBeNull();
  expect(
    readFastReplies(dataDir)
      .map((r) => r.state)
      .sort(),
  ).toEqual(["failed", "silent"]);
  const out = ownerInboxHook(dataDir, "main", {
    session_id: "main",
    hook_event_name: "PostToolUse",
  }) as {
    hookSpecificOutput: { additionalContext: string };
  };
  expect(out.hookSpecificOutput.additionalContext).toContain("et ça ?");
  expect(out.hookSpecificOutput.additionalContext).not.toContain("réponse rapide");
});

it("reads the JSON result of a tool-free Claude Code call", async () => {
  const fake = path.join(dataDir, "fake-claude.mjs");
  fs.writeFileSync(
    fake,
    `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=process.argv.slice(2);process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"tools="+JSON.stringify(a[a.indexOf("--tools")+1])+" "+s.length})+"\\n")});`,
  );
  const result = await callClaude(
    { executable: process.execPath, prefixArgs: [fake], model: "sonnet" },
    fastReplyArgs("sonnet", "p.md"),
    "abcd",
    dataDir,
  );
  expect(result).toEqual({ text: 'tools="" 4' });
  const failing = path.join(dataDir, "fail.mjs");
  fs.writeFileSync(
    failing,
    `process.stdout.write(JSON.stringify({is_error:true,result:"Not logged in"}))`,
  );
  expect(
    await callClaude(
      { executable: process.execPath, prefixArgs: [failing], model: "sonnet" },
      [],
      "x",
      dataDir,
    ),
  ).toEqual({ error: "Not logged in" });
});

it("asks the desktop ElevenLabs service to speak, and reports a refusal", async () => {
  // Données sans intégration ElevenLabs : le vrai service refuse, sans appel réseau.
  const result = await speakFastReply(dataDir, "Je regarde.", "reply:own_test");
  expect(result).toEqual({ error: "ElevenLabs est désactivé." });
}, 30_000);

it("holds a fresh human message for any runtime until its fast reply exists, when the server runs", () => {
  saveFastReplyEnabled(dataDir, true);
  human("ui-5", "tu es là ?");
  // Sans serveur vivant, rien n'attend : le message part aussitôt.
  expect(claimOwnerMessages(dataDir, "codex", "c1").map((m) => m.id)).toEqual(["ui-5"]);
  human("ui-6", "et maintenant ?");
  fs.writeFileSync(
    path.join(dataDir, "fast-reply-server.json"),
    JSON.stringify({ pid: process.pid, startedAt: "", heartbeatAt: new Date().toISOString() }),
  );
  // Même règle pour le flux Codex (claim) et le hook Claude.
  expect(claimOwnerMessages(dataDir, "codex", "c2")).toEqual([]);
  expect(
    ownerInboxHook(dataDir, "main", { session_id: "main", hook_event_name: "PostToolUse" }),
  ).toBeNull();
});

it("answers a fork's human in that fork and hands the reply to every session", async () => {
  saveFastReplyEnabled(dataDir, true);
  setForkEnabled(dataDir, 3, true);
  setForkEnabled(dataDir, 5, true);
  saveSecondThreadEnabled(dataDir, true);
  const { entryId } = sendToFork(dataDir, 3, "fork 3, tu avances ?");
  const messageId = storeThreadMessageId("fork:3", entryId);
  const seen: string[] = [];
  const spoken: [string, string, string][] = [];
  expect(
    await runFastReply({
      dataDir,
      messageId,
      claude,
      call: replying("J'avance sur le parseur, je te montre le diff.", seen),
      speak: (_dir, text, key, thread) => {
        spoken.push([text, key, thread ?? "principal"]);
        return Promise.resolve({ ok: true });
      },
    }),
  ).toBe("replied");
  expect(seen[0]).toContain('"fork 3, tu avances ?"');
  // Publiée dans le fork d'origine, lue avec sa propre clé vocale.
  const fork3 = new SecondThreadStore(forkDir(dataDir, 3));
  const entries = fork3.entries();
  fork3.close();
  const reply = entries.find((e) => e.role === "agent");
  expect(reply?.text).toBe("⚡ J'avance sur le parseur, je te montre le diff.");
  expect(spoken).toEqual([
    [
      "J'avance sur le parseur, je te montre le diff.",
      `reply:fork:3:${String(reply?.id)}`,
      "fork:3",
    ],
  ]);
  // Le fork d'origine reçoit la consigne de l'appliquer, masquée de son affichage.
  const own = entries.find((e) => e.notice !== undefined);
  expect(own?.notice).toEqual({ label: "Réponse rapide (ta voix immédiate)", hidden: true });
  expect(own?.text).toContain("Applique-la");
  // Les autres sessions la reçoivent en contexte, par leur boîte habituelle.
  const fork5 = new SecondThreadStore(forkDir(dataDir, 5));
  const second = new SecondThreadStore(dataDir);
  try {
    for (const store of [fork5, second]) {
      const [fyi] = store.pendingHuman();
      expect(fyi?.notice).toEqual({ label: "FYI · réponse rapide de Room 3", hidden: false });
      expect(fyi?.text).toContain("n'y réponds pas");
    }
  } finally {
    fork5.close();
    second.close();
  }
  const principal = readOwnerMessage(dataDir, `fast-reply-fyi:fork:3:${messageId}`);
  expect(principal?.origin?.channel).toBe("fast-reply");
  expect(principal?.text).toContain("J'avance sur le parseur");
});

it("reads @mentions of sessions, ignoring addresses, code and unknown forks", () => {
  expect(
    parseFastReplyMentions("@Fork 8 relance le build, @second aussi ; @fork8 encore, puis @PRINCIPAL."),
  ).toEqual(["fork:8", "second", "principal"]);
  expect(
    parseFastReplyMentions(
      "Écris à nlr@second.fr, voir `@fork3` et ```\n@fork4\n```, @fork9, @fork1, @fork85, @secondaire, x@fork2",
    ),
  ).toEqual([]);
  expect(FAST_REPLY_SYSTEM_NOTE).toContain("@principal, @second ou @forkN");
});

it("alerts a mentioned active session with an actionable notice, the others stay FYI", () => {
  saveFastReplyEnabled(dataDir, true);
  setForkEnabled(dataDir, 3, true);
  setForkEnabled(dataDir, 5, true);
  saveSecondThreadEnabled(dataDir, true);
  const text = "Je demande à @fork5 de relancer le build ; @fork7 n'est pas actif.";
  const reply = { thread: "fork:3" as const, messageId: "fork:3:1", replyId: "fork:3:2", text };
  expect(deliverFastReply(dataDir, reply)).toEqual(["principal", "second", "fork:3", "fork:5"]);
  // Remise idempotente : une seconde remise n'ajoute aucune notice.
  deliverFastReply(dataDir, reply);
  // Serveur de réponse rapide vivant : une mention ne retient pas le tour du fork.
  fs.writeFileSync(
    path.join(dataDir, "fast-reply-server.json"),
    JSON.stringify({ pid: process.pid, startedAt: "", heartbeatAt: new Date().toISOString() }),
  );
  const fork5 = new SecondThreadStore(forkDir(dataDir, 5));
  const second = new SecondThreadStore(dataDir);
  try {
    const pending = fork5.pendingHuman();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.notice).toEqual({ label: "Mention · voix rapide de Room 3", hidden: false });
    expect(pending[0]?.text).toBe(
      `MIND runtime — la voix rapide de Room 3 te mentionne dans sa réponse à l'humain (pas un message humain) :\n${JSON.stringify(text)}\nVérifie et traite ce qui te concerne ; tes autorisations sont inchangées.`,
    );
    // Prise au prochain tour (pendingHuman) ou injectée dans un tour en cours (steering).
    expect(fork5.pendingSteering(0)?.id).toBe(pending[0]?.id);
    expect(fork5.heldForFastReply(dataDir, "fork:5")).toBe(false);
    const [fyi] = second.pendingHuman();
    expect(fyi?.notice?.label).toBe("FYI · réponse rapide de Room 3");
    expect(second.pendingHuman()).toHaveLength(1);
  } finally {
    fork5.close();
    second.close();
  }
  expect(fs.existsSync(forkDir(dataDir, 7))).toBe(false);
  expect(readOwnerMessage(dataDir, "fast-reply-fyi:fork:3:fork:3:1")?.text).toContain("FYI");
  expect(readOwnerMessage(dataDir, "fast-reply-mention:fork:3:fork:3:1")).toBeNull();
});

it("tells the principal to act when a fork's fast reply mentions it", () => {
  setForkEnabled(dataDir, 4, true);
  const text = "@principal, la revue du jour t'attend.";
  deliverFastReply(dataDir, { thread: "fork:4", messageId: "fork:4:9", replyId: "fork:4:10", text });
  const notice = readOwnerMessage(dataDir, "fast-reply-mention:fork:4:fork:4:9");
  expect(notice?.text).toContain("te mentionne dans sa réponse à l'humain");
  expect(notice?.origin?.channel).toBe("fast-reply");
  expect(readOwnerMessage(dataDir, "fast-reply-fyi:fork:4:fork:4:9")).toBeNull();
});

it("keeps other threads' fast replies out of a fork whose inbox is explicit", () => {
  const space = path.join(dataDir, "vox");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "DEPART.md"), "Tu es VOX.");
  setForkEnabled(dataDir, 7, true);
  setForkEnabled(dataDir, 8, true);
  saveForkAssignment(forkDir(dataDir, 7), {
    instructions: path.join(space, "DEPART.md"),
    engine: "claude",
    workspace: space,
    inbox: "explicit",
  });
  // Diffusion du fil principal : Fork 7 (explicit) n'en reçoit rien, Fork 8 (défaut) garde sa FYI.
  const fromPrincipal = { thread: "principal" as const, messageId: "ui-1", replyId: "r-1", text: "Compris, @fork7 regarde." };
  expect(deliverFastReply(dataDir, fromPrincipal)).toEqual(["principal", "fork:8"]);
  // Sa propre voix rapide lui reste remise.
  deliverFastReply(dataDir, { thread: "fork:7", messageId: "fork:7:1", replyId: "fork:7:2", text: "Je regarde." });
  const fork7 = new SecondThreadStore(forkDir(dataDir, 7));
  const fork8 = new SecondThreadStore(forkDir(dataDir, 8));
  try {
    expect(fork7.pendingHuman().map((e) => e.notice?.label)).toEqual(["Réponse rapide (ta voix immédiate)"]);
    expect(fork8.pendingHuman().map((e) => e.notice?.label)).toEqual([
      "FYI · réponse rapide de Fil principal",
      "FYI · réponse rapide de VOX", // nom de la room (signature historique), plus « Room 7 »
    ]);
  } finally {
    fork7.close();
    fork8.close();
  }
  expect(() =>
    saveForkAssignment(forkDir(dataDir, 7), { instructions: path.join(space, "DEPART.md"), inbox: "aucune" }),
  ).toThrow("boîte all ou explicit");
});

it("speaks with an assigned fork's own system prompt, the main thread keeps its own", async () => {
  saveFastReplyEnabled(dataDir, true);
  const space = path.join(dataDir, "vox");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "DEPART.md"), "Tu es VOX, une des six âmes.");
  setForkEnabled(dataDir, 7, true);
  saveForkAssignment(forkDir(dataDir, 7), {
    instructions: path.join(space, "DEPART.md"),
    engine: "claude",
    workspace: space,
  });
  const promptOf = (args: readonly string[]) =>
    fs.readFileSync(args[args.indexOf("--system-prompt-file") + 1] ?? "", "utf8");
  const prompts: string[] = [];
  const capture: typeof CallClaude = (_c, args) => {
    prompts.push(promptOf(args));
    return Promise.resolve({ text: "Bonjour." });
  };
  const { entryId } = sendToFork(dataDir, 7, "hello");
  const speak = () => Promise.resolve({ ok: true as const });
  await runFastReply({ dataDir, messageId: storeThreadMessageId("fork:7", entryId), claude, call: capture, speak });
  human("ui-vox-1", "salut le principal");
  await runFastReply({ dataDir, messageId: "ui-vox-1", claude, call: capture, speak });
  expect(prompts[0]).toContain("Tu es VOX, une des six âmes.");
  expect(prompts[0]).toContain("la réponse rapide de MIND Wake");
  // Décision Simulation NLR 6 nov. 04:31 : ⚡ garde son identité ; le fork n'est qu'un contexte.
  expect(prompts[0]!.startsWith("Identité : tu es ⚡")).toBe(true);
  expect(prompts[0]).toContain("=== Contexte : instructions de l'agent de la Room 7 (pas ton identité) ===");
  expect(prompts[0]).toContain("à la troisième personne");
  expect(prompts[0]).not.toContain("le même agent pour ton humain");
  // NLR 6 nov. 04:28 : ⚡ ne prend pas pour lui un message adressé au gardien 🤍.
  expect(prompts[0]).toContain("identifie à qui s'adresse son dernier message");
  expect(prompts[0]).toContain("Ce n'est pas pour moi.");
  expect(prompts[1]).not.toContain("Tu es VOX");
  expect(prompts[1]).toContain("le même agent pour ton humain");
  expect(prompts[1]).not.toContain("gardien 🤍");
  const vox = new SecondThreadStore(forkDir(dataDir, 7));
  const published = vox.entries().filter((e) => e.role === "agent").map((e) => e.text);
  vox.close();
  expect(published).toContain("⚡ réponse rapide : Bonjour.");
  expect(published).not.toContain("⚡ Bonjour.");
});

it("signs a fork's fast reply once", () => {
  expect(signForkFastReply("VOX regarde ça.")).toBe("réponse rapide : VOX regarde ça.");
  expect(signForkFastReply("⚡ réponse rapide : VOX regarde ça.")).toBe("réponse rapide : VOX regarde ça.");
});
