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
import { readReceivedMessages, type ReceivedMessage } from "../../communication/received-messages.js";
import { readSentMessages, type SentMessage } from "../../communication/sent-messages.js";
import {recipientEntries} from "../../communication/recipient-history.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { artifactsDirFor, workspaceDirFor } from "../../daemon/paths.js";
import { isProcessAlive, latestDaemonRun } from "../../daemon/runs.js";
import type { SqliteDatabase } from "../../store/index.js";
import { readCurrentWakeObjective, type CurrentWakeObjective } from "../../daemon/wake-manager.js";
import { readWakePreview, readProjectWakeObjectives, type WakePreview } from "../../daemon/wake-preview.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { NO_PROFILE_HINT, withReadStore } from "./read.js";
import { startFastReply } from "./fast-reply.js";
import { captureClickPoint, captureWakeScreenshot } from "../../daemon/wake-screenshot.js";
import { freshTargetedClick, pointReplyText } from "../point-context.js";
import { freshWakeImage } from "../../adapters/wake-image.js";
import { ownerAttachmentRuntimeMatches } from "../../communication/owner-attachment-runtime.js";
import { readVoiceScreenPayloads, voiceScreenReferences } from "../../communication/voice-screen-images.js";

export const AGENT_NOTE_FILE = "questions-for-human.md";
export const HUMAN_LOG_FILE = "human-messages.jsonl";
export const MAX_REPLY_CHARS = 4000;
const MAX_NOTE_CHARS = 20_000;
const MAX_REPLIES = 200;
export const MAX_MESSAGES_LIMIT = 10_000;
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
  readonly upcomingWakes?: WakePreview;
  readonly currentWakeObjective?: CurrentWakeObjective | null;
  readonly projectWakes?: ReturnType<typeof readProjectWakeObjectives>;
  readonly sentMessages?: readonly SentMessage[];
  readonly recipientSentMessages?: readonly {id:string;at:string;text:string;state:string;threadId:string|null;messageId:string|null;senderRef:string;recipientRef:string}[];
  readonly receivedMessages?: readonly ReceivedMessage[];
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
  /** Présent avec `--limit` : vrai si des éléments plus anciens ont été omis. */
  readonly truncated?: boolean;
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

/**
 * Vrai si la session a été réservée (`budget_reserved`) sans être encore lancée
 * (`session_started`) : préparation, capture d'écran, démarrage du runtime. Lecture à
 * rebours sur la clé primaire, arrêtée au premier des deux événements de la session.
 */
export function sessionLaunching(db: SqliteDatabase, profileId: string, sessionId: string): boolean {
  try {
    const row = db
      .prepare<[string, string], { type: string }>(
        "SELECT type FROM journal_events WHERE profile_id = ? AND session_id = ? AND type IN ('budget_reserved','session_started') ORDER BY sequence DESC LIMIT 1",
      )
      .get(profileId, sessionId);
    return row?.type === "budget_reserved";
  } catch {
    return false;
  }
}

export function messages(ctx: CliContext, dataDir: DataDir, limit: number | null = null): CommandResult<MessagesData> {
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
  const publishedIds = new Set(managed?.map(message => message.id));
  const activeSession = withReadStore(ctx,dataDir,({uow}) => uow?.sessions.listOpen(DEFAULT_PROFILE_ID)[0]?.id ?? null);
  const messageWait = readMessageWait(dataDir.path,activeSession);
  const currentWakeObjective = readCurrentWakeObjective(workspaceDirFor(dataDir.path), activeSession);
  const agentStatus = withReadStore(ctx,dataDir,({uow,db}) => {
    const profile=uow?.profiles.get(DEFAULT_PROFILE_ID);
    if (profile?.state === "running" && db) {
      const run = latestDaemonRun(db, DEFAULT_PROFILE_ID);
      if (!run || run.endedAt !== null || !isProcessAlive(run.pid))
        return { state: "stopped", reason: "daemon_offline", nextWakeAt: null };
      // Lancement autorisé mais session pas encore ouverte : aucun hook ne peut encore
      // transmettre le message ; il le sera à l'ouverture (SessionStart).
      if (activeSession !== null && sessionLaunching(db, DEFAULT_PROFILE_ID, activeSession))
        return { state: "starting", reason: profile.stateReason, nextWakeAt: profile.nextWakeAt };
    }
    return profile ? {state:profile.state,reason:profile.stateReason,nextWakeAt:profile.nextWakeAt} : null;
  });
  const data: MessagesData = { projectWakes: currentWakeObjective ? readProjectWakeObjectives(workspaceDirFor(dataDir.path),currentWakeObjective.projectId,currentWakeObjective.inBlock,currentWakeObjective.passageId) : null, profileId: DEFAULT_PROFILE_ID, hint: null, upcomingWakes: readWakePreview(workspaceDirFor(dataDir.path), 11), recipientSentMessages:recipientEntries(dataDir.path).filter(m=>m.direction==="out").map(m=>({id:m.id,at:m.at,text:m.text,state:m.state,threadId:m.threadId,messageId:m.messageId,senderRef:m.senderRef,recipientRef:m.recipientRef})), sentMessages: readSentMessages(dataDir.path), receivedMessages: readReceivedMessages(dataDir.path, readLog(dataDir).map(r => r.id), publishedIds).filter(message=>managed===null||message.source.originKind!=="context_copy"), publicActivity: managed===null ? readPublicActivity(dataDir.path) : [], agentNote: managed === null ? agentNote : null, replies: readReplies(dataDir), deliveryReceipts: readOwnerReceipts(dataDir.path), messageWait, agentStatus, currentWakeObjective, repoThreads: readRepoConversations(dataDir.path), ...(managed === null ? {} : { agentMessages: managed }) };
  return { exitCode: EXIT_OK, data: limit === null ? data : latestMessages(data, limit), human: formatMessages };
}

/**
 * Garde les `limit` éléments datés les plus récents du fil (réponses, messages de l'agent,
 * reçus, envoyés, activité publique). Le desktop n'en affiche qu'une fenêtre : relire
 * et sérialiser tout l'historique (≈ 6,8 Mo) à chaque tour bloquait la saisie et l'envoi.
 * Les autres champs (état, prévisions, fils de session) restent entiers.
 */
export function latestMessages(data: MessagesData, limit: number): MessagesData {
  const stamps: string[] = [];
  const add = (at: string | undefined): void => { if (typeof at === "string") stamps.push(at); };
  for (const m of data.agentMessages ?? []) add(m.createdAt);
  for (const r of data.replies) add(r.at);
  for (const m of data.receivedMessages ?? []) add(m.at);
  for (const m of data.sentMessages ?? []) add(m.at);
  for (const m of data.recipientSentMessages ?? []) add(m.at);
  for (const a of data.publicActivity ?? []) add(a.at);
  if (stamps.length <= limit) return { ...data, truncated: false };
  const time = (at: string): number => { const t = Date.parse(at); return Number.isFinite(t) ? t : 0; };
  const cutoff = stamps.map(time).sort((a, b) => b - a)[limit - 1]!;
  const keep = (at: string): boolean => time(at) >= cutoff;
  const replies = data.replies.filter((r) => keep(r.at));
  const ids = new Set(replies.map((r) => r.id));
  return {
    ...data,
    replies,
    ...(data.agentMessages === undefined ? {} : { agentMessages: data.agentMessages.filter((m) => keep(m.createdAt) || keep(m.updatedAt)) }),
    ...(data.receivedMessages === undefined ? {} : { receivedMessages: data.receivedMessages.filter((m) => keep(m.at)) }),
    ...(data.sentMessages === undefined ? {} : { sentMessages: data.sentMessages.filter((m) => keep(m.at)) }),
    ...(data.recipientSentMessages === undefined ? {} : { recipientSentMessages: data.recipientSentMessages.filter((m) => keep(m.at)) }),
    ...(data.publicActivity === undefined ? {} : { publicActivity: data.publicActivity.filter((a) => keep(a.at)) }),
    ...(data.deliveryReceipts === undefined ? {} : {
      deliveryReceipts: Object.fromEntries(Object.entries(data.deliveryReceipts).filter(([id]) => ids.has(id))),
    }),
    truncated: true,
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
  preserveText = false,
  rawVoiceScreenRefs?: string,
): Promise<CommandResult<ReplyData>> {
  if (!profileExists(ctx, dataDir)) return refused(NO_PROFILE_HINT);
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return refused("--idempotency-key invalide (8 à 128 caractères [A-Za-z0-9_.:-])", EXIT_USAGE);
  }
  if (ctx.readStdin === undefined) return refused("entrée standard indisponible", EXIT_USAGE);
  const rawText = await ctx.readStdin();
  const inputText = preserveText ? rawText : rawText.replace(/\r\n/g, "\n").trim();
  if (inputText === "") return refused("texte vide sur l'entrée standard", EXIT_USAGE);
  const targetedBump = captureScreen && idempotencyKey?.startsWith("ui-bumpe-") === true;
  if (targetedBump && captureClickPoint(ctx.env) === undefined) return refused("Point du clic absent : aucun message envoyé. Refaire un clic droit.");
  const text = targetedBump ? pointReplyText(inputText, ctx.env) : inputText;
  if (text.length > MAX_REPLY_CHARS) {
    return refused(`texte trop long (${String(MAX_REPLY_CHARS)} caractères au plus)`, EXIT_USAGE);
  }
  let voiceScreenRefs: string[];
  try {
    voiceScreenRefs = voiceScreenReferences(rawVoiceScreenRefs === undefined ? undefined : JSON.parse(rawVoiceScreenRefs));
  } catch {
    return refused("Références des planches écran invalides.", EXIT_USAGE);
  }
  if (voiceScreenRefs.length && captureScreen) return refused("Choisir un seul type de capture.", EXIT_USAGE);

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
  if (captureScreen || voiceScreenRefs.length) {
    const oldDaemon = withReadStore(ctx, dataDir, ({ db }) => {
      const run = db === undefined ? null : latestDaemonRun(db, DEFAULT_PROFILE_ID);
      return run !== null && run.endedAt === null && !ownerAttachmentRuntimeMatches(dataDir.path, run.id, voiceScreenRefs.length > 0);
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
  let voiceScreens: string[];
  try {
    voiceScreens = readVoiceScreenPayloads(workspaceDirFor(dataDir.path), voiceScreenRefs);
  } catch {
    return refused("Planche écran indisponible : aucun message envoyé.");
  }
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
  enqueueOwnerMessage(dataDir.path, { ...entry, ...(image === null ? {} : { image }), ...(voiceScreens.length ? { voiceScreens } : {}) });
  fs.appendFileSync(path.join(dataDir.path, HUMAN_LOG_FILE), `${JSON.stringify(logged)}\n`);
  // Optional tool-free fast reply; detached, it never delays or blocks the recording.
  try {
    startFastReply(dataDir, id);
  } catch {
    // The main thread still receives the message normally.
  }
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
  for (const m of data.receivedMessages ?? []) lines.push("", `Re?u de ${m.source.kind} ${m.source.name} (${m.source.channel}, ${m.source.assurance}, fil ${m.source.threadId}, ${m.at}, ${m.state}) :`, m.text);
  for (const r of data.replies) lines.push("", `Toi, ${r.at} :`, r.text);
  return lines.join("\n");
}

function formatReply(data: ReplyData): string {
  return data.status === "refused"
    ? `Réponse refusée : ${data.detail}`
    : `Réponse ${data.status === "duplicate" ? "déjà " : ""}enregistrée. ${data.detail}`;
}
