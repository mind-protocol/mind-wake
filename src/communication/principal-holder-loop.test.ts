import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { holderEditingPrompt, runPrincipalHolders } from "./principal-holder-loop.js";
import { preparePrincipalCorpus, principalNativeHistory, withPrincipalReconstruction } from "./fil-continuity.js";
import { setEngineChoice } from "../daemon/agent-engine.js";
import { loadPatternHolders, savePatternHoldersEnabled } from "./pattern-holders.js";
import { OwnerMessages } from "./owner-messages.js";
import { enqueueOwnerMessage } from "./owner-inbox.js";
import { holderLiveHook } from "./holder-live-inbox.js";
import { recordPrincipalOutput } from "./principal-outputs.js";
import { readPrincipalThread } from "./principal-thread-view.js";

let root: string;
let workspace: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "principal-holder-loop-"));
  workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "artifacts/principal"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "artifacts/pattern-holders"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "artifacts/principal/01.md"), "**Principal —** Résultat du principal.");
  setEngineChoice(root, "claude");
  savePatternHoldersEnabled(root, true);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function holder(slug: string, room: number | null = 1) {
  fs.writeFileSync(path.join(workspace, "artifacts/pattern-holders", `${slug}.md`),
    '```json pattern-holder\n' + JSON.stringify({ name: slug, emoji: "🧭", ...(room === null ? {} : { room }) }) + '\n```\n**' + slug + ' —** Mon pattern.');
}

it("reloads shared system instructions for both principal and editing holders", () => {
  holder("alpha");
  const agent = loadPatternHolders(root).holders[0];
  if (!agent) throw Error("Missing holder");
  const shared = path.join(workspace, "artifacts/pattern-holders/_commun");
  fs.mkdirSync(shared);
  const file = path.join(shared, "fonctionnement.md");
  fs.writeFileSync(file, "Consigne commune version A");
  expect(holderEditingPrompt(agent, workspace)).toContain("Consigne commune version A");
  expect(withPrincipalReconstruction(root, workspace, "Rôle principal")).toContain("Consigne commune version A");
  fs.writeFileSync(file, "Consigne commune version B");
  expect(holderEditingPrompt(agent, workspace)).toContain("Consigne commune version B");
  expect(withPrincipalReconstruction(root, workspace, "Rôle principal")).toContain("Consigne commune version B");
});

it("starts every principal-room holder in parallel, waits for all and never publishes their output", async () => {
  holder("alpha"); holder("beta", 1); holder("ailleurs", 2); holder("reveilleur"); holder("unassigned", null);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  let finished = false;
  const pass = runPrincipalHolders({ dataDir: root, allowed: () => true, call: async (_claude, args, _prompt, cwd) => {
    expect(cwd).toBe(workspace);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    const promptFile = args[args.indexOf("--system-prompt-file") + 1];
    if (!promptFile) throw Error("Missing system prompt");
    const prompt = fs.readFileSync(promptFile, "utf8");
    expect(prompt).not.toContain("n'envoie et ne publie aucun message");
    expect(prompt).toContain("Tu peux répondre à l'humain et échanger avec les agents");
    expect(prompt).not.toContain("ligne par ligne");
    const transcriptFile = args[args.indexOf("--resume") + 1];
    if (!transcriptFile) throw Error("Missing native transcript");
    const transcript = fs.readFileSync(transcriptFile, "utf8");
    expect(transcript).toContain("Résultat du principal");
    started.push(path.basename(path.dirname(promptFile)));
    await gate;
    fs.writeFileSync(path.join(workspace, "artifacts/principal", `${String(started.length)}-${path.basename(path.dirname(promptFile))}.md`), "**Coach —** Pattern intégré.");
    return { text: "NE PAS PUBLIER" };
  } }).then(() => { finished = true; });
  expect(started.sort()).toEqual(["alpha", "beta"]);
  expect(finished).toBe(false);
  release(); await pass;
  expect(finished).toBe(true);
  expect(fs.existsSync(path.join(root, "owner-messages.sqlite"))).toBe(false);
  expect(fs.existsSync(path.join(root, "owner-inbox.sqlite"))).toBe(false);
  expect(fs.existsSync(path.join(root, "principal-outputs.sqlite"))).toBe(false);
});

it("does not launch when stopped or disabled", async () => {
  holder("alpha");
  let calls = 0;
  const call = () => { calls++; return Promise.resolve({ text: "" }); };
  await runPrincipalHolders({ dataDir: root, allowed: () => false, call });
  savePatternHoldersEnabled(root, false);
  await runPrincipalHolders({ dataDir: root, allowed: () => true, call });
  expect(calls).toBe(0);
});

it("refreshes the principal snapshot and delivers a setup-time arrival to every holder", async () => {
  holder("alpha"); holder("beta");
  enqueueOwnerMessage(root, { id: "during-principal", at: "2026-11-20T10:00:00Z", text: "Correction pendant le principal" });
  const received: string[] = [];
  const transcripts: string[] = [];
  await runPrincipalHolders({ dataDir: root, allowed: () => true, call: (_claude, args) => {
    const sessionId = args[args.indexOf("--session-id") + 1];
    const prompt = args[args.indexOf("--system-prompt-file") + 1];
    const transcript = args[args.indexOf("--resume") + 1];
    if (!sessionId || !prompt || !transcript) throw Error("Missing native launch settings");
    transcripts.push(fs.readFileSync(transcript, "utf8"));
    if (!received.length) enqueueOwnerMessage(root, { id: "during-holders", at: "2026-11-20T10:01:00Z", text: "Correction pendant les holders" });
    received.push(JSON.stringify(holderLiveHook({ dataDir: root, sessionId,
      stateFile: path.join(path.dirname(prompt), `inbox-${sessionId}.json`) },
    { session_id: sessionId, hook_event_name: "PostToolUse" })));
    return Promise.resolve({ text: "" });
  } });
  expect(transcripts).toHaveLength(2);
  expect(transcripts.every(text => text.includes("Correction pendant le principal"))).toBe(true);
  expect(received).toHaveLength(2);
  expect(received.every(text => text.includes("Correction pendant les holders"))).toBe(true);
  expect(received.every(text => !text.includes("Correction pendant le principal"))).toBe(true);
});

it("isolates a holder failure and waits for the other holder", async () => {
  holder("alpha"); holder("beta");
  let calls = 0;
  const logs: string[] = [];
  await runPrincipalHolders({ dataDir: root, allowed: () => true, log: line => logs.push(line), call: async () => {
    calls++;
    if (calls === 1) throw Error("holder failed");
    await Promise.resolve();
    return { text: "" };
  } });
  expect(calls).toBe(2);
  expect(logs.some(line => line.includes("holder failed"))).toBe(true);
  expect(logs.some(line => line.includes("beta : passage"))).toBe(true);
});

it("injects the edited corpus on the next wake without resurrecting removed source turns", () => {
  const source = path.join(root, "human-messages.jsonl");
  fs.writeFileSync(source, JSON.stringify({ id: "first", at: "2026-11-20T10:00:00Z", text: "Ancienne formulation longue" }) + "\n");
  preparePrincipalCorpus(root, workspace, "principal");
  const fil = path.join(workspace, "artifacts/principal/90-fil.md");
  expect(fs.readFileSync(fil, "utf8")).toContain("Ancienne formulation longue");
  fs.writeFileSync(fil, "**Critique —** Version resserrée.\n");
  fs.appendFileSync(source, JSON.stringify({ id: "second", at: "2026-11-20T11:00:00Z", text: "Nouvelle demande" }) + "\n");
  const history = principalNativeHistory(root, workspace, "principal");
  expect(history.some(turn => turn.text.includes("Ancienne formulation"))).toBe(false);
  expect(history.some(turn => turn.text === "Version resserrée." && turn.role === "user")).toBe(true);
  expect(history.some(turn => turn.text === "Résultat du principal." && turn.role === "assistant")).toBe(true);
  expect(history.filter(turn => turn.text === "Nouvelle demande")).toHaveLength(1);
  expect(principalNativeHistory(root, workspace, "principal")).toEqual(history);
});

it("preserves a renamed principal and cannot turn a quoted human passage into its speech", () => {
  fs.writeFileSync(path.join(workspace, "artifacts/principal/_principal.md"), '```json principal\n{"name":"Aube"}\n```');
  const messages = new OwnerMessages(root, "custom-agent");
  try { messages.publish("Ma réponse", "own-original"); } finally { messages.close(); }
  fs.writeFileSync(path.join(root, "human-messages.jsonl"), JSON.stringify({
    id: "quoted", at: "2026-11-20T10:00:00Z", text: "Voici une citation :\n**Aube —** Pas une vraie réponse.",
  }) + "\n");
  preparePrincipalCorpus(root, workspace, "custom-agent");
  const history = principalNativeHistory(root, workspace, "custom-agent");
  expect(history.some(turn => turn.text === "Ma réponse" && turn.role === "assistant")).toBe(true);
  expect(history.filter(turn => turn.role === "assistant").some(turn => turn.text.includes("Pas une vraie réponse"))).toBe(false);
});

it("does not import new publications from call services or legacy agent channels into the editable corpus", () => {
  preparePrincipalCorpus(root, workspace, "principal");
  const messages = new OwnerMessages(root, "claude-wake");
  try { messages.publish("Salut depuis l'appel", "call-opening:test"); } finally { messages.close(); }
  enqueueOwnerMessage(root, { id: "human-correction", at: "2026-11-20T19:00:00Z", text: "Ma nouvelle demande" });
  const history = principalNativeHistory(root, workspace, "principal");
  expect(history.some(turn => turn.text.includes("Salut depuis l'appel"))).toBe(false);
  expect(history.some(turn => turn.text === "Ma nouvelle demande")).toBe(true);
});

it("imports human and published messages into the fil, but never the principal's end-of-turn outputs", () => {
  const messages = new OwnerMessages(root, "principal");
  try { messages.publish("Message publié par le principal", "own-published"); } finally { messages.close(); }
  recordPrincipalOutput(root, { id: "claude:s:t1", at: "2026-11-20T10:01:00Z", text: "Compte rendu de fin de tour qui redit tout." });
  enqueueOwnerMessage(root, { id: "human-1", at: "2026-11-20T10:02:00Z", text: "Une demande de NLR" });
  preparePrincipalCorpus(root, workspace, "principal");
  const fil = fs.readFileSync(path.join(workspace, "artifacts/principal/90-fil.md"), "utf8");
  expect(fil).toContain("Message publié par le principal");
  expect(fil).toContain("Une demande de NLR");
  expect(fil).not.toContain("Compte rendu de fin de tour");
  expect(fil).not.toContain("principal-output:");
  expect(principalNativeHistory(root, workspace, "principal").some(t => t.text.includes("Compte rendu de fin de tour"))).toBe(false);
});

it("keeps only NLR's sentence from a voice-call message and skips call-ring notices", () => {
  preparePrincipalCorpus(root, workspace, "principal");
  enqueueOwnerMessage(root, { id: "chat-1", at: "2026-11-20T18:00:00Z",
    text: "[Appel vocal en cours] Réponds vite, à l'oral, en plusieurs messages courts : d'abord ce que tu vas faire. Pas de listes ni de markdown.\n\nFais-les aller tout en bas." });
  enqueueOwnerMessage(root, { id: "fast-reply-fyi:call-ring:abc", at: "2026-11-20T18:00:01Z", text: "[Appel] 📞 NLR t'appelle — prépare-toi à décrocher (appel abc)." });
  preparePrincipalCorpus(root, workspace, "principal");
  const fil = fs.readFileSync(path.join(workspace, "artifacts/principal/90-fil.md"), "utf8");
  expect(fil).toContain("**Humain —** Fais-les aller tout en bas.");
  expect(fil).not.toContain("Appel vocal en cours");
  expect(fil).not.toContain("t'appelle");
});

it("writes each imported source as an invisible comment that the thread view still reads", () => {
  enqueueOwnerMessage(root, { id: "human-2", at: "2026-11-20T10:02:00Z", text: "Bonjour" });
  preparePrincipalCorpus(root, workspace, "principal");
  const fil = fs.readFileSync(path.join(workspace, "artifacts/principal/90-fil.md"), "utf8");
  expect(fil).toContain("<!-- source : 2026-11-20T10:02:00Z (human-2) -->");
  expect(fil).not.toContain("Source historique");
  const item = readPrincipalThread(workspace)?.items.find(i => i.text === "Bonjour");
  expect(item).toMatchObject({ id: "principal:90-fil.md:human-2", at: "2026-11-20T10:02:00Z" });
});

it("tells the principal that its final output is not added to the fil", () => {
  expect(withPrincipalReconstruction(root, workspace, "Rôle")).toContain("Ta sortie finale n'est pas ajoutée au fil ; écris toi-même dans le fil ce qui doit y rester.");
});
