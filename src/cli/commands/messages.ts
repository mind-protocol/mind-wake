/**
 * Fil entre l'humain et son agent Wake, sans hub ni réseau (onglet « Messages » du
 * desktop, ADR-007).
 *
 * - Agent → humain : la note `artifacts/questions-for-human.md` que l'agent tient dans son
 *   espace. Contenu non fiable, rendu tel quel (borné), sans autorité.
 * - Humain → agent : `reply` enregistre d'abord la réponse dans `human-messages.jsonl`,
 *   dans le dossier de données hors de l'espace d'exploration (registre qui fait foi),
 *   puis la recopie dans un bloc balisé de la note, que l'agent relit au réveil suivant.
 *   La file locale permet aussi l'injection dans une session Claude active. Le desktop
 *   demande ensuite un réveil ; la CLI `reply` seule ne démarre pas de daemon.
 */

import { readOwnerMessages, type OwnerMessage } from "../../communication/owner-messages.js";
import { readPublicActivity, type PublicActivity } from "../../communication/public-activity.js";
import { readMessageWait, type MessageWait } from "../../communication/runtime-activity.js";
import { enqueueOwnerMessage, readOwnerMessage, readOwnerReceipts } from "../../communication/owner-inbox.js";
import { readRepoConversations, type RepoConversation } from "../../communication/repo-conversations.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { artifactsDirFor } from "../../daemon/paths.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { NO_PROFILE_HINT, withReadStore } from "./read.js";
import { captureClickPoint, captureWakeScreenshot } from "../../daemon/wake-screenshot.js";
import { freshTargetedClick, pointReplyText } from "../point-context.js";
import { freshWakeImage } from "../../adapters/wake-image.js";
import { latestDaemonRun } from "../../daemon/runs.js";
import { ownerAttachmentRuntimeMatches } from "../../communication/owner-attachment-runtime.js";

export const AGENT_NOTE_FILE = "questions-for-human.md";
export const HUMAN_LOG_FILE = "human-messages.jsonl";
export const MAX_REPLY_CHARS = 4000;
const MAX_NOTE_CHARS = 20_000;
const MAX_REPLIES = 200;
const BLOCK_START = "<!-- mind-wake:reponse-humain";
const BLOCK_END = "<!-- /mind-wake:reponse-humain -->";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface HumanReply {
  readonly id: string;
  readonly at: string;
  readonly text: string;
  readonly screenshotAt?: string;
}

/** Ligne du registre : la date de la note avant recopie distingue Wake de l'agent. */
interface LogEntry extends HumanReply {
  readonly noteMtimeBeforeMs: number | null;
}

export interface MessagesData {
  readonly publicActivity?: readonly PublicActivity[];
  readonly profileId: string | null;
  readonly hint: string | null;
  readonly agentNote: {
    readonly file: string;
    readonly updatedAt: string;
    readonly text: string;
    readonly truncated: boolean;
    readonly trust: "untrusted_agent_content";
  } | null;
  readonly replies: readonly HumanReply[];
  readonly agentMessages?: readonly OwnerMessage[];
  readonly repoThreads?: readonly RepoConversation[];
  readonly deliveryReceipts?: Readonly<Record<string, string>>;
  readonly messageWait?: MessageWait | null;
  readonly agentStatus?: { readonly state: string; readonly reason: string; readonly nextWakeAt: string | null } | null;
}

export interface ReplyData {
  readonly status: "recorded" | "duplicate" | "refused";
  readonly reply: HumanReply | null;
  readonly mirrored: boolean;
  readonly detail: string;
}

function profileExists(ctx: CliContext, dataDir: DataDir): boolean {
  return withReadStore(ctx, dataDir, ({ uow }) => uow?.profiles.get(DEFAULT_PROFILE_ID) != null);
}

function notePath(dataDir: DataDir): string {
  return path.join(artifactsDirFor(dataDir.path), AGENT_NOTE_FILE);
}

/** Retire les blocs de réponse recopiés : la note rendue est le seul texte de l'agent. */
export function agentText(note: string): string {
  let out = "";
  let rest = note;
  for (;;) {
    const start = rest.indexOf(BLOCK_START);
    if (start === -1) return (out + rest).trim();
    out += rest.slice(0, start);
    const end = rest.indexOf(BLOCK_END, start);
    if (end === -1) return out.trim();
    rest = rest.slice(end + BLOCK_END.length);
  }
}

function readLog(dataDir: DataDir): LogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir.path, HUMAN_LOG_FILE), "utf8");
  } catch {
    return [];
  }
  const replies: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as Partial<LogEntry>;
      if (
        typeof value.id === "string" &&
        typeof value.at === "string" &&
        typeof value.text === "string"
      ) {
        replies.push({
          id: value.id,
          at: value.at,
          text: value.text,
          ...(typeof value.screenshotAt === "string" ? { screenshotAt: value.screenshotAt } : {}),
          noteMtimeBeforeMs:
            typeof value.noteMtimeBeforeMs === "number" ? value.noteMtimeBeforeMs : null,
        });
      }
    } catch {
      // Ligne tronquée par un arrêt brutal : ignorée, les autres restent lisibles.
    }
  }
  return replies;
}

export function readReplies(dataDir: DataDir): HumanReply[] {
  return readLog(dataDir)
    .slice(-MAX_REPLIES)
    .map(({ id, at, text, screenshotAt }) => ({ id, at, text, ...(screenshotAt === undefined ? {} : { screenshotAt }) }));
}

/**
 * Dernière écriture de l'agent. Une recopie pose sur la note la date exacte de la réponse :
 * si la note porte encore cette date, l'agent n'a rien écrit depuis, et sa dernière
 * écriture est la date d'avant la recopie.
 */
function agentWriteMs(mtimeMs: number, log: readonly LogEntry[]): number {
  // Plusieurs recopies d'affilée : remonter la chaîne jusqu'à la dernière date de l'agent.
  let at = mtimeMs;
  for (let hops = 0; hops < log.length; hops++) {
    const own = log.findLast((e) => Date.parse(e.at) === at);
    if (own?.noteMtimeBeforeMs == null) break;
    at = own.noteMtimeBeforeMs;
  }
  return at;
}

export function messages(ctx: CliContext, dataDir: DataDir): CommandResult<MessagesData> {
  if (!profileExists(ctx, dataDir)) {
    return {
      exitCode: EXIT_FAILURE,
      data: { profileId: null, hint: NO_PROFILE_HINT, agentNote: null, replies: [] },
      human: formatMessages,
    };
  }
  let agentNote: MessagesData["agentNote"] = null;
  try {
    const file = notePath(dataDir);
    const stats = fs.lstatSync(file);
    // Un lien posé par l'agent ne doit pas faire lire un fichier hors de son espace.
    if (stats.isFile()) {
      const text = agentText(fs.readFileSync(file, "utf8"));
      agentNote = {
        file: `artifacts/${AGENT_NOTE_FILE}`,
        updatedAt: new Date(agentWriteMs(stats.mtimeMs, readLog(dataDir))).toISOString(),
        text: text.slice(0, MAX_NOTE_CHARS),
        truncated: text.length > MAX_NOTE_CHARS,
        trust: "untrusted_agent_content",
      };
    }
  } catch {
    agentNote = null;
  }
  const managed = readOwnerMessages(dataDir.path);
  const activeSession = withReadStore(ctx,dataDir,({uow}) => uow?.sessions.listOpen(DEFAULT_PROFILE_ID)[0]?.id ?? null);
  const messageWait = readMessageWait(dataDir.path,activeSession);
  const agentStatus = withReadStore(ctx,dataDir,({uow}) => {
    const profile=uow?.profiles.get(DEFAULT_PROFILE_ID);
    return profile ? {state:profile.state,reason:profile.stateReason,nextWakeAt:profile.nextWakeAt} : null;
  });
  return {
    exitCode: EXIT_OK,
    data: { profileId: DEFAULT_PROFILE_ID, hint: null, publicActivity: readPublicActivity(dataDir.path), agentNote: managed === null ? agentNote : null, replies: readReplies(dataDir), deliveryReceipts: readOwnerReceipts(dataDir.path), messageWait, agentStatus, repoThreads: readRepoConversations(dataDir.path), ...(managed === null ? {} : { agentMessages: managed }) },
    human: formatMessages,
  };
}

function refused(detail: string, exitCode = EXIT_FAILURE): CommandResult<ReplyData> {
  return {
    exitCode,
    data: { status: "refused", reply: null, mirrored: false, detail },
    human: formatReply,
  };
}

export async function reply(
  ctx: CliContext,
  dataDir: DataDir,
  idempotencyKey: string | undefined,
  captureScreen = false,
  capture: typeof captureWakeScreenshot = captureWakeScreenshot,
): Promise<CommandResult<ReplyData>> {
  if (!profileExists(ctx, dataDir)) return refused(NO_PROFILE_HINT);
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return refused("--idempotency-key invalide (8 à 128 caractères [A-Za-z0-9_.:-])", EXIT_USAGE);
  }
  if (ctx.readStdin === undefined) return refused("entrée standard indisponible", EXIT_USAGE);
  const inputText = (await ctx.readStdin()).replace(/\r\n/g, "\n").trim();
  if (inputText === "") return refused("texte vide sur l'entrée standard", EXIT_USAGE);
  const targetedBump = captureScreen && idempotencyKey?.startsWith("ui-bumpe-") === true;
  if (targetedBump && captureClickPoint(ctx.env) === undefined) return refused("Point du clic absent : aucun message envoyé. Refaire un clic droit.");
  const text = targetedBump ? pointReplyText(inputText, ctx.env) : inputText;
  if (text.length > MAX_REPLY_CHARS) {
    return refused(`texte trop long (${String(MAX_REPLY_CHARS)} caractères au plus)`, EXIT_USAGE);
  }

  const id = idempotencyKey ?? `rep-${randomUUID()}`;
  let prior = readReplies(dataDir).find((r) => r.id === id);
  if (prior === undefined && targetedBump) {
    const queued = readOwnerMessage(dataDir.path,id);
    if (queued !== null) {
      prior = {id:queued.id,at:queued.at,text:queued.text,...(queued.image === undefined ? {} : {screenshotAt:queued.image.capturedAt})};
      if (prior.text === text) {
        fs.appendFileSync(path.join(dataDir.path,HUMAN_LOG_FILE),`${JSON.stringify({...prior,noteMtimeBeforeMs:null})}\n`);
      }
    }
  }
  if (prior !== undefined) {
    if (prior.text === text && prior.screenshotAt === undefined) enqueueOwnerMessage(dataDir.path, prior);
    return prior.text === text
      ? {
          exitCode: EXIT_OK,
          data: {
            status: "duplicate",
            reply: prior,
            mirrored: true,
            detail: "réponse déjà enregistrée",
          },
          human: formatReply,
        }
      : refused("clé déjà utilisée pour un autre texte");
  }

  if (targetedBump && !freshTargetedClick(ctx.env,ctx.now().getTime())) return refused("Point du clic trop ancien ou contexte absent : aucun message envoyé. Refaire un clic droit.");
  if (captureScreen) {
    const oldDaemon = withReadStore(ctx, dataDir, ({ db }) => {
      const run = db === undefined ? null : latestDaemonRun(db, DEFAULT_PROFILE_ID);
      return run !== null && run.endedAt === null && !ownerAttachmentRuntimeMatches(dataDir.path, run.id);
    });
    if (oldDaemon) return refused("Le moteur en cours doit être redémarré pour recevoir les images. Aucun message envoyé ; brouillon conservé.");
    const supported = withReadStore(ctx, dataDir, ({ uow }) => {
      const profile = uow?.profiles.get(DEFAULT_PROFILE_ID);
      const revision = profile?.activePolicyRevisionId == null ? null : uow?.policies.getRevision(profile.activePolicyRevisionId);
      const runtime = revision?.groups.runtime;
      return runtime?.nativeCapabilities === true && (runtime.adapterId === "codex" || runtime.adapterId === "claude");
    });
    if (!supported) return refused("La capture jointe exige un profil natif Codex ou Claude configuré.");
  }
  // Explicit Send authorizes this one capture, independently of ambient wake capture.
  const image = captureScreen ? freshWakeImage(await capture("primary")) : null;
  if (captureScreen && image === null) return refused("Capture indisponible : aucun message envoyé. Pour un clic ciblé, choisir un point sur l’écran principal puis réessayer.");
  const now = ctx.now();
  const entry: HumanReply = { id, at: now.toISOString(), text, ...(image === null ? {} : { screenshotAt: image.capturedAt }) };
  const file = notePath(dataDir);
  let before: number | null = null;
  try {
    const stats = fs.lstatSync(file);
    if (stats.isFile()) before = stats.mtimeMs;
  } catch {
    before = null;
  }
  // Queue ID is unique. A targeted retry can recover it if history append was interrupted.
  const logged: LogEntry = { ...entry, noteMtimeBeforeMs: before };
  enqueueOwnerMessage(dataDir.path, { ...entry, ...(image === null ? {} : { image }) });
  fs.appendFileSync(path.join(dataDir.path, HUMAN_LOG_FILE), `${JSON.stringify(logged)}\n`);
  let mirrored = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exists = fs.existsSync(file);
    if (exists && !fs.lstatSync(file).isFile()) throw new Error("note de l'agent non ordinaire");
    const block = [
      `${BLOCK_START} id=${id} -->`,
      `## Réponse de ton humain — ${entry.at}`,
      "",
      text,
      BLOCK_END,
      "",
    ].join("\n");
    fs.appendFileSync(file, `${exists ? "\n" : ""}${block}`);
    // Date connue d'avance : `messages` reconnaît sa propre écriture (la modification
    // reste visible pour un réveil `fileChanged` de l'agent).
    fs.utimesSync(file, now, now);
    mirrored = true;
  } catch {
    // Recopie impossible (note remplacée par un dossier ou un lien) : `mirrored` reste faux.
  }
  return {
    exitCode: EXIT_OK,
    data: {
      status: "recorded",
      reply: entry,
      mirrored,
      detail: mirrored
        ? "enregistrée et mise en file : injection dans la session Claude active ou au prochain réveil"
        : "enregistrée dans le registre, mais non recopiée dans l'espace de l'agent",
    },
    human: formatReply,
  };
}

function formatMessages(data: MessagesData): string {
  if (data.profileId === null) return data.hint ?? "Aucun profil.";
  const lines: string[] = [];
  if (data.agentMessages !== undefined) {
    for (const m of data.agentMessages) lines.push(`Ton agent (${m.id}, v${m.version}, ${m.updatedAt}) :`, m.text, "");
    if (data.agentMessages.length === 0) lines.push("Aucun message de ton agent.");
  } else if (data.agentNote === null) lines.push("Aucune note de ton agent pour l'instant.");
  else {
    lines.push(
      `Note de ton agent (${data.agentNote.file}, ${data.agentNote.updatedAt}) :`,
      "",
      data.agentNote.text,
    );
  }
  for (const r of data.replies) lines.push("", `Toi, ${r.at} :`, r.text);
  return lines.join("\n");
}

function formatReply(data: ReplyData): string {
  return data.status === "refused"
    ? `Réponse refusée : ${data.detail}`
    : `Réponse ${data.status === "duplicate" ? "déjà " : ""}enregistrée. ${data.detail}`;
}
