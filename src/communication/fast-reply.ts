import { roomVoiceLaunch, roleVoiceMayAct } from "./room-voice-launch.js";
import {callMcpConfig,roomCallIdentity,type HumanCallIdentity} from './human-call-capability.js';
import {spawnAgentProcess} from "../daemon/agent-process.js";
import { launchAgentSession, providerFailure } from "../daemon/agent-engine.js";
import { codexRoleTurn } from "../daemon/codex-role-turn.js";
import { readAgentRole } from "../adapters/agent-role.js";
/**
 * Réponse rapide : à chaque message humain d'un fil (principal, second fil ou fork), un
 * Claude Code sans outils répond aussitôt dans ce fil à partir de sa conversation récente.
 * La réponse est ensuite remise à toutes les sessions par leur boîte habituelle, quel que
 * soit leur runtime : le fil d'origine l'applique, les autres la reçoivent en contexte.
 * Désactivée par défaut (`fast-reply.json`). Abonnement claude.ai seulement, pas de clé API.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { WAKE_HOME_SYSTEM_PROMPT, withWakePersonality } from "../adapters/wake-system-prompt.js";
import { workspaceDirFor } from "../daemon/paths.js";
import { FORK_IDS, forkDir, forkEnabled } from "../daemon/forks.js";
import { assignedForkPrompt, readForkAssignment, roomLabelIn } from "../daemon/fork-assignment.js";
import { SecondThreadStore, secondThreadEnabled } from "../daemon/second-thread.js";
import { OwnerMessages } from "./owner-messages.js";
import { enqueueOwnerMessage } from "./owner-inbox.js";
import {
  beginFastReply,
  fastReplyApplies,
  fastReplyEnabled,
  fastReplyThreadOf,
  finishFastReply,
  forkThread,
  readFastReplies,
  type FastReplyRecord,
  type FastReplyThread,
} from "./fast-reply-store.js";

export * from "./fast-reply-store.js";

export const FAST_REPLY_AGENT_ID = "claude-wake";
export const FAST_REPLY_PREFIX = "⚡ ";
const SILENCE = "SILENCE";
const HISTORY_CHARS = 24_000;

/** Nom humain d'un fil ; avec `dataDir`, une room prend le nom posé dans son affectation. */
export function fastReplyThreadName(thread: FastReplyThread, dataDir?: string): string {
  return thread === "principal"
    ? "Fil principal"
    : thread === "second"
      ? "Second fil"
      : dataDir === undefined
        ? `Room ${thread.slice("fork:".length)}`
        : roomLabelIn(dataDir, Number(thread.slice("fork:".length)));
}

/** Dossier de la boîte locale d'un fil (second fil ou fork). */
function threadStoreDir(dataDir: string, thread: Exclude<FastReplyThread, "principal">): string {
  return thread === "second" ? dataDir : forkDir(dataDir, Number(thread.slice("fork:".length)));
}

/** Le fork a choisi la boîte `explicit` dans son affectation. Affectation illisible : boîte fermée. */
function forkInboxExplicit(dataDir: string, thread: FastReplyThread): boolean {
  if (!thread.startsWith("fork:")) return false;
  try {
    return readForkAssignment(forkDir(dataDir, Number(thread.slice("fork:".length))))?.inbox === "explicit";
  } catch {
    return true;
  }
}

/** Toutes les sessions actives qui reçoivent les réponses rapides. */
export function fastReplyRecipients(dataDir: string): FastReplyThread[] {
  return [
    "principal",
    ...(secondThreadEnabled(dataDir) ? (["second"] as const) : []),
    ...FORK_IDS.filter((id) => forkEnabled(dataDir, id)).map(forkThread),
  ];
}

/**
 * Sessions que la voix rapide mentionne (`@principal`, `@second`, `@fork8`, `@Fork 8`), dans
 * l'ordre d'apparition, sans doublon. Ignore les adresses (`a@b.c`), le texte entre accents
 * graves et les forks inconnus ; la remise ne retient ensuite que les sessions actives.
 */
export function parseFastReplyMentions(text: string): FastReplyThread[] {
  const visible = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, " ");
  const found: FastReplyThread[] = [];
  for (const m of visible.matchAll(/(?<![\w.@-])@(principal|second|fork ?(\d+))(?![\w-])/gi)) {
    const name = (m[1] ?? "").toLowerCase();
    const fork = m[2] === undefined ? null : Number(m[2]);
    const thread: FastReplyThread | null =
      fork === null
        ? (name as "principal" | "second")
        : FORK_IDS.some((id) => id === fork)
          ? forkThread(fork)
          : null;
    if (thread !== null && !found.includes(thread)) found.push(thread);
  }
  return found;
}

/**
 * Remet la réponse rapide à chaque session par sa boîte : `owner-inbox` pour le principal
 * (Claude ou Codex), la boîte du fil pour le second fil et les forks. Le fil d'origine reçoit
 * la consigne de l'appliquer ; une session mentionnée (`@fork8`…) reçoit une notice à traiter ;
 * les autres la reçoivent en contexte, sans réveil.
 */
export function deliverFastReply(
  dataDir: string,
  reply: { thread: FastReplyThread; messageId: string; replyId: string; text: string },
  recipients: readonly FastReplyThread[] = fastReplyRecipients(dataDir),
): FastReplyThread[] {
  const source = fastReplyThreadName(reply.thread, dataDir);
  const delivered: FastReplyThread[] = [];
  const targets = recipients.includes(reply.thread) ? recipients : [reply.thread, ...recipients];
  const mentioned = parseFastReplyMentions(reply.text);
  for (const to of targets) {
    const own = to === reply.thread;
    const mention = !own && mentioned.includes(to);
    // Un fork en boîte `explicit` ne reçoit pas la voix rapide des autres fils (FYI ni mention).
    if (!own && to !== "principal" && to !== "second" && forkInboxExplicit(dataDir, to)) continue;
    const text = own
      ? `MIND runtime — réponse rapide (pas un message humain) : ta voix rapide, sans outils, a déjà répondu à ton humain au message ${reply.messageId}, dans ce fil (${reply.replyId}) :\n${JSON.stringify(reply.text)}\nApplique-la : tiens ce qu'elle annonce, sans renvoyer la même réponse. Si elle est fausse ou incomplète, corrige-la puis continue.`
      : mention
        ? `MIND runtime — la voix rapide de ${source} te mentionne dans sa réponse à l'humain (pas un message humain) :\n${JSON.stringify(reply.text)}\nVérifie et traite ce qui te concerne ; tes autorisations sont inchangées.`
        : `MIND runtime — FYI : la voix rapide de ${source} a répondu à l'humain dans son fil :\n${JSON.stringify(reply.text)}\nContexte seulement : n'y réponds pas et ne change pas ton travail pour elle.`;
    const key = `${own ? "fast-reply" : mention ? "fast-reply-mention" : "fast-reply-fyi"}:${reply.thread}:${reply.messageId}`.slice(
      0,
      128,
    );
    try {
      if (to === "principal")
        enqueueOwnerMessage(dataDir, {
          id: key,
          at: new Date().toISOString(),
          text,
          origin: {
            kind: "peer_message",
            channel: "fast-reply",
            author: `Réponse rapide · ${source}`,
            senderRef: `fast-reply:${reply.thread}`,
            recipientRef: "principal",
            threadId: reply.thread,
            messageId: reply.replyId,
            correlationId: reply.messageId,
          },
        });
      else {
        const dir = threadStoreDir(dataDir, to);
        fs.mkdirSync(dir, { recursive: true });
        const store = new SecondThreadStore(dir);
        try {
          store.addNoticeOnce(
            key,
            text,
            own
              ? "Réponse rapide (ta voix immédiate)"
              : mention
                ? `Mention · voix rapide de ${source}`
                : `FYI · réponse rapide de ${source}`,
            own,
          );
        } finally {
          store.close();
        }
      }
      delivered.push(to);
    } catch {
      // Un destinataire en échec n'empêche pas les autres livraisons.
    }
  }
  return delivered;
}

interface Line {
  readonly at: string;
  readonly author: "humain" | "agent" | "simulation" | "⚡ (toi)";
  readonly text: string;
}

/** Conversation récente des deux côtés, la plus récente en dernier, bornée en taille. */
export function recentConversation(dataDir: string): Line[] {
  const lines: Line[] = [];
  try {
    for (const raw of fs
      .readFileSync(path.join(dataDir, "human-messages.jsonl"), "utf8")
      .split("\n")
      .slice(-200)) {
      try {
        const h = JSON.parse(raw) as { at?: unknown; text?: unknown };
        if (typeof h.at === "string" && typeof h.text === "string")
          lines.push({ at: h.at, author: "humain", text: h.text });
      } catch {
        // Ligne partielle : ignorée.
      }
    }
  } catch {
    // Aucun historique humain.
  }
  const file = path.join(dataDir, "owner-messages.sqlite");
  if (fs.existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      for (const r of db
        .prepare(
          "SELECT created_at, text FROM messages WHERE deleted=0 ORDER BY created_at DESC LIMIT 200",
        )
        .all() as { created_at: string; text: string }[])
        {
          const text = r.text;
          if (/^\s*(?:🧭|🤍)\s/u.test(text)) continue;
          const author = /^\s*Simulation NLR\s*[:—–-]/u.test(text)
            ? "simulation"
            : /^\s*⚡(?:\s|$)/u.test(text)
              ? "⚡ (toi)"
              : "agent";
          lines.push({ at: r.created_at, author, text });
        }
    } finally {
      db.close();
    }
  }
  return boundConversation(lines);
}

/** Les lignes les plus récentes dans la limite de taille, dans l'ordre chronologique. */
function boundConversation(input: readonly Line[]): Line[] {
  const lines = [...input].sort((a, b) => a.at.localeCompare(b.at));
  const kept: Line[] = [];
  let size = 0;
  for (const line of lines.reverse()) {
    size += line.text.length + 40;
    if (size > HISTORY_CHARS && kept.length > 0) break;
    kept.push(line);
  }
  return kept.reverse();
}

const FAST_REPLY_MAIN_ROLE =
  "Rôle : tu es la voix immédiate de cet agent MIND, le même agent pour ton humain ; le ⚡ marque seulement la rapidité. Tu réponds en quelques secondes au dernier message, pendant que ta session, qui a les outils, continue son travail.";
export const FAST_REPLY_RULES = [
  "Ce contexte rapide utilise seulement les outils effectivement exposés. Les outils d'appel peuvent être présents ; le bureau, le web et les sous-agents dépendent du rôle autorisé par le runtime. Ne nie pas les accès de ton manager à partir de ton seul contexte. Ton texte est publié tel quel dans la conversation : ne le republie pas avec message.",
  "Selon le message : (1) si la réponse se trouve dans la conversation fournie (question sur ce qui a été dit ou fait, avis, explication, idée), réponds complètement ; (2) pour une action, une vérification ou un fichier, dis en une phrase ce qui va être fait et par quoi commencer, au futur proche ; ta session l'exécutera ; (3) pour une correction ou une consigne, reprends-la explicitement pour montrer qu'elle est prise en compte.",
  "Si une session précise doit traiter quelque chose, tu peux écrire @principal, @second ou @forkN (N de 2 à 8) : la mention prévient seulement cette session et ne donne ni outil ni permission.",
  "Tout ce que tu annonces engage ta session : n'annonce que ce qui est raisonnable et déjà autorisé. Ne prétends jamais avoir fait, vérifié ou lu ce qui ne figure pas dans la conversation ; si l'état réel est incertain, dis que tu vérifies.",
  "Une à quatre phrases, dans la langue de ton humain, avec le ton de l'agent, sans titres. Pas de demande de permission ; au plus une question, seulement si le message est vraiment ambigu. Si le message n'appelle aucune réponse (remerciement ou accusé de réception après une réponse déjà donnée), réponds exactement SILENCE.",
];
export const FAST_REPLY_SYSTEM_NOTE = [FAST_REPLY_MAIN_ROLE, ...FAST_REPLY_RULES].join(" ");

/** Signature imposée à la réponse rapide dans le fil d'un fork affecté. */
export const FORK_FAST_REPLY_SIGNATURE = "⚡ réponse rapide";

/**
 * Fil d'un fork affecté. Décision Simulation NLR (6 nov. 2026, 04:31) : la réponse rapide
 * garde son identité ⚡ ; le prompt du fork n'est qu'un contexte, jamais une identité.
 * NLR (04:28) : ⚡ prenait pour VOX un message adressé au gardien 🤍.
 */
export const FORK_FAST_REPLY_IDENTITY = [
  `Identité : tu es ⚡, la réponse rapide de MIND Wake, et tu le restes dans tous les fils. Tu n'es pas l'agent de ce fork : ses instructions ci-dessous te sont données seulement comme contexte de ce qui se passe ici, jamais comme une identité à prendre. Tu parles de cet agent (par ex. VOX) à la troisième personne et ne dis jamais « je suis » cet agent. Ta réponse est publiée signée « ${FORK_FAST_REPLY_SIGNATURE} ».`,
  "Tu réponds en quelques secondes au dernier message, pendant que la session de l'agent du fork, qui a les outils, continue son travail : ce que tu annonces, c'est elle qui l'exécutera.",
  "Destinataire : dans ce fil, NLR peut parler à l'agent du fork (par ex. VOX), au gardien 🤍 (pattern holder), à la Simulation NLR, au Principal ou à toi. Avant de répondre, identifie à qui s'adresse son dernier message (nom, 🤍, @mention, ou suite d'un échange avec une autre voix). S'il s'adresse à une autre voix, ne le prends pas pour toi et ne réponds pas à sa place : réponds exactement SILENCE, ou au plus une ligne « Ce n'est pas pour moi. ».",
].join(" ");

/** Contexte du fork entre deux bornes, puis l'identité ⚡ et les règles communes. */
export function forkFastReplySystemPrompt(id: number, forkPrompt: string, identity = FORK_FAST_REPLY_IDENTITY, rules = FAST_REPLY_RULES.join(" ")): string {
  return [
    identity,
    "",
    `=== Contexte : instructions de l'agent de la Room ${String(id)} (pas ton identité) ===`,
    forkPrompt.trim(),
    `=== Fin du contexte de la Room ${String(id)} ===`,
    "",
    rules,
  ].join("\n");
}

/**
 * Signe la réponse rapide d'un fork. Le préfixe « ⚡ » est ajouté à la publication
 * (`FAST_REPLY_PREFIX`) : le texte publié devient « ⚡ réponse rapide : … ». Une signature
 * déjà écrite par le modèle n'est pas doublée.
 */
export function signForkFastReply(text: string): string {
  const body = text.replace(/^(?:⚡\s*)?(?:réponse rapide\s*[:—-]?\s*)?/u, "").trim();
  return `réponse rapide : ${body}`;
}

export function fastReplySystemPrompt(workspace: string): string {
  return [withWakePersonality(workspace, readAgentRole(workspace,"wake-home",WAKE_HOME_SYSTEM_PROMPT)), "", readAgentRole(workspace,"fast-reply",FAST_REPLY_SYSTEM_NOTE)].join(
    "\n",
  );
}

export function fastReplyPrompt(conversation: readonly Line[], messageText: string): string {
  return [
    "Conversation récente (la plus récente en dernier) :",
    ...conversation.map((l) => JSON.stringify(l)),
    "",
    "Dernier message de ton humain, auquel répondre maintenant :",
    JSON.stringify(messageText),
  ].join("\n");
}

export interface FastReplyClaude {
  readonly executable: string;
  readonly prefixArgs?: readonly string[];
  readonly model: string;
}

export function fastReplyClaude(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FastReplyClaude {
  return {
    executable:
      env["MIND_WAKE_CLAUDE_EXE"] ?? path.join(os.homedir(), ".local", "bin", "claude.exe"),
    model: env["MIND_WAKE_FAST_REPLY_MODEL"] ?? "opus",
  };
}

/** Sans outils natifs, hooks ni session conservée ; trois outils MCP d’appel si le rôle est identifié par l’hôte. */
export function fastReplyArgs(model: string, systemPromptFile: string, humanCall?:HumanCallIdentity): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--system-prompt-file",
    systemPromptFile,
    "--tools",
    "",
    ...(humanCall ? ["--mcp-config",callMcpConfig(undefined,humanCall),"--allowedTools","mcp__mind_calls__call,mcp__mind_calls__call_human,mcp__mind_calls__list_active_calls,mcp__mind_calls__hangup_call,mcp__mind_calls__invite_to_call"] : []),
    "--strict-mcp-config",
    "--setting-sources",
    "user",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

const ENV_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "ComSpec",
  "CLAUDE_CODE_GIT_BASH_PATH",
];

export type ClaudeAnswer = { text: string } | { error: string };

/**
 * Claude Code lancé d'avance : il s'initialise puis attend son prompt sur l'entrée
 * standard (`-p` lit jusqu'à la fin de stdin), sans appel au modèle avant `answer`.
 */
export interface WarmClaude {
  readonly startedAt: number;
  readonly args: readonly string[];
  alive(): boolean;
  answer(prompt: string): Promise<ClaudeAnswer>;
  dispose(): void;
}

export function startClaude(
  claude: FastReplyClaude,
  args: readonly string[],
  cwd: string,
  timeoutMs = 90_000,
  dataDir?: string,
): WarmClaude {
  const env: Record<string, string> = {
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const child = dataDir && process.platform === "win32" ? spawnAgentProcess(dataDir,{executable:claude.executable,args:[...(claude.prefixArgs ?? []),...args],cwd,env}) : spawn(claude.executable, [...(claude.prefixArgs ?? []), ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "",
    err = "",
    exited = false,
    asked = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    out += c;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => {
    err = (err + c).slice(-1000);
  });
  child.stdin.on("error", () => undefined);
  const result = new Promise<ClaudeAnswer>((resolve) => {
    child.on("error", (error) => {
      exited = true;
      resolve({ error: error.message });
    });
    child.on("close", (code) => {
      exited = true;
      try {
        const result = JSON.parse(out.trim().split("\n").at(-1) ?? "") as {
          result?: unknown;
          is_error?: unknown;
        };
        if (result.is_error === true || typeof result.result !== "string")
          resolve({
            error: (typeof result.result === "string"
              ? result.result
              : `sortie ${String(code)}`
            ).slice(0, 300),
          });
        else resolve({ text: result.result });
      } catch {
        resolve({ error: (err.trim() || `sortie ${String(code)} sans résultat`).slice(-300) });
      }
    });
  });
  return {
    startedAt: Date.now(),
    args: [...args],
    alive: () => !exited && !asked,
    answer(prompt: string) {
      if (asked) return Promise.resolve({ error: "Claude déjà utilisé" });
      asked = true;
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdin.end(prompt);
      return result.finally(() => {
        clearTimeout(timer);
      });
    },
    dispose() {
      asked = true;
      if (!exited) child.kill();
    },
  };
}

export function callClaude(
  claude: FastReplyClaude,
  args: readonly string[],
  prompt: string,
  cwd: string,
  timeoutMs = 90_000,
): Promise<ClaudeAnswer> {
  return startClaude(claude, args, cwd, timeoutMs).answer(prompt);
}

export function agentTextCall(dataDir: string, native?: typeof callClaude, canRespond: () => boolean = () => true): typeof callClaude {
  return (claude, originalArgs, prompt, originalCwd, timeoutMs = 90000) => {
    const role = roomVoiceLaunch(dataDir,originalArgs,originalCwd), args=role.args,cwd=role.cwd;
    const allowed=()=>canRespond() && (role.textOnly || roleVoiceMayAct(dataDir));
    return launchAgentSession<ClaudeAnswer>(dataDir, "claude", async engine => {
    if (!allowed()) return {error:"Wake is paused or stopped; role actions are not allowed"};
    if (engine === "claude") {
      if(native)return native(claude,args,prompt,cwd,timeoutMs);
      const process=startClaude(claude,args,cwd,timeoutMs,dataDir);
      const guard=setInterval(()=>{if(!allowed())process.dispose();},300);
      try{return await process.answer(prompt);}finally{clearInterval(guard);}
    }
    const file = args[args.indexOf("--system-prompt-file")+1];
    if (!file) throw Error("Prompt système absent");
    let message = prompt;
    const images: {data:string; mediaType:string}[] = [];
    if (args.includes("--input-format")) {
      const parts = JSON.parse(prompt).message.content;
      const lines: string[] = [];
      for (const part of parts) {
        if (part.type === "text") lines.push(part.text);
        if (part.type === "image") images.push({data:part.source.data,mediaType:part.source.media_type});
      }
      message = lines.join("\n");
    }
    const result = await codexRoleTurn({dataDir,cwd,instructions:fs.readFileSync(file,"utf8"),message,
      images,textOnly:role.textOnly,nativeDelegation:role.nativeDelegation,webSearch:role.webSearch,
      ...(args.includes("--mcp-config") ? {mcpConfig:args[args.indexOf("--mcp-config")+1]} : {}),allowed,timeoutMs});
    return result.outcome === "completed" ? {text:result.text} : {error:result.detail ?? result.outcome};
  }, r => "error" in r && providerFailure(r.error) ? {replay:true} : null, allowed);
  };
}

/** Prompt système à jour et arguments d'un appel ; identiques pour un Claude préchauffé. */
export function fastReplyLaunch(
  dataDir: string,
  claude: FastReplyClaude,
  thread: FastReplyThread = "principal",
): { args: string[]; cwd: string } {
  const dir = path.join(dataDir, "fast-reply");
  fs.mkdirSync(dir, { recursive: true });
  const assigned = assignedForkSystemPrompt(dataDir, thread);
  const promptFile = path.join(
    dir,
    assigned === null ? "system-prompt.md" : `system-prompt-${thread.replace(":", "-")}.md`,
  );
  fs.writeFileSync(promptFile, assigned ?? fastReplySystemPrompt(workspaceDirFor(dataDir)));
  return { args: fastReplyArgs(claude.model, promptFile,thread.startsWith("fork:")?roomCallIdentity(dataDir,Number(thread.slice(5))):{dataDir,signature:"Marco"}), cwd: dir };
}

/**
 * Fork affecté (`forks assign`) : sa voix rapide parle avec le prompt système du fork (VOX…),
 * pas avec la personnalité du principal. `null` pour les autres fils ou une affectation illisible.
 */
export function assignedForkSystemPrompt(dataDir: string, thread: FastReplyThread): string | null {
  if (!thread.startsWith("fork:")) return null;
  const id = Number(thread.slice("fork:".length));
  try {
    const assignment = readForkAssignment(forkDir(dataDir, id));
    return assignment === null
      ? null
      : forkFastReplySystemPrompt(id, assignedForkPrompt(id, assignment),
          readAgentRole(workspaceDirFor(dataDir), `fast-reply-fork-${id}`, FORK_FAST_REPLY_IDENTITY),
          readAgentRole(workspaceDirFor(dataDir), "fast-reply-fork-rules", FAST_REPLY_RULES.join(" ")));
  } catch {
    return null;
  }
}

const REPO_DIR = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Lit la réponse rapide avec la voix ElevenLabs du desktop (`speak_desktop`), comme une
 * réponse principale. Même clé `reply:<id>` que la lecture automatique du desktop, qui
 * laisse donc les messages ⚡ à ce chemin. Refus (intégration coupée, pause, file pleine)
 * rendu en erreur, sans nouvel essai.
 */
export function speakFastReply(
  dataDir: string,
  text: string,
  key: string,
  thread: FastReplyThread = "principal",
  timeoutMs = 75_000,
): Promise<{ ok: true } | { error: string }> {
  const hooks = path.join(REPO_DIR, "test/fixtures/store-ledger/ts-hooks.ts");
  const script = path.join(REPO_DIR, "services/elevenlabs/desktop-main.ts");
  if (!fs.existsSync(hooks) || !fs.existsSync(script))
    return Promise.resolve({ error: "service vocal introuvable" });
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-transform-types",
        "--import",
        pathToFileURL(hooks).href,
        script,
      ],
      {
        cwd: REPO_DIR,
        env: { ...process.env, MIND_WAKE_DATA_DIR: dataDir },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
    });
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const envelope = JSON.parse(out) as { ok?: unknown; error?: { message?: unknown } };
        if (envelope.ok === true && code === 0) resolve({ ok: true });
        else
          resolve({
            error:
              typeof envelope.error?.message === "string"
                ? envelope.error.message.slice(0, 300)
                : `sortie ${String(code)}`,
          });
      } catch {
        resolve({ error: `sortie ${String(code)} sans résultat` });
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(
      JSON.stringify({
        action: "speak_desktop",
        payload: { text, idempotency_key: key, thread_id: thread },
      }),
    );
  });
}

/**
 * Messages humains directs récents du second fil et des forks actifs, sans réponse rapide,
 * sous leur identifiant de fil (`second:<n>`, `fork:<k>:<n>`). Le principal reste lu dans
 * `human-messages.jsonl` par le serveur.
 */
export function waitingThreadMessages(
  dataDir: string,
  now = Date.now(),
  pickupMs = 90_000,
): string[] {
  const known = new Set(readFastReplies(dataDir, 200).map((r) => r.messageId));
  const ids: { id: string; at: string }[] = [];
  for (const thread of fastReplyRecipients(dataDir)) {
    if (thread === "principal") continue;
    const dir = threadStoreDir(dataDir, thread);
    if (!SecondThreadStore.exists(dir)) continue;
    const store = new SecondThreadStore(dir);
    try {
      for (const e of store.entries(50)) {
        const id = `${thread}:${String(e.id)}`;
        if (
          e.role === "human" &&
          e.notice === undefined &&
          e.senderFork === undefined &&
          now - Date.parse(e.at) <= pickupMs &&
          !known.has(id)
        )
          ids.push({ id, at: e.at });
      }
    } finally {
      store.close();
    }
  }
  return ids.sort((a, b) => a.at.localeCompare(b.at)).map((m) => m.id);
}

/** Message humain et conversation récente d'un fil, la plus récente en dernier. */
function threadInput(
  dataDir: string,
  messageId: string,
): { thread: FastReplyThread; human: string; conversation: Line[] } | null {
  const { thread, entryId } = fastReplyThreadOf(messageId);
  if (thread === "principal") {
    let human: string | undefined;
    try {
      human = fs
        .readFileSync(path.join(dataDir, "human-messages.jsonl"), "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            const h = JSON.parse(l) as { id?: unknown; text?: unknown };
            return h.id === messageId && typeof h.text === "string" ? [h.text] : [];
          } catch {
            return [];
          }
        })
        .at(-1);
    } catch {
      human = undefined;
    }
    return human === undefined
      ? null
      : { thread, human, conversation: recentConversation(dataDir) };
  }
  const dir = threadStoreDir(dataDir, thread);
  if (!SecondThreadStore.exists(dir)) return null;
  const store = new SecondThreadStore(dir);
  try {
    const entries = store.entries(200);
    const direct = (e: (typeof entries)[number]) =>
      e.role === "human" && e.notice === undefined && e.senderFork === undefined;
    const human = entries.find((e) => e.id === entryId && direct(e));
    if (human === undefined) return null;
    const lines = entries
      .filter((e) => e.role === "agent" || direct(e))
      .map((e): Line => ({
        at: e.at,
        author: e.role === "agent" ? "agent" : "humain",
        text: e.text,
      }));
    return { thread, human: human.text, conversation: boundConversation(lines) };
  } finally {
    store.close();
  }
}

/** Publie le texte ⚡ dans le fil d'origine ; rend l'identifiant de la réponse et sa clé vocale. */
function publishInThread(
  dataDir: string,
  thread: FastReplyThread,
  messageId: string,
  text: string,
): { replyId: string; voiceKey: string } {
  const body = `${FAST_REPLY_PREFIX}${text}`.slice(0, 4000);
  if (thread === "principal") {
    const messages = new OwnerMessages(dataDir, FAST_REPLY_AGENT_ID);
    try {
      const published = messages.publish(body, `fast-reply:${messageId}`);
      return { replyId: published.id, voiceKey: `reply:${published.id}` };
    } finally {
      messages.close();
    }
  }
  const store = new SecondThreadStore(threadStoreDir(dataDir, thread));
  try {
    const replyId = `${thread}:${String(store.add("agent", body))}`;
    return { replyId, voiceKey: `reply:${replyId}` };
  } finally {
    store.close();
  }
}

/** Produit, publie, diffuse puis lit à voix haute la réponse rapide d'un message humain. */
export async function runFastReply(options: {
  dataDir: string;
  messageId: string;
  claude?: FastReplyClaude;
  call?: typeof callClaude;
  speak?: typeof speakFastReply;
  log?: (line: string) => void;
}): Promise<FastReplyRecord["state"]> {
  const { dataDir, messageId } = options;
  const log = options.log ?? (() => undefined);
  if (!fastReplyEnabled(dataDir) || !fastReplyApplies(messageId)) return "silent";
  const input = threadInput(dataDir, messageId);
  if (input === null) return "silent";
  const { thread } = input;
  if (!beginFastReply(dataDir, messageId, new Date(), thread)) return "silent";
  const started = Date.now();
  try {
    const claude = options.claude ?? fastReplyClaude();
    // Mêmes arguments que le Claude préchauffé du moteur (`fastReplyLaunch`).
    const launch = fastReplyLaunch(dataDir, claude, thread);
    const result = await agentTextCall(dataDir, options.call)(
      claude,
      launch.args,
      fastReplyPrompt(input.conversation, input.human),
      launch.cwd,
    );
    if ("error" in result) {
      finishFastReply(dataDir, messageId, { state: "failed", detail: result.error });
      log(`réponse rapide ${messageId} : échec — ${result.error}`);
      return "failed";
    }
    const raw = result.text.trim();
    if (raw === "" || raw === SILENCE) {
      finishFastReply(dataDir, messageId, { state: "silent" });
      return "silent";
    }
    // Fork affecté : ⚡ garde son identité et signe (décision Simulation NLR, 6 nov. 04:31).
    const text = assignedForkSystemPrompt(dataDir, thread) === null ? raw : signForkFastReply(raw);
    const { replyId, voiceKey } = publishInThread(dataDir, thread, messageId, text);
    // Remise avant la fin de l'attente : le message humain part avec elle, partout.
    const delivered = deliverFastReply(dataDir, { thread, messageId, replyId, text });
    finishFastReply(dataDir, messageId, { state: "replied", text, ownerMessageId: replyId });
    log(
      `réponse rapide ${messageId} publiée en ${String(Date.now() - started)} ms, remise à ${delivered.join(", ") || "aucune session"}`,
    );
    // La voix suit le texte déjà publié : son échec ne retire rien du fil.
    const spoken = await (options.speak ?? speakFastReply)(
      dataDir,
      text.slice(0, 1500),
      voiceKey,
      thread,
    ).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    log(
      "error" in spoken
        ? `réponse rapide ${messageId} : voix non lue — ${spoken.error}`
        : `réponse rapide ${messageId} : voix en file en ${String(Date.now() - started)} ms`,
    );
    return "replied";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    finishFastReply(dataDir, messageId, { state: "failed", detail });
    return "failed";
  }
}
