import {conversationViewport,reconcileConversationChildren,conversationWindow,conversationMessageCount,CHAT_PAGE_SIZE} from './conversation-viewport.js';
import {voiceScreenshotsPreference,voiceScreenshotAttachments} from './voice-screenshots.js';
import {voiceScreenComposer,type VoiceScreenDraft} from './voice-screen-composer.js';
import {mountVoiceGraph} from './voice-graph-view.js';
import {mountVoiceMode,voiceModeStopsDictation,type VoiceModeState} from "./voice-mode-view.js";
import {mountVoiceSettingsSwitch} from "./voice-settings-switch.js";
import {mountVoiceCycle,type VoiceCycleEvent} from "./voice-cycle.js";
import { initDuo } from "./duo.js";
import { tr, formatLocale } from "./i18n.js";
import { mountOnboarding } from "./onboarding.js";
import { projectWakesCard } from "./project-wakes.js";
import { initProjects } from "./projects.js";
import { mountWakePreview } from "./wake-preview.js";
import { initWorkspaceSync } from "./workspace-sync.js";
import {voiceCaptureSelection,voiceThreadSettings,isVoiceThreadId} from "./voice-conversations.js";
import {deliverVoiceTranscript} from "./deliver-voice.js";
import { initElevenLabs } from "./elevenlabs.js";
import { mountFastReply } from "./fast-reply.js";
import { mountTelegramAccount } from "./telegram-account.js";
import { initDocuments } from "./documents.js";
import { bindChatDraft } from "./chat-draft.js";
import { Outbox, sendOnEnter, trackTyping, typingIdle } from "./composer-kit.js";
import { bindChatImages } from "./chat-images.js";
import {voiceChatControls,voiceTranscriptStatus} from './voice-chat-ui.js';
import {voiceChatController,voiceChatPlayback,voiceChatBargeIn} from "./voice-chat-controller.js";
import {bargeInPreference} from "./voice-barge-in.js";
import { desktopSpeech } from "./desktop-speech.js";
import { dictationProviderLabel,selectedDictationProvider } from "./dictation-provider.js";
import { mountSecondThread } from "./second-thread.js";
import { mountMainThread } from "./main-thread.js";
import { mountForks } from "./forks.js";
import { mountCoach } from "./coach.js";
/**
 * Panneau « Que fait mon agent ? » et fils privés. Chaque lecture et chaque action passe
 * par une commande Rust qui exécute la CLI correspondante (`mind-wake … --json`,
 * `owner-main.ts … --json`). Aucun appel modèle ni secret. Les images HTTP(S) référencées
 * sont chargées par le webview ; les images locales passent par une lecture native confinée.
 * Le texte des messages est inséré comme texte, jamais comme HTML.
 */

import { agentIsWorking, automaticBumpKind, BUMP_PROMPT_PATH, resolveBumpText, progressReminderLabel, type BumpKind } from "./chat-presence.js";
import { activityModel, type ActivityModel } from "./activity.js";
import { mountPromptEditor } from "./prompt-editor.js";
import { callVisionFeed } from "./call-vision.js";
import { mountAuthorizations } from "./authorizations.js";
import { conversation, conversationText, conversationReceipt, plainText, renderConversationMeta } from "./conversation.js";
import { projectBadge, projectMarker, undefinedObjectiveBadge } from "./project-marker.js";
import { attachComposeCopy, copyButton } from "./copy-button.js";
import { agentTint, authorMarker } from "./author-tint.js";
import {recipientSender} from "./recipient.js";
import { repoThreads, type RepoThread } from "./repo-threads.js";
import { renderMarkdown } from "./markdown.js";
import { initMessageFileLinks } from "./message-file-links.js";
import { appendMessageImages } from "./message-images.js";
import { decorateMessageLinks } from "./message-links.js";
import { LIGHT_LABELS, panelView, type Line, type PanelView, type StatusRead } from "./view.js";
import { reloadGuard, pendingBadge } from "./reload-guard.js";
import { shouldReopenCall, callWaitStatus } from "./call-frame.js";

interface TauriGlobal {
  readonly core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  readonly event?: {
    listen:(name:string,callback:(event?:unknown)=>void)=>Promise<unknown>;
    emitTo?:(target:string,event:string,payload:unknown)=>Promise<unknown>;
  };
}

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
}

interface Envelope {
  readonly ok?: unknown;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

interface ThreadSummary {
  readonly thread_id: string;
  readonly subject: string | null;
  readonly received: number;
  readonly last_sequence: number;
  readonly last_at: string;
  readonly preview: string;
}

interface Message {
  readonly message_id: string;
  readonly from_self: boolean;
  readonly text: string;
  readonly provenance: { readonly kind: string; readonly received_at: string };
}

const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
const messageFileLinks = tauri ? initMessageFileLinks((command,args)=>tauri.core.invoke(command,args)) : null;
const prompts = mountPromptEditor(async request => {
  if (!tauri) throw Error("Ouvre cet onglet dans MIND Wake.");
  const run = await tauri.core.invoke("agent_prompts", {request}) as CliRun;
  const result = JSON.parse(run.stdout);
  if (run.exitCode || result.error) throw Error(result.error ?? "Prompts indisponibles");
  return result;
});
const authorizations = mountAuthorizations(async (command, args) => {
  if (!tauri) throw new Error(tr("Les autorisations sont disponibles dans l’application MIND Wake."));
  return tauri.core.invoke(command, args);
});
const POLL_MS = 2000;
const CHART_EVERY = 5;
const DAY_MS = 86_400_000;
const SEEN_KEY = "mind-wake.seen-sequence";
const CHAT_SEEN_KEY = "mind-wake.chat-seen-at";

let fullscreen = false;
let fullscreenBusy = false;
async function setFullscreen(enabled: boolean): Promise<void> {
  if (!tauri || fullscreenBusy) return;
  fullscreenBusy = true;
  try {
    await tauri.core.invoke("app_fullscreen", {enabled});
    fullscreen = enabled;
    byId("app-fullscreen").textContent = enabled ? tr("Quitter le plein écran") : tr("Plein écran");
    byId("app-control-status").textContent = "";
  } catch (error) { byId("app-control-status").textContent = String(error); }
  finally { fullscreenBusy = false; }
}
byId("app-fullscreen").addEventListener("click", () => { void setFullscreen(!fullscreen); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.querySelector("dialog.message-image-dialog[open]")) return;
  if (event.key === "F11" || (event.key === "Escape" && fullscreen)) {
    event.preventDefault();
    void setFullscreen(event.key === "F11" ? !fullscreen : false);
  }
});
byId("app-restart").addEventListener("click", async () => {
  if (!tauri) return;
  const button = byId<HTMLButtonElement>("app-restart");
  button.disabled = true;
  byId("app-control-status").textContent = tr("Redémarrage…");
  try { await tauri.core.invoke("app_restart"); }
  catch (error) {
    byId("app-control-status").textContent = String(error);
    button.disabled = false;
  }
});

byId("engine-restart").addEventListener("click", async () => {
  if (!tauri) return;
  const button = byId<HTMLButtonElement>("engine-restart");
  if (button.disabled) return;
  button.disabled = true;
  const status = byId("engine-restart-status");
  status.hidden = false;
  status.textContent = tr("Redémarrage du moteur… La session en cours sera interrompue.");
  try {
    const result = await tauri.core.invoke("wake_restart") as CliRun;
    const envelope = JSON.parse(result.stdout) as Envelope;
    if (result.exitCode !== 0 || envelope.ok !== true) throw new Error(String(envelope.error?.message ?? tr("Redémarrage non confirmé")));
    status.textContent = tr("Moteur redémarré. Réglages conservés.");
    await refresh();
  } catch (error) { status.textContent = String(error); }
  finally { button.disabled = false; }
});

let lastRead: StatusRead | null = null;
const renderWakePreview = mountWakePreview(byId("wake-plan"), async (projectIds, revision) => {
  if (!tauri) throw Error(tr("Réorganisation disponible dans l’application MIND Wake."));
  const result = await tauri.core.invoke("wake_order", {projectIds, revision}) as CliRun;
  const envelope = JSON.parse(result.stdout) as Envelope;
  if (result.exitCode !== 0 || envelope.ok !== true) throw Error(String(envelope.error?.message ?? tr("Ordre non enregistré.")));
  // The regular status poll reads the persisted order after this callback returns.
});
let stopArmedUntil = 0;
let tick = 0;
let openThread: string | null = null;
let lastMessageId: string | null = null;
let draftKey: string | null = null;
const outgoingChat = new Map<string, HTMLLIElement>();

function messageLinks(body: HTMLElement): void {
  decorateMessageLinks(body, (command, args) => {
    if (!tauri) return Promise.reject(Error(tr("Ouverture disponible dans l’application MIND Wake")));
    return tauri.core.invoke(command, args);
  });
}

function conversationBody(text: string, kind: BumpKind | null, imageText = text): HTMLDivElement {
  const body = document.createElement("div"), paragraph = document.createElement("p");
  body.className = "conversation-body"; body.append(paragraph);
  if (kind === null) {
    paragraph.textContent = text;
    messageLinks(paragraph);
    appendMessageImages(body, imageText, (command, args) => {
      if (!tauri) return Promise.reject(Error(tr("Images locales disponibles dans l’app")));
      return tauri.core.invoke(command, args);
    });
    return body;
  }
  const icon = document.createElement("span");
  icon.className = "bump-invitation-icon";
  icon.textContent = "↗";
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", kind === "bumpe" ? tr("Bumpe, relance au point cliqué") : "Bump");
  const point = kind === "bumpe" ? /Point choisi par ton humain : \((-?\d+), (-?\d+)\)/.exec(text) : null;
  icon.title = kind === "bumpe" ? tr("Bumpe · relance ciblée{0}", [point ? ` au point (${point[1]}, ${point[2]})` : tr(" au point cliqué")]) : tr("Bump · invitation à relancer la conversation");
  paragraph.append(icon);
  return body;
}

function outgoingBubble(key: string, text: string, follow = true): HTMLLIElement {
  const viewportPosition=chatViewport.capture();
  const li = document.createElement("li");
  li.dataset["self"] = "true";
  li.dataset["messageId"] = key;
  li.className = "message-outgoing";
  const meta = document.createElement("small");
  meta.textContent = tr("Toi · Envoi en cours…");
  meta.setAttribute("role", "status");
  const kind = automaticBumpKind({from:"human",id:key,text});
  if (kind !== null) li.dataset["invitation"] = kind;
  const body = conversationBody(text, kind);
  const marker = authorMarker(li, "owner");
  if (marker) meta.prepend(marker);
  li.append(meta, body, copyButton(() => text));
  outgoingChat.set(key, li);
  byId("chat").append(li);
  if (kind === null) messageFileLinks?.observe([{id:key,at:new Date().toISOString(),text}],false,true);
  byId("chat-note").textContent = "";
  chatViewport.restore({...viewportPosition,follow:follow&&viewportPosition.follow});
  chatViewport.watch();
  return li;
}
let chatOpen = false;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- type d'élément choisi par l'appelant
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(tr("élément #{0} absent", [id]));
  return el as T;
}

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<Envelope> {
  if (tauri === undefined) throw new Error(tr("hors de l'application desktop"));
  const run = (await tauri.core.invoke(cmd, args)) as CliRun;
  return JSON.parse(run.stdout) as Envelope;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorText(envelope: Envelope): string {
  const m = envelope.error?.message;
  return typeof m === "string" ? m : tr("refusé");
}

// --- Agent : statut, voyant, sélecteur ---------------------------------------------------

let refreshInFlight=false;
async function refresh():Promise<void>{
  if(refreshInFlight)return;refreshInFlight=true;
  try{await refreshOnce();}finally{refreshInFlight=false;}
}
async function refreshOnce(): Promise<void> {
  // La conversation ne dépend pas du statut : la lire en parallèle évite ~1 s de latence
  // et un tour plus long que POLL_MS (tick sauté).
  // `wake messages` coûte ≈ 3,3 s de CPU et 6,8 Mo de JSON (16 nov. 2026) : relu toutes les
  // 2 s, il occupait la machine en continu et ralentissait la saisie et l'envoi. Les messages
  // de l'agent arrivent par l'événement `owner-messages-changed` ; le polling n'est qu'un filet.
  const chat = tick % CHART_EVERY === 0 || dictation.active() ? refreshChatSoon() : Promise.resolve();
  try {
    const envelope = await invoke("wake_status");
    lastRead = { ok: true, fetchedAt: Date.now(), envelope };
    mainThreadView?.update(envelope.data);
    const voiceProfile = envelope.data?.["profile"] as {state?:string;emergencyStopLocked?:boolean}|undefined;
    if((dictation.active() || mainVoiceProcessing) && (voiceProfile?.emergencyStopLocked || ["paused","stopped","disabled"].includes(voiceProfile?.state??""))) dictation.stop(true);
    renderWakePreview((envelope.data as { wakePreview?: unknown } | undefined)?.wakePreview);
    const input = (envelope.data as { keyboardContext?: { state?: string } } | undefined)
      ?.keyboardContext;
    const indicator = document.getElementById("input-sharing");
    if (indicator) {
      indicator.hidden = !input || input.state === "off";
      indicator.textContent =
        input?.state === "active"
          ? tr("Partage du texte ACTIF — icône T pour pause ou arrêt")
          : input?.state === "paused"
            ? tr("Partage du texte en pause")
            : input?.state === "starting"
              ? tr("Démarrage du partage du texte…")
              : tr("État du partage du texte indisponible");
    }
  } catch (error) {
    lastRead = { ok: false, fetchedAt: Date.now(), error: message(error) };
    renderWakePreview(null);
  }
  render(panelView(lastRead, Date.now()));
  renderChatPresence();
  window.dispatchEvent(new Event("wake-interface-ready"));
  if (tick % CHART_EVERY === 0) await refreshChart();
  if (tick % CHART_EVERY === 0) await refreshThreads();
  await chat;
  tick += 1;
}

function fillLines(id: string, lines: readonly Line[]): void {
  const list = byId<HTMLDListElement>(id);
  list.replaceChildren(
    ...lines.flatMap((line) => {
      const dt = document.createElement("dt");
      dt.textContent = line.label;
      const dd = document.createElement("dd");
      dd.textContent = line.value;
      return [dt, dd];
    }),
  );
  const section = list.closest("section");
  if (section !== null) section.hidden = lines.length === 0;
}

function render(view: PanelView): void {
  byId("state").dataset["tone"] = view.tone;
  const light = byId("light");
  light.dataset["light"] = view.light;
  light.setAttribute("aria-label", tr("Voyant : {0}", [LIGHT_LABELS[view.light]]));
  light.title = LIGHT_LABELS[view.light];
  byId("headline").textContent = view.headline;
  byId("agent-active-project").textContent = view.activeProject ? tr("Projet : {0}", [view.activeProject]) : "";
  byId("agent-active-project").hidden = view.activeProject === null;
  byId("app-status").textContent = view.headline;
  byId("app-status").dataset["tone"] = view.tone;
  byId("reason").textContent = view.reason;
  byId("simulated").hidden = !view.simulated;
  byId("last-contact").textContent = tr("Dernier contact avec Wake : {0}", [view.lastContact]);
  fillLines("activity", view.activity);
  fillLines("consumption", view.consumption);
  fillLines("protection", view.protection);

  const on = byId<HTMLButtonElement>("mode-on");
  const wake = byId<HTMLButtonElement>("mode-wake");
  const off = byId<HTMLButtonElement>("mode-off");
  const always = byId<HTMLButtonElement>("mode-always");
  always.setAttribute("aria-pressed", String(view.alwaysOn));
  always.disabled = !view.canAlwaysOn;
  always.title = view.light === "forced_off" ? tr("Réactiver Wake et enchaîner les réveils") : tr("Enchaîner les réveils après chaque réponse");
  on.setAttribute("aria-pressed", String(view.light === "on" && !view.alwaysOn));
  wake.setAttribute("aria-pressed", String(view.light === "awake" && !view.alwaysOn));
  off.setAttribute("aria-pressed", String(view.light === "forced_off"));
  on.disabled = !view.canResume && !view.alwaysOn;
  wake.disabled = !view.canWake;
  off.disabled = !view.canStop;
  byId<HTMLButtonElement>("pause").disabled = !view.canPause;
  const armed = Date.now() < stopArmedUntil;
  off.textContent = armed ? tr("Confirmer l'arrêt") : "Force-off";
  off.dataset["armed"] = String(armed);
}

function feedback(text: string): void {
  byId("feedback").textContent = text;
}

async function control(cmd: string, done: string): Promise<void> {
  feedback(tr("Commande envoyée…"));
  try {
    const envelope = await invoke(cmd);
    const detail =
      typeof envelope.data?.["detail"] === "string" ? ` ${envelope.data["detail"]}` : "";
    feedback(envelope.ok === true ? `${done}${detail}` : tr("Refusé.{0}", [detail]));
  } catch (error) {
    feedback(tr("Échec : {0}", [message(error)]));
  }
  tick = 0;
  await refresh();
}

// --- Graphe réveils / consommation -------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

async function refreshChart(): Promise<void> {
  let model: ActivityModel | null;
  try {
    model = activityModel(await invoke("wake_journal"), Date.now(), DAY_MS);
  } catch {
    model = null;
  }
  drawChart(model);
}

function drawChart(model: ActivityModel | null): void {
  const box = byId("chart");
  const summary = byId("chart-summary");
  if (model === null) {
    box.replaceChildren();
    summary.textContent = tr("Journal indisponible : aucun graphe affiché.");
    return;
  }
  const W = 400;
  const H = 120;
  const PAD = 18;
  const chart = svg("svg", { viewBox: `0 0 ${String(W)} ${String(H)}`, role: "img" });
  chart.setAttribute(
    "aria-label",
    tr("{0} réveils sur 24 h, {1} tokens mesurés", [String(model.sessions.length), model.totalKnownTokens.toLocaleString(formatLocale())]),
  );
  const x = (t: number): number =>
    PAD + ((t - model.from) / (model.to - model.from)) * (W - 2 * PAD);
  const base = H - PAD;
  chart.append(svg("line", { x1: PAD, x2: W - PAD, y1: base, y2: base, class: "axis" }));
  for (let h = 0; h <= 24; h += 6) {
    const t = model.from + (h / 24) * (model.to - model.from);
    chart.append(svg("line", { x1: x(t), x2: x(t), y1: base, y2: base + 4, class: "axis" }));
    const label = svg("text", { x: x(t), y: H - 2, class: "tick" });
    // Dernière graduation alignée à droite : « maintenant » ne déborde pas du cadre.
    if (h === 24) label.style.textAnchor = "end";
    label.textContent = h === 24 ? tr("maintenant") : `-${String(24 - h)} h`;
    chart.append(label);
  }
  for (const s of model.sessions) {
    const start = s.startedAt ?? s.endedAt ?? model.to;
    const cx = x(start);
    // Réveil : marque au sol. Consommation : barre proportionnelle, ou barre hachurée
    // pleine hauteur grisée si les tokens sont inconnus (jamais une barre nulle).
    if (s.tokens === null) {
      chart.append(
        svg("rect", { x: cx - 3, y: PAD, width: 6, height: base - PAD, class: "bar unknown" }),
      );
    } else if (model.maxTokens > 0) {
      const h = Math.max(2, (s.tokens / model.maxTokens) * (base - PAD));
      chart.append(
        svg("rect", {
          x: cx - 3,
          y: base - h,
          width: 6,
          height: h,
          class: s.simulated ? "bar simulated" : "bar",
        }),
      );
    }
    const dot = svg("circle", { cx, cy: base, r: 3.5, class: "wake" });
    const title = svg("title", {});
    title.textContent = `${new Date(start).toLocaleString(formatLocale())} — ${
      s.tokens === null ? tr("tokens inconnus") : `${s.tokens.toLocaleString(formatLocale())} tokens`
    }${s.outcome === null ? tr(" (en cours)") : ` · ${s.outcome}`}${s.simulated ? tr(" · SIMULÉ") : ""}`;
    dot.append(title);
    chart.append(dot);
  }
  box.replaceChildren(chart);
  summary.textContent =
    model.sessions.length === 0
      ? tr("Aucun réveil sur les dernières 24 h.")
      : tr("{0} réveil(s) · {1} tokens mesurés", [String(model.sessions.length), model.totalKnownTokens.toLocaleString(formatLocale())]) +
        (model.unknownCount > 0
          ? tr(" · {0} session(s) à consommation inconnue (barres grisées)", [String(model.unknownCount)])
          : "") +
        (model.simulated ? tr(" · contient des sessions SIMULÉES") : "");
}

// --- Fils privés -------------------------------------------------------------------------

function seenSequence(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}

function markSeen(sequence: number): void {
  try {
    if (sequence > seenSequence()) localStorage.setItem(SEEN_KEY, String(sequence));
  } catch {
    // Préférence d'affichage seulement : sans stockage, tout reste « non lu ».
  }
}

async function refreshThreads(): Promise<void> {
  const status = byId("threads-status");
  let threads: readonly ThreadSummary[];
  try {
    const envelope = await invoke("owner_threads");
    // Sans hub configuré, l'onglet n'a rien à montrer : il reste masqué, sans erreur.
    const configured = envelope.error?.code !== "not_configured";
    byId("tab-threads").hidden = !configured;
    if (!configured) {
      if (!byId("view-threads").hidden) selectTab("panel");
      return;
    }
    if (envelope.ok !== true) {
      status.textContent = tr("Fils indisponibles : {0}", [errorText(envelope)]);
      byId("threads").replaceChildren();
      byId("unread").hidden = true;
      return;
    }
    threads = (envelope.data?.["threads"] ?? []) as ThreadSummary[];
  } catch (error) {
    status.textContent = tr("Fils indisponibles : {0}", [message(error)]);
    return;
  }
  const seen = seenSequence();
  const unread = threads.filter((t) => t.last_sequence > seen).length;
  byId("unread").textContent = String(unread);
  byId("unread").hidden = unread === 0;
  status.textContent = threads.length === 0 ? tr("Aucun message de ton agent pour l'instant.") : "";
  byId("threads").replaceChildren(
    ...threads.map((t) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["unread"] = String(t.last_sequence > seen);
      const subject = document.createElement("strong");
      subject.textContent = t.subject ?? tr("(sans sujet)");
      const preview = document.createElement("span");
      preview.className = "thread-preview";
      preview.textContent = plainText(t.preview);
      const when = document.createElement("small");
      when.textContent = new Date(t.last_at).toLocaleString(formatLocale());
      button.append(subject, preview, when);
      button.addEventListener(
        "click",
        () => void showThread(t.thread_id, t.subject, t.last_sequence),
      );
      li.append(button);
      return li;
    }),
  );
}

async function showThread(
  threadId: string,
  subject: string | null,
  lastSequence: number,
): Promise<void> {
  if (openThread !== threadId) draftKey = null;
  openThread = threadId;
  byId("threads").hidden = true;
  byId("thread").hidden = false;
  byId("thread-subject").textContent = subject ?? tr("(sans sujet)");
  try {
    const envelope = await invoke("owner_thread", { threadId });
    if (envelope.ok !== true) {
      byId("reply-status").textContent = tr("Fil indisponible : {0}", [errorText(envelope)]);
      return;
    }
    const messages = (envelope.data?.["messages"] ?? []) as Message[];
    lastMessageId = messages.findLast((m) => !m.from_self)?.message_id ?? null;
    byId("messages").replaceChildren(
      ...messages.map((m) => {
        const li = document.createElement("li");
        li.dataset["self"] = String(m.from_self);
        const meta = document.createElement("small");
        meta.textContent = `${m.from_self ? tr("Toi") : m.provenance.kind === "agent" ? tr("Ton agent") : m.provenance.kind} · ${new Date(m.provenance.received_at).toLocaleString(formatLocale())}`;
        const body = document.createElement("p");
        body.textContent = m.text;
        messageLinks(body);
        appendMessageImages(body, m.text, (command, args) => tauri!.core.invoke(command, args));
        const marker = authorMarker(li, m.from_self ? "owner" : null);
        if (marker) meta.prepend(marker);
        li.append(meta, body, copyButton(() => m.text));
        return li;
      }),
    );
    markSeen(lastSequence);
    await refreshThreads();
  } catch (error) {
    byId("reply-status").textContent = tr("Fil indisponible : {0}", [message(error)]);
  }
}

async function sendReply(): Promise<void> {
  const text = byId<HTMLTextAreaElement>("reply-text").value.trim();
  if (openThread === null || text === "") return;
  // Une clé par brouillon : un renvoi après échec réseau ne crée pas de doublon.
  draftKey ??= `ui-${crypto.randomUUID()}`;
  const status = byId("reply-status");
  status.textContent = tr("Envoi…");
  try {
    const envelope = await invoke("owner_reply", {
      threadId: openThread,
      inReplyTo: lastMessageId,
      idempotencyKey: draftKey,
      text,
    });
    if (envelope.ok !== true) {
      status.textContent = tr("Non envoyé : {0}", [errorText(envelope)]);
      return;
    }
    status.textContent = tr("Envoyé dans le fil. Ton agent le lira à sa prochaine session autorisée.");
    byId<HTMLTextAreaElement>("reply-text").value = "";
    draftKey = null;
    const subject = byId("thread-subject").textContent;
    await showThread(openThread, subject, 0);
  } catch (error) {
    status.textContent = tr("Non envoyé : {0}", [message(error)]);
  }
}

// --- Messages avec l'agent ---------------------------------------------------------------

function chatSeenAt(): string {
  try {
    return localStorage.getItem(CHAT_SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function markChatSeen(at: string): void {
  try {
    localStorage.setItem(CHAT_SEEN_KEY, at);
  } catch {
    // Préférence d'affichage seulement.
  }
}

/** Markdown de l'agent affiché sans ses marques (titres, gras, code) ; jamais interprété. */

const chatViewport=conversationViewport(byId("chat"));
window.addEventListener("beforeunload",()=>chatViewport.dispose());
let chatVisibleCount = CHAT_PAGE_SIZE;
let chatSignature = "";
let chatRequest = 0;
let lastChatResponse = 0;
let chatLoadingOlder = false;
let chatHasOpened = false;
// Bouton « copier » des zones de saisie (NLR, 15 nov. 2026).
for (const id of ["chat-text", "second-thread-text", "reply-text"]) attachComposeCopy(byId<HTMLTextAreaElement>(id));
byId("chat-older").addEventListener("click", () => { chatVisibleCount += CHAT_PAGE_SIZE; chatLoadingOlder = true; void refreshChat(); });
// Une seule lecture à la fois ; une demande pendant la lecture en relance une seule après.
let chatInFlight: Promise<void> | null = null;
let chatAgain = false;
function refreshChatSoon(): Promise<void> {
  if (chatInFlight) { chatAgain = true; return chatInFlight; }
  chatInFlight = (async () => {
    // ~6 Mo de JSON à lire et analyser (≈ 60 ms bloquantes) : pas au milieu d'une frappe.
    try { do { chatAgain = false; await typingIdle(); await refreshChat(); } while (chatAgain); }
    finally { chatInFlight = null; }
  })();
  return chatInFlight;
}
let recipientCheckedAt = 0;
let helpersCache: {at: number; value: Promise<Envelope | null>} | null = null;
function helpersAnswers(): Promise<Envelope | null> {
  if (helpersCache === null || Date.now() - helpersCache.at > 30_000) {
    helpersCache = {at: Date.now(), value: invoke("helpers_answers").catch(() => null)};
  }
  return helpersCache.value;
}
// Le panneau Rust signale l'écriture d'un message de l'agent : lecture immédiate.
void tauri?.event?.listen("owner-messages-changed", () => void refreshChatSoon());
async function refreshChat(): Promise<void> {
  const request = ++chatRequest;
  const speechObservation=chatLoadingOlder?"history":"live";
  if (Date.now() - recipientCheckedAt > 15_000) { recipientCheckedAt = Date.now(); void refreshRecipient(); }
  let model;
  try {
    // Réponses des sessions réveillées pour aider l'agent : facultatives, jamais bloquantes.
    // ≈ 2,6 s de CPU par lecture : gardées 30 s au lieu d'être relues à chaque tour.
    const [messages, helpers] = await Promise.all([
      // Seulement la fin du fil (CLI `messages --limit`) : marge large car seuls certains éléments
      // comptent dans la fenêtre. Un binaire Rust plus ancien ignore l'argument et rend tout.
      invoke("wake_messages", {limit: chatVisibleCount * 3 + 60}),
      helpersAnswers(),
    ]);
    model = conversation(messages, helpers);
  } catch (error) {
    if (request < lastChatResponse) return;
    byId("chat-note").textContent = tr("Messages indisponibles : {0}", [message(error)]);
    return;
  }
  if (request < lastChatResponse) return;
  lastChatResponse = request;
  if (model === null) {
    byId("chat-note").textContent = tr("Messages indisponibles : format inattendu.");
    return;
  }
  // Model contains ALL fetched messages; visual pagination is only slice(-chatVisibleCount).
  desktopReader.observe(model.items,speechObservation);
  const fresh = model.agentUpdatedAt !== null && model.agentUpdatedAt > chatSeenAt();
  byId("chat-new").hidden = chatOpen || !fresh;
  if (chatOpen && model.agentUpdatedAt !== null) markChatSeen(model.agentUpdatedAt);
  byId("chat-note").textContent = model.note ?? "";
  byId("chat-older").hidden = conversationMessageCount(model.items) <= chatVisibleCount && model.truncated !== true;
  // Keep local bubbles through polling until the persisted ID appears.
  let reconciled = false;
  for (const item of model.items) {
    if (item.id && item.from === "human") {
      if (outgoingChat.delete(item.id)) reconciled = true;
      // Persistence is authoritative even if the send acknowledgement was lost.
      if (pendingBump?.key === item.id) pendingBump = null;
    }
  }
  if (outgoingChat.size) byId("chat-note").textContent = "";
  messageFileLinks?.observe(model.items.filter(item=>(item.from === "human" || item.from === "agent" || item.from === "received") && automaticBumpKind(item) === null).map(item=>({id:item.id,at:item.at,text:item.text})),chatSignature === "" || chatLoadingOlder);
  const visibleMessages=conversationWindow(model.items,chatVisibleCount);
  const signature=JSON.stringify([visibleMessages,model.projectWakes]);
  if(signature===chatSignature && !reconciled)return;
  const chatPane=byId("chat");
  const firstRender=chatSignature==="";
  const position=chatViewport.capture(firstRender&&chatPane.children.length===0);
  if(chatLoadingOlder)position.follow=false;
  const existing=new Map([...chatPane.children].map(node=>[(node as HTMLElement).dataset["viewportKey"]??(node as HTMLElement).dataset["messageId"],node as HTMLElement]));
  chatSignature=signature;
  const desired=visibleMessages.map((item) => {
      const rendered=JSON.stringify(item),viewportKey=item.id??rendered,old=existing.get(viewportKey);
      if(old?.dataset["renderSignature"]===rendered)return old;
      const li = document.createElement("li");
      li.dataset["renderSignature"]=rendered;li.dataset["viewportKey"]=viewportKey;
      li.dataset["self"] = String(item.from === "human");
      if (item.id) li.dataset["messageId"] = item.id;
      const meta = document.createElement("small");
      li.dataset["from"] = item.from;
      if (item.humanRecipient === "Auroracle") li.dataset["recipient"] = "auroracle";
      renderConversationMeta(meta, item);
      if(item.voiceRecipient) meta.append(" · Reçu dans "+item.voiceRecipient);
      if(item.voiceSpeakerLabel) meta.append(" · Vocal de "+item.voiceSpeakerLabel+" (relayé)");
      if (item.objectiveDefined === false) meta.append(" ", undefinedObjectiveBadge());
      if (item.project) {
        meta.prepend(projectBadge(item.project.id, item.project.title), " ");
        li.style.setProperty("--project-color", projectMarker(item.project.id, item.project.title).color);
        li.classList.add("project-objective");
      }
      const delivery = conversationReceipt(item);
      if (delivery) {
        const receipt = document.createElement("span");
        receipt.className = "delivery-receipt";
        receipt.dataset["delivered"] = String(delivery.delivered);
        receipt.textContent = delivery.text;
        receipt.title = delivery.title;
        receipt.setAttribute("aria-label", delivery.label);
        meta.append(receipt);
      }
      const kind = automaticBumpKind(item);
      if (kind !== null) li.dataset["invitation"] = kind;
      const body = conversationBody(conversationText(item, plainText), kind, item.text);
      if (item.projectRows) {
        body.replaceChildren();
        const details=document.createElement("details"),summary=document.createElement("summary");
        summary.textContent=tr("Les 10 prochains wakes");details.append(summary);body.append(details);
        for (const row of item.projectRows) {
          const line = document.createElement("p");
          line.className = "project-plan-row";
          line.append(projectBadge(row.id, row.title), document.createTextNode(` ${row.text}`));
          if (!row.objectiveDefined) line.append(" ", undefinedObjectiveBadge());
          details.append(line);
        }
        const note = document.createElement("small");
        note.textContent = tr("Prévision révisable · mise à jour automatique · wake en cours exclu.");
        details.append(note);
      }
      const marker = authorMarker(li, item.from === "human" ? item.voiceSpeakerLabel ? null : "owner"
        : item.from === "agent" ? agentTint(item.text)
        : item.from === "received" && item.headerNames?.[0]?.startsWith("Pattern holder") ? "holder" : null);
      if (marker) meta.prepend(marker);
      li.append(meta, body, copyButton(() => item.text));
      if (item.pendingReason) {
        const wait = document.createElement("small");
        wait.className = "message-wait";
        wait.textContent = item.pendingReason;
        li.append(wait);
      }
      return li;
    });
  const objectiveKey='project-wakes',objectiveSignature=JSON.stringify(model.projectWakes),oldObjectives=existing.get(objectiveKey);
  const objectives=oldObjectives?.dataset['renderSignature']===objectiveSignature?oldObjectives:projectWakesCard(model.projectWakes);
  if(objectives){objectives.dataset['viewportKey']=objectiveKey;objectives.dataset['renderSignature']=objectiveSignature;desired.push(objectives);}
  desired.push(...outgoingChat.values());
  reconcileConversationChildren(chatPane,desired);
  chatViewport.restore(position);chatViewport.watch();
  chatLoadingOlder=false;
}

// Presence is UI state, never a persisted conversation item.
function renderChatPresence(): void {
  const visible = agentIsWorking(lastRead, Date.now());
  const presence = byId("chat-presence");
  if (presence.hidden !== !visible) presence.hidden = !visible;
  const label = progressReminderLabel(lastRead, Date.now());
  const reminder = byId("chat-progress-reminder");
  reminder.hidden = label === null;
  if (reminder.textContent !== (label ?? "")) reminder.textContent = label ?? "";
  reminder.title = label === tr("Rappel transmis")
    ? tr("Le rappel de nouvelles a été transmis à l’agent. En attente d’un message.")
    : tr("60 secondes sans nouvelles : un rappel attend d’être transmis à l’agent.");
}
// Expire the indication even if a status request is stuck.
setInterval(renderChatPresence, 1000);

let bumpBusy = false;
let pendingBump: { key: string; text: string; bubble: HTMLLIElement } | null = null;
byId("chat-bump").addEventListener("mousedown", event => event.preventDefault());
byId("chat-bump").addEventListener("click", async () => {
  if (bumpBusy || pendingBump?.bubble.dataset["sending"] === "true") return;
  bumpBusy = true;
  const button = byId<HTMLButtonElement>("chat-bump");
  button.disabled = true;
  if (pendingBump === null) {
    const text = await resolveBumpText(() => {
      if (!tauri) throw new Error(tr("Application indisponible"));
      return tauri.core.invoke("document_browse", {scope:"agent",relative:BUMP_PROMPT_PATH,read:true});
    });
    const key = `ui-bump-${crypto.randomUUID()}`;
    pendingBump = {key, text, bubble:outgoingBubble(key, text, false)};
  }
  const {key, text, bubble} = pendingBump;
  // Bump invites a contribution; it cannot lift Pause or start a stopped daemon.
  try { await transmitChat(key, text, bubble, false); }
  finally { bumpBusy = false; button.disabled = false; }
});

// A recipient label is not a route. Keep the draft until a backend-paired human
// identity and reply thread exist; never silently send it to the owner agent.
byId("chat-recipient").addEventListener("change", () => {
  void refreshRecipient();
});
let recipientConfigured=false,recipientChecking=false,recipientPolledAt=0;
async function refreshRecipient():Promise<void> {
  if(recipientChecking)return;
  recipientChecking=true;
  try {
    const status=await invoke("recipient_status");
    recipientConfigured=status.ok===true && status.data?.["configured"]===true;
    const option=byId<HTMLSelectElement>("chat-recipient").querySelector('option[value="auroracle"]');
    const ownerOption=byId<HTMLSelectElement>("chat-recipient").querySelector('option[value="owner"]');
    if(ownerOption)ownerOption.textContent=status.data?.["localOwnerName"]==="Marco" ? tr("Marco · mon agent") : tr("Mon agent");
    if(option instanceof HTMLOptionElement) {
      // Never change a chosen recipient after route removal: that could send a
      // retained peer draft to the local owner on the next click.
      option.hidden=status.data?.["pilot"]!==true && byId<HTMLSelectElement>("chat-recipient").value!=="auroracle";
      option.disabled=option.hidden;
      option.textContent=recipientConfigured ? "Auroracle" : tr("Auroracle · non raccordé");
    }
    if(byId<HTMLSelectElement>("chat-recipient").value==="auroracle")byId("chat-recipient-status").textContent=String(status.data?.["detail"] ?? tr("Route indisponible."));
    else if(byId<HTMLSelectElement>("chat-recipient").value==="all") {
      const all=await invoke("broadcast_status");
      const recipients=(all.data?.["recipients"] ?? []) as {label:string;reason?:string}[];
      byId("chat-recipient-status").textContent=recipients.map(r=>r.label+(r.reason?" · non joignable":"")).join(", ")+". "+String(all.data?.["scope"]??"");
    } else byId("chat-recipient-status").textContent="";
    if(recipientConfigured && Date.now()-recipientPolledAt>10_000) {
      recipientPolledAt=Date.now();
      const result=await invoke("recipient_poll");
      if(result.ok!==true && byId<HTMLSelectElement>("chat-recipient").value==="auroracle")byId("chat-recipient-status").textContent=tr("Réception distante indisponible ; messages locaux conservés.");
    }
  } catch {
    recipientConfigured=false;
    if(byId<HTMLSelectElement>("chat-recipient").value==="auroracle")byId("chat-recipient-status").textContent=tr("Route indisponible. Brouillon conservé.");
  }
  finally {recipientChecking=false;}
}
const recipientStorage=(()=>{try{return localStorage;}catch{return undefined;}})();
const saveChatDraft=bindChatDraft(byId<HTMLTextAreaElement>('chat-text'),byId<HTMLSelectElement>('chat-recipient'),recipientStorage);
// Entrée envoie, Maj+Entrée va à la ligne ; toute frappe repousse les lectures lourdes.
sendOnEnter(byId<HTMLTextAreaElement>('chat-text'),()=>byId<HTMLFormElement>('chat-form').requestSubmit());
trackTyping(document);
// Envois partis mais non confirmés : un rechargement les renvoie (clé d'idempotence identique).
const chatOutbox=new Outbox(recipientStorage,'mind-wake.chat-outbox');
/** Échec : le texte revient dans le champ s'il est vide, rien n'est perdu. */
function restoreChatText(text:string):void{
  const field=byId<HTMLTextAreaElement>('chat-text');
  if(field.value.trim()!=='')return;
  field.value=text;saveChatDraft();
}
const voiceScreenshots=voiceScreenshotsPreference(recipientStorage,false);
const principalScreenComposer=voiceScreenComposer();
let principalScreenRevision=0;
const clearPrincipalScreen=()=>{principalScreenRevision++;principalScreenComposer.clear();};
voiceScreenshots.subscribe(clearPrincipalScreen);
const sampleVoiceScreen=async():Promise<string>=>{
  if(!tauri)throw Error('Capture écran disponible dans le desktop local');
  return JSON.stringify(await tauri.core.invoke('voice_screen_sample'));
};
async function importVoiceScreenshot(raw:string,name:string):Promise<{reference:string;capturedAt:string}>{
  if(!tauri)throw Error('Desktop local requis');
  const shot=JSON.parse(raw) as {base64:string;capturedAt:string};
  const bytes=Uint8Array.from(atob(shot.base64),char=>char.charCodeAt(0));
  const imported=await tauri.core.invoke('conversation_image_import',{name,bytes:Array.from(bytes)}) as {reference:string};
  return {reference:imported.reference,capturedAt:shot.capturedAt};
}
const screenshotsToggle=byId<HTMLInputElement>('voice-screenshots');screenshotsToggle.checked=voiceScreenshots.enabled();screenshotsToggle.addEventListener('change',()=>voiceScreenshots.set(screenshotsToggle.checked));
const voiceCapture=voiceCaptureSelection();
const threadSettings=voiceThreadSettings(recipientStorage);
const voiceDestination=document.createElement('select');voiceDestination.id='voice-destination';voiceDestination.setAttribute('aria-label','Destinataires des dictées');
const refreshVoiceDestinations=()=>{const selected=voiceDestination.value;voiceDestination.replaceChildren(new Option('Dernier interlocuteur entendu','focus'),new Option('Marco · échange principal','principal'),...threadSettings.get().map(t=>new Option(t.label,t.id)));voiceDestination.value=selected&&[...voiceDestination.options].some(o=>o.value===selected)?selected:'focus';};
refreshVoiceDestinations();
const voiceDestinationLabel=document.createElement('label');voiceDestinationLabel.textContent='Demander une réaction à ';voiceDestinationLabel.append(voiceDestination);
const voiceRouteStatus=document.createElement('span');voiceRouteStatus.setAttribute('role','status');
const voiceThreadEditor=document.createElement('details');const voiceThreadSummary=document.createElement('summary');voiceThreadSummary.textContent='Nommer mes trois conversations';voiceThreadEditor.append(voiceThreadSummary);
for(const thread of threadSettings.get()){
 const row=document.createElement('label');row.textContent=thread.id+' ';
 const name=document.createElement('input');name.value=thread.label;name.maxLength=60;name.setAttribute('aria-label','Nom de '+thread.id);
 const save=()=>{try{threadSettings.update(threadSettings.get().map(t=>t.id===thread.id?{...t,label:name.value}:t));refreshVoiceDestinations();}catch(error){byId('chat-voice-status').textContent=message(error);}};
 name.addEventListener('change',save);row.append(name);voiceThreadEditor.append(row);
}
// Barge-in stays off until chosen: on loudspeakers the agent's own echo could cut it.
const bargeInSetting=bargeInPreference(recipientStorage);
const bargeInToggle=document.createElement('input');bargeInToggle.type='checkbox';bargeInToggle.id='voice-barge-in';bargeInToggle.checked=bargeInSetting.enabled();
bargeInToggle.addEventListener('change',()=>bargeInSetting.set(bargeInToggle.checked));
const bargeInLabel=document.createElement('label');bargeInLabel.append(bargeInToggle,' Couper la voix de l’agent dès que je parle (micro actif ; casque conseillé : sur haut-parleurs, l’écho peut couper la voix)');
byId('voice-advanced-controls').append(voiceDestinationLabel,voiceRouteStatus,voiceThreadEditor);byId('voice-advanced-controls').append(bargeInLabel);
const voiceCycle=mountVoiceCycle(document.body,()=>threadSettings.get());
window.addEventListener('voice-cycle',event=>voiceCycle.event((event as CustomEvent<VoiceCycleEvent>).detail));
void tauri?.event?.listen('voice-cycle',event=>voiceCycle.event((event as {payload:VoiceCycleEvent}).payload));
window.addEventListener('beforeunload',()=>voiceCycle.dispose());
let voiceMode:ReturnType<typeof mountVoiceMode>|undefined;
const desktopReader=desktopSpeech({
  speak:async(text,idempotency_key,metadata)=>{
    if(!tauri)return;
    const result=await tauri.core.invoke('elevenlabs',{action:'speak_desktop',payload:{text,idempotency_key,thread_id:metadata?.threadId??'principal',...(metadata?.agentRef?{agent_ref:metadata.agentRef}:{}),...(metadata?.cycleId?{cycle_id:metadata.cycleId}:{}),...((metadata?.threadId&&isVoiceThreadId(metadata.threadId)&&voiceMode?.state())?{expected_voice_revision:voiceMode.state()!.revision}:{})}}) as {stdout:string;exitCode:number};
    const envelope=JSON.parse(result.stdout) as {ok:boolean;error?:{message:string}};
    if(!envelope.ok || result.exitCode!==0)throw Error(envelope.error?.message??'Lecture ElevenLabs indisponible.');
  },
  error:note=>{byId('chat-voice-status').textContent=note;},
});
const dictationProviderSelect=byId<HTMLSelectElement>('chat-transcription-provider');
dictationProviderSelect.value='current';
dictationProviderSelect.addEventListener('change',()=>{byId('chat-voice-status').textContent='Prochaine dictée : '+dictationProviderLabel(selectedDictationProvider(dictationProviderSelect.value))+'. Aucun changement automatique après une erreur.';});
const mainTranscriptStatus=voiceTranscriptStatus(byId('general-conversation'));
const cancelDictation=document.createElement('button');
byId('chat-voice').after(cancelDictation);
const updateMainVoice=voiceChatControls(byId<HTMLButtonElement>('chat-voice'),cancelDictation);
let mainVoiceRecording=false,mainVoiceProcessing=false;
updateMainVoice(false,false);
cancelDictation.onclick=()=>{dictation.stop(true);};
const dictation = voiceChatController({
  owner:"Voice principal",
  provider:()=>selectedDictationProvider(dictationProviderSelect.value),
  invoke:async(command,args)=>{
    if(command!=="elevenlabs"){const envelope=await invoke(command,args);if(envelope.ok!==true)throw Error(errorText(envelope));return envelope.data as {text?:string};}
    if(!tauri)throw Error("Desktop local requis");
    const result=await tauri.core.invoke(command,args) as {stdout:string;exitCode:number};
    const envelope=JSON.parse(result.stdout) as {ok:boolean;data?:{text?:string};error?:{message:string}};
    if(!envelope.ok||result.exitCode!==0)throw Error(envelope.error?.message??"Dictée ElevenLabs indisponible ; utiliser la saisie manuelle.");
    return envelope.data??{};
  },
  transcribing:pending=>{mainTranscriptStatus(pending);voiceCycle.transcribing(pending);},
  screenshots:voiceScreenshots,
  ...(tauri?{visualSnapshot:sampleVoiceScreen}:{}),
  captureContext:capturedAt=>{
    const selection=voiceCapture.capture(capturedAt,isVoiceThreadId(voiceDestination.value)||voiceDestination.value==='principal'?voiceDestination.value:undefined,threadSettings.get());
    voiceRouteStatus.textContent=' · Réaction : '+(threadSettings.get().find(t=>t.id===selection.replyTo)?.label??'Marco')+' · les autres reçoivent pour information';
    return selection;
  },
  snapshot:async()=>{
    const envelope=await invoke('voice_input',{action:'snapshot'});
    if(envelope.ok!==true)throw Error(errorText(envelope));
    return JSON.stringify(envelope.data);
  },
  send:async(text,images,metadata)=>{
    if(!text.trim())return;
    if(!tauri)throw Error('Dictée disponible dans l’app desktop.');
    const allowed=()=>dictation.screenshotsAllowed(metadata.requestId)&&!dictation.cancelled(metadata.requestId);
    const screenRevision=principalScreenRevision;
    const imageReferences:string[]=[];
    let draft:VoiceScreenDraft|undefined;
    await deliverVoiceTranscript(text,images,metadata,metadata.voiceSelection?.threads??threadSettings.get(),{
      show:(key,body)=>outgoingBubble(key,body),
      update:(bubble,body)=>{bubble.querySelector('.conversation-body')?.replaceWith(conversationBody(body,null));},
      send:(key,envelope,bubble)=>transmitChat(
        key,envelope,bubble,false,
        imageReferences.filter(reference=>envelope.includes(`<${reference}>`)),
        ()=>principalScreenRevision===screenRevision&&voiceScreenshots.enabled(),
      ),
      cancelled:()=>dictation.cancelled(metadata.requestId),
      warning:note=>{byId('chat-voice-status').textContent=note;},
      imagesAllowed:()=>dictation.screenshotsAllowed(metadata.requestId),
      attachments:async(samples)=>{
        draft=await principalScreenComposer.compose(samples,metadata.capturedAt,allowed);
        const suffix=await voiceScreenshotAttachments(draft.images,{
          control:voiceScreenshots,allowed,cancelled:()=>dictation.cancelled(metadata.requestId),composed:true,
          importImage:async raw=>{
            const imported=await importVoiceScreenshot(raw,'screen.png');
            imageReferences.push(imported.reference);
            return imported;
          },
        });
        return allowed()?draft.references+suffix:'';
      },
      attachmentsSent:()=>draft?.commit(),
    });
  },
  processing:(pending,note)=>{mainVoiceProcessing=pending>0;updateMainVoice(mainVoiceRecording,mainVoiceProcessing);byId('voice-processing-status').textContent=note+(pending?' ('+pending+')':'');},
  state:(recording,note)=>{
    // Speech and microphone are independent; destinations freeze at recording start.
    voiceDestination.disabled=recording;
    dictationProviderSelect.disabled=recording||dictation.active();
    voiceMode?.microphoneChanged();
    mainVoiceRecording=recording;voiceCycle.listening(recording);updateMainVoice(recording,mainVoiceProcessing,!recording&&dictation.active());byId('chat-voice-status').textContent=note;
  },
});
const voiceGraph=mountVoiceGraph(byId('voice-graph'),command=>{if(!tauri)throw Error('Graphe disponible dans le desktop local');return tauri.core.invoke(command);});
window.addEventListener('beforeunload',()=>voiceGraph.dispose());
let lastVoiceMode:VoiceModeState|undefined;
if(tauri)voiceMode=mountVoiceMode((command,args)=>tauri.core.invoke(command,args),{
 microphoneActive:()=>dictation.active()&&!!dictation.stream()?.getAudioTracks().some(track=>track.readyState==='live'),
 startMicrophone:()=>dictation.start(),stopMicrophone:discard=>dictation.stop(discard),
 changed:state=>{const stop=voiceModeStopsDictation(lastVoiceMode,state);lastVoiceMode=state;if(stop){voiceCycle.event({kind:'stop',at:Date.now()});clearPrincipalScreen();dictation.stop(true);}},
});
mountVoiceSettingsSwitch(byId<HTMLButtonElement>('voice-switch'),byId('voice-switch-note'),voiceMode);
window.addEventListener('beforeunload',()=>voiceMode?.dispose());
byId('chat-voice').addEventListener('click',()=>{if(dictation.active())dictation.stop();else void dictation.start();});
void tauri?.event?.listen('voice-stop',()=>{clearPrincipalScreen();dictation.stop(true);window.dispatchEvent(new Event('fork-voice-stop'));voiceCycle.event({kind:'stop',at:Date.now()});});
window.addEventListener('beforeunload',()=>dictation.dispose());
const chatImages=bindChatImages({
  zone:byId('general-conversation'),field:byId<HTMLTextAreaElement>('chat-text'),
  preview:byId('chat-image-preview'),picker:byId<HTMLInputElement>('chat-image-files'),status:byId('chat-status'),
  invoke:(command,args)=>{if(!tauri)return Promise.reject(Error(tr('Images locales disponibles dans l’app')));return tauri.core.invoke(command,args);},
  ...(recipientStorage ? {storage:recipientStorage} : {}),
});
window.addEventListener('beforeunload',saveChatDraft);
const sendRemoteRecipient=recipientSender(invoke,()=>`ui-${crypto.randomUUID()}`,recipientStorage);
let broadcastPending: {key:string;text:string}|null=null;
try {broadcastPending=JSON.parse(recipientStorage?.getItem('mind-wake.broadcast-pending')??'null');}catch{}
let broadcastQueue: Promise<void> = Promise.resolve();
async function transmitBroadcast(pending:{key:string;text:string},bubble:HTMLLIElement):Promise<void>{
  const meta=bubble.querySelector("small")!;
  const fail=(detail:string):void=>{
    bubble.dataset["sending"]="false";bubble.dataset["failed"]="true";
    meta.textContent=tr("Toi · Échec de l’envoi : {0}",[detail]);
    // Le texte revient dans le champ (même clé gardée pour un renvoi sans doublon).
    broadcastPending=pending;
    try{recipientStorage?.setItem('mind-wake.broadcast-pending',JSON.stringify(pending));}catch{/* Affichage local. */}
    restoreChatText(pending.text);
    byId("chat-status").textContent=detail+" · brouillon conservé";
  };
  const slow=setTimeout(()=>{if(bubble.dataset["sending"]==="true")meta.textContent=tr("Toi · Envoi en cours… (lent, toujours en attente)");},6000);
  try{
    const result=await invoke("broadcast_send",{idempotencyKey:pending.key,text:pending.text});
    if(result.ok!==true)throw Error(errorText(result));
    const recipients=(result.data?.["recipients"]??[]) as {label:string;state:string;detail:string}[];
    const queued=recipients.filter(r=>r.state==="queued");
    const missed=recipients.filter(r=>r.state!=="queued");
    byId("broadcast-receipt").hidden=false;
    byId("broadcast-receipt-details").textContent=recipients.map(r=>`${r.label} : ${r.detail}`).join("\n");
    if(recipients.some(r=>r.state==="failed")){fail(`${missed.length} non joints : ${missed.map(r=>r.label).join(", ")}`);return;}
    bubble.dataset["sending"]="false";
    meta.textContent=tr("Toi · Parti ✓")+` · ${queued.length} en file`+(missed.length?` ; ${missed.length} non joints`:"");
    byId("chat-status").textContent=`${queued.length} en file · lecture non attestée`+(missed.length?` ; ${missed.length} non joints : ${missed.map(r=>r.label).join(", ")}`:"");
    if(broadcastPending===null)try{recipientStorage?.removeItem('mind-wake.broadcast-pending');}catch{/* Affichage local. */}
    void refreshChatSoon();
  }catch(error){fail(message(error));}
  finally{clearTimeout(slow);}
}
async function sendToAgent(): Promise<void> {
  if(chatImages.busy()) {byId('chat-status').textContent=tr('Import des images en cours…');return;}
  if(chatImages.text().length>4000) {byId('chat-status').textContent=tr('Le texte et les images dépassent la taille du message. Raccourcir le texte.');return;}
  if(byId<HTMLSelectElement>("chat-recipient").value==="all") {
    // « Tous » (destinataire habituel de NLR) : bulle dans le fil dès le clic, champ vidé,
    // envoi en arrière-plan ; un second envoi pendant le premier passe à la suite au lieu
    // d'être ignoré (16 nov. 2026, « pas sur send et ce qui s'en suit »).
    const field=byId<HTMLTextAreaElement>("chat-text"),text=chatImages.text();
    if(!text.trim())return;
    if(broadcastPending?.text!==text)broadcastPending={key:`ui-all-${crypto.randomUUID()}`,text};
    const pending=broadcastPending;
    broadcastPending=null;
    try{recipientStorage?.setItem('mind-wake.broadcast-pending',JSON.stringify(pending));}catch{/* Affichage local. */}
    // Même identifiant que la réponse enregistrée (`reply --idempotency-key`) : la relecture du
    // fil remplace la bulle par le message persisté, sans doublon.
    const bubble=outgoingBubble(pending.key,text);
    const meta=bubble.querySelector("small")!;
    bubble.dataset["sending"]="true";
    meta.textContent=tr("Toi · Envoi à tous en cours…");
    field.value="";chatImages.clear();saveChatDraft();field.focus();
    byId("chat-status").textContent="";
    const run=broadcastQueue.then(()=>transmitBroadcast(pending,bubble));
    broadcastQueue=run.catch(()=>undefined);
    await run;
    return;
  }
  if (byId<HTMLSelectElement>("chat-recipient").value === "auroracle") {
    if(chatImages.count()) {byId('chat-status').textContent=tr('Les images locales peuvent être envoyées aux agents de cette installation. Choisir Mon agent ou Tous.');return;}
    try {byId("chat-status").textContent=await sendRemoteRecipient(byId<HTMLTextAreaElement>("chat-text"));void refreshChatSoon();}
    catch(error){byId("chat-status").textContent=message(error);}
    saveChatDraft();
    return;
  }
  const field = byId<HTMLTextAreaElement>("chat-text");
  const text = chatImages.text();
  if (text === "") return;
  const key = `ui-${crypto.randomUUID()}`;
  const bubble = outgoingBubble(key, text);
  chatOutbox.add({key, text, at: new Date().toISOString()});
  field.value = "";
  chatImages.clear();
  saveChatDraft();
  field.focus();
  const sent = await transmitChat(key, text, bubble);
  chatOutbox.remove(key);
  if (!sent) restoreChatText(text);
}

async function transmitChat(key: string, text: string, bubble: HTMLLIElement, requestWake = true,
                            voiceScreenRefs: string[] = [], sharingAllowed = () => true): Promise<boolean> {
  const meta = bubble.querySelector("small")!;
  bubble.querySelector("button")?.remove();
  bubble.dataset["sending"] = "true";
  delete bubble.dataset["failed"];
  meta.textContent = tr("Toi · Envoi en cours…");
  // Jamais d'attente muette : au-delà de 6 s, le dire (la CLI répond ou échoue avant 15 s).
  const slow = setTimeout(() => { if (bubble.dataset["sending"] === "true") meta.textContent = tr("Toi · Envoi en cours… (lent, toujours en attente)"); }, 6000);
  try {
    if(voiceScreenRefs.length&&!sharingAllowed()){
      bubble.dataset["sending"]="false";
      meta.textContent="Partage écran arrêté · envoi de la planche annulé.";
      return false;
    }
    const envelope = await invoke("wake_reply", { idempotencyKey: key, text, ...(voiceScreenRefs.length?{voiceScreenRefs}:{}) });
    const detail = typeof envelope.data?.["detail"] === "string" ? envelope.data["detail"] : "";
    if (envelope.ok !== true) throw new Error(detail || errorText(envelope));
  } catch (error) {
    clearTimeout(slow);
    bubble.dataset["sending"] = "false";
    bubble.dataset["failed"] = "true";
    meta.textContent = tr("Toi · Échec de l’envoi : {0}", [message(error)]);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "message-retry";
    retry.textContent = tr("Réessayer");
    retry.addEventListener("click", () => { void transmitChat(key, text, bubble, requestWake, voiceScreenRefs, sharingAllowed); });
    bubble.append(retry);
    return false;
  }
  clearTimeout(slow);
  bubble.dataset["sending"] = "false";
  meta.textContent = tr("Toi · Parti ✓");
  // Texte rendu au champ après un échec puis renvoyé par « Réessayer » : pas de double.
  const sentField = byId<HTMLTextAreaElement>("chat-text");
  if (sentField.value === text) { sentField.value = ""; saveChatDraft(); }
  if (pendingBump?.key === key) pendingBump = null;
  // Refresh independently: waking the agent must never delay the sent receipt.
  void refreshChatSoon();
  if (!requestWake) { tick = 0; return true; }
  try {
    const wake = await invoke("wake_now");
    if (wake.ok !== true) {
      const detail = typeof wake.data?.["detail"] === "string" ? wake.data["detail"] : errorText(wake);
      byId("chat-status").textContent = tr("Message envoyé. Pas de réveil : {0}.", [detail]);
    }
  } catch (error) {
    byId("chat-status").textContent = tr("Message envoyé. Pas de réveil : {0}.", [message(error)]);
  }
  tick = 0;
  return true;
}

byId("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendToAgent();
});
// Rechargement pendant un envoi : la bulle revient et l'envoi reprend avec la même clé.
if (tauri !== undefined) for (const pending of chatOutbox.list()) {
  const bubble = outgoingBubble(pending.key, pending.text);
  void transmitChat(pending.key, pending.text, bubble).then((sent) => {
    chatOutbox.remove(pending.key);
    if (!sent) restoreChatText(pending.text);
  });
}

// --- Navigation et événements -------------------------------------------------------------

const callFrame = byId("call-frame") as HTMLIFrameElement;
const callOrigin = "http://127.0.0.1:8789";
const displayCallVision = callVisionFeed(byId("call-vision-feed"), async (call,after) => {
  const run = await tauri!.core.invoke("agent_prompts", {request:{action:"callVision",call,after}}) as CliRun;
  const result = JSON.parse(run.stdout);
  if (run.exitCode || result.error) throw Error(result.error ?? "Captures indisponibles");
  return result.events;
});
type DesktopInvite = {id:string; label:string; until:number; ringtone?: "common" | "marco" | "vox" | "equerre" | "rose_des_vents" | "medicis"};
let incomingCall: DesktopInvite | null = null;
let callOpenedAt = 0;
let callFrameLoaded = false;
const callFrameState = () => ({hidden: callFrame.hidden === true, loaded: callFrameLoaded, openedAt: callOpenedAt, now: Date.now()});
callFrame.addEventListener("load", () => { callFrameLoaded = true; });
// Rechargement de .reload-stamp différé pendant un appel (sonnerie ou en cours).
const uiReload = reloadGuard({reload: () => location.reload(), showPending: pendingBadge(document, () => location.reload())});
(window as unknown as {__mindWakeUiUpdated?: () => void}).__mindWakeUiUpdated = () => uiReload.requested();
setInterval(() => uiReload.check(), 5000);
function setPhoneToast(stage: "ringing" | "active" | null, invite: DesktopInvite | null) {
  uiReload.callStage(stage && invite ? stage : null, invite?.until);
  if (tauri) void tauri.core.invoke("phone_toast_set", {toast: stage && invite ? {stage, id:invite.id, label:invite.label, until:invite.until, ringtone:invite.ringtone ?? "common"} : null}).catch(console.error);
}
let callTimer: ReturnType<typeof setTimeout> | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
function releaseCallFrame() {
  clearTimeout(releaseTimer);
  callFrame.removeAttribute("src");
  callFrame.hidden = true;
}
function openCall() {
  displayCallVision("");
  clearTimeout(callTimer);
  byId("call-status").textContent = "Ouverture de l’appel…";
  byId("call-retry").hidden = true;
  callFrame.hidden = true;
  callOpenedAt = Date.now();
  callFrameLoaded = false;
  callFrame.src = callOrigin + (tauri ? "/desktop-call?receiver=desktop" : "/desktop-call");
  const waitForCall = () => {
    // Chargement lent (machine chargée) : attendre, ne pas annoncer une panne.
    if (callWaitStatus(callFrameState()) === "loading") {
      byId("call-status").textContent = "Ouverture de l’appel… (chargement lent)";
      callTimer = setTimeout(waitForCall, 5000);
      return;
    }
    byId("call-status").textContent = "Écran d’appel indisponible. Vérifie que la passerelle mobile est démarrée et que son export web est à jour.";
    byId("call-retry").hidden = false;
  };
  callTimer = setTimeout(waitForCall, 10000);
}
window.addEventListener("message", event => {
  if (event.source !== callFrame.contentWindow || event.origin !== callOrigin) return;
  if (tauri) {
    const message = event.data;
    if (message?.type === "mind.call.vision" && typeof message.id === "string" && /^[a-f0-9-]{36}$/i.test(message.id)) {
      displayCallVision(message.id);
      return;
    }
    if(message?.type === 'mind.phone.ringtone-capabilities' && typeof message.request === 'string'){
      const request=message.request;
      void tauri.core.invoke('phone_ringtone_keys').then(keys=>callFrame.contentWindow?.postMessage({type:'mind.phone.ringtone-capabilities',request,keys},callOrigin))
        .catch(()=>callFrame.contentWindow?.postMessage({type:'mind.phone.ringtone-capabilities',request,keys:[]},callOrigin));
      return;
    }
    if (message === "mind.phone.ended") {
      displayCallVision("");
      incomingCall = null;
      setPhoneToast(null, null);
      return;
    }
    if (message?.type === "mind.phone.ringing" && !incomingCall) {
      setPhoneToast(message.invite ? "ringing" : null, message.invite);
      return;
    }
    if (message?.type === "mind.phone.accepted" && message.invite) {
      incomingCall = message.invite;
      selectTab("call");
      setPhoneToast("active", incomingCall);
      return;
    }
  }
  if (!tauri && event.data === "mind.call.closed" && byId("view-call").hidden) releaseCallFrame();
  if (event.data !== "mind.call.ready") return;
  clearTimeout(callTimer);
  byId("call-status").textContent = "";
  byId("call-retry").hidden = true;
  callFrame.hidden = false;
});
if (tauri?.event) {
  setPhoneToast(null, null);
  void tauri.event.listen("phone-poll", () => {
    if (shouldReopenCall(callFrameState())) openCall();
    else callFrame.contentWindow?.postMessage("mind.phone.poll", callOrigin);
  });
  void tauri.event.listen("phone-toast-action", event => {
    const {id,action} = (event as {payload:{id:string;action:string}}).payload;
    if (action === "hangup" && incomingCall?.id === id)
      callFrame.contentWindow?.postMessage("mind.call.leave", callOrigin);
    else callFrame.contentWindow?.postMessage({type:"mind.phone.answer", id, action}, callOrigin);
  });
  openCall();
}
byId("call-retry").addEventListener("click", openCall);
byId("tab-call").addEventListener("click", () => selectTab("call"));
type Tab = "call" | "prompts" | "voice" | "panel" | "chat" | "second" | "forks" | "threads" | "agents" | "history" | "settings" | "authorizations" | "projects" | "documents";

let conversationTab: "general" | "second" | "forks" | "coach" = "general";
function selectConversation(tab: "general" | "second" | "forks" | "coach"): void {
  conversationTab = tab;
  byId("general-conversation").hidden = conversationTab !== "general";
  byId("view-second").hidden = conversationTab !== "second";
  byId("view-forks").hidden = conversationTab !== "forks";
  byId("view-coach").hidden = conversationTab !== "coach";
  byId("tab-coach").setAttribute("aria-selected",String(conversationTab === "coach"));
  if (tab !== "forks") document.querySelectorAll("[data-fork-tab]").forEach((button) => button.setAttribute("aria-selected", "false"));
  byId("conversation-general").setAttribute("aria-selected", String(conversationTab === "general"));
  byId("tab-second").setAttribute("aria-selected", String(conversationTab === "second"));
}
function selectTab(tab: Tab): void {
  if (tab === "second") { selectConversation("second"); return; }
  if (tab === "forks") { selectConversation("forks"); return; }
  if (tab === "call") {
    clearTimeout(releaseTimer);
    if (!callFrame.hasAttribute("src")) openCall();
  }
  if (tab !== "call" && !byId("view-call").hidden) {
    clearTimeout(callTimer);
    if (tauri) callFrame.contentWindow?.postMessage("mind.call.leave", callOrigin);
    else if (callFrame.hidden) releaseCallFrame();
    else {
      callFrame.contentWindow?.postMessage("mind.call.leave", callOrigin);
      releaseTimer = setTimeout(releaseCallFrame, 1500);
    }
  }
  if (tab === "chat") selectConversation("general");
  document.querySelector("main")?.setAttribute("data-active-tab", tab);
  byId("tab-documents").setAttribute("aria-selected", String(tab === "documents"));
  for (const name of ["call", "panel", "chat", "threads", "agents", "history", "settings", "authorizations", "projects", "voice", "prompts"] as const) {
    byId(`tab-${name}`).setAttribute("aria-selected", String(name === tab));
    byId(`view-${name}`).hidden = name !== "chat" && name !== tab;
  }
  byId("view-documents").hidden = tab !== "documents" && tab !== "chat";
  chatOpen = true;
  if (tab === "prompts") void prompts.open();
  if (tab === "authorizations") void authorizations.open();
  if (tab === "threads") void refreshThreads();
  if (!chatHasOpened || tab === "chat") {
    chatHasOpened=true;
    void refreshChat();
  }
  if (tab === "agents") void refreshAgentThreads();
  if (tab === "history") {
    void refreshWakeHistory();
    try { localStorage.setItem("mind-wake-history-visited", "true"); } catch { /* Display preference. */ }
  }
  try { localStorage.setItem("mind-wake-active-tab", tab); } catch { /* Display preference only. */ }
}

byId("tab-prompts").addEventListener("click", () => selectTab("prompts"));
byId("tab-voice").addEventListener("click",()=>selectTab("voice"));
byId("tab-panel").addEventListener("click", () => {
  selectTab("panel");
});
byId("conversation-general").addEventListener("click", () => selectConversation("general"));
byId("tab-chat").addEventListener("click", () => {
  selectTab("chat");
});
byId("tab-threads").addEventListener("click", () => {
  selectTab("threads");
});
byId("thread-back").addEventListener("click", () => {
  openThread = null;
  byId("thread").hidden = true;
  byId("threads").hidden = false;
  byId("reply-status").textContent = "";
});
byId("reply-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendReply();
});

byId("mode-on").addEventListener(
  "click",
  () => void control("wake_on", tr("Allumé : réveils autorisés.")),
);
byId("mode-always").addEventListener(
  "click",
  () => void control("wake_always_on", tr("Always-on activé.")),
);
byId("mode-wake").addEventListener("click", () => void control("wake_now", tr("Réveil demandé.")));
byId("pause").addEventListener("click", () => {dictation.stop(true);window.dispatchEvent(new Event("fork-voice-stop"));void voiceMode?.pause(true);void control("wake_pause", tr("Pause appliquée."));});
byId("mode-off").addEventListener("click", () => {
  // Deux clics rapprochés : l'arrêt d'urgence ne se lève que par une action explicite
  // ultérieure de l'humain, une confirmation évite qu'un clic égaré l'impose.
  if (Date.now() < stopArmedUntil) {
    stopArmedUntil = 0;
    window.dispatchEvent(new Event("fork-voice-stop"));
    void control("wake_stop", tr("Arrêt d'urgence appliqué."));
  } else {
    stopArmedUntil = Date.now() + 5000;
    render(panelView(lastRead, Date.now()));
  }
});

// Fil principal On/Off : état lu dans `wake status`, rendu à chaque rafraîchissement.
const mainThreadView = tauri === undefined ? null : mountMainThread({
  invoke: async (cmd, args) => invoke(cmd, args),
  refresh: async () => { tick = 0; await refresh(); },
});

void refresh();
setInterval(() => void refresh(), POLL_MS);

if (tauri !== undefined) mountCoach({
  invoke: async (cmd,args) => invoke(cmd,args),
  selectTab: () => selectConversation("coach"),
  decorate: (body,text) => {messageLinks(body);appendMessageImages(body,text,(cmd,args)=>tauri.core.invoke(cmd,args));},
});
if (tauri !== undefined) mountForks({
  liveReply: {
    read: id => tauri.core.invoke("fork_reply_draft", { id }),
    show: text => tauri.event?.emitTo?.("paint", "voice-reply-subtitle", text) ?? Promise.resolve(),
  },
  voiceScreenshots,
  ...(tauri?{sampleVoiceScreen}:{}),
  importVoiceImage:raw=>importVoiceScreenshot(raw,'screen.png'),
  invoke: async (cmd, args) => invoke(cmd, args),
  selectTab: () => selectTab("forks"),
  decorate: (body, text) => {
    messageLinks(body);
    appendMessageImages(body, text, (command, args) => tauri.core.invoke(command, args));
  },
});

if (tauri !== undefined) mountSecondThread({
  invoke: async (cmd, args) => invoke(cmd, args),
  selectTab: () => selectTab("second"),
  decorate: (body, text) => {
    messageLinks(body);
    appendMessageImages(body, text, (command, args) => tauri.core.invoke(command, args));
  },
});

// Repo-agent conversations: read-only observation of the actual exchanged messages.
let agentThreads: RepoThread[] = [];
let selectedAgentThread: string | null = null;
function renderAgentThreads(): void {
  byId("agents-count").textContent = String(agentThreads.length);
  byId("agents-count").hidden = agentThreads.length === 0;
  byId("agents-status").textContent = agentThreads.length ? "" : tr("Aucune conversation entre agents enregistrée.");
  const selected = agentThreads.find(t => t.id === selectedAgentThread);
  byId("agents-list").hidden = selected !== undefined;
  byId("agent-thread").hidden = selected === undefined;
  byId("agents-list").replaceChildren(...agentThreads.map(t => {
    const li = document.createElement("li"), button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("strong"), detail = document.createElement("small"), preview = document.createElement("span");
    title.textContent = `Wake ↔ ${t.project}`;
    detail.textContent = `${t.runtime} · ${t.messages.length} messages · ${new Date(t.messages.at(-1)?.at ?? "").toLocaleString(formatLocale())}`;
    preview.className = "thread-preview"; preview.textContent = t.messages.at(-1)?.text.slice(0, 180) ?? "";
    button.append(title, detail, preview);
    button.addEventListener("click", () => { selectedAgentThread = t.id; renderAgentThreads(); });
    li.append(button); return li;
  }));
  if (!selected) return;
  byId("agent-thread-title").textContent = `Wake ↔ ${selected.project}`;
  byId("agent-thread-pointers").textContent = tr("Repo : {0}\nSession {1} : {2}\nHistorique : {3}\nFil : {4}", [selected.repo, selected.runtime, selected.sessionId, selected.transcript, selected.id]);
  byId("agent-thread-messages").replaceChildren(...selected.messages.map(m => {
    const li = document.createElement("li"), meta = document.createElement("small"), body = renderMarkdown(m.text);
    li.dataset["self"] = String(m.from === "wake");
    li.dataset["from"] = m.from === "repo" ? "session" : "agent"; li.dataset["messageId"] = m.id;
    meta.textContent = `${m.from === "system" ? tr("État de la consultation") : m.from === "wake" ? tr("Agent Wake") : `Session ${selected.runtime} · ${selected.project}`} · ${new Date(m.at).toLocaleString(formatLocale())}`;
    messageLinks(body);
    appendMessageImages(body, m.text, (command, args) => tauri!.core.invoke(command, args));
    li.append(meta, body, copyButton(() => m.text));
    if (m.from === "repo" && m.text.length === 4000 && Date.parse(m.at) < Date.parse("2026-10-30T16:00:00Z")) {
      const notice = document.createElement("p"); notice.className = "hint";
      notice.textContent = tr("Cette réponse historique atteint l’ancienne limite de 4 000 caractères : elle peut être incomplète.");
      li.append(notice);
    }
    return li;
  }));
}
async function refreshAgentThreads(): Promise<void> {
  try {
    const env = await invoke("wake_messages");
    if (env.ok !== true) throw new Error(errorText(env));
    agentThreads = repoThreads(env); renderAgentThreads();
  } catch (error) { byId("agents-status").textContent = tr("Conversations indisponibles : {0}", [message(error)]); }
}
byId("tab-agents").addEventListener("click", () => selectTab("agents"));
byId("agent-thread-back").addEventListener("click", () => { selectedAgentThread = null; renderAgentThreads(); });
void refreshAgentThreads();
setInterval(() => { if (!byId("view-agents").hidden) void refreshAgentThreads(); }, POLL_MS);

interface WakeTurnView {
  id: string; sessionId: string; at: string; prompt: string;
  promptMissing?: boolean;
  responses: {id:string;at:string;text:string}[];
}
let wakeTurns: WakeTurnView[] = [];
let wakeHistoryNote = "";
let wakeHistorySignature = "";
function renderWakeHistory(): void {
  const pane=byId("view-history");
  const firstRender=wakeHistorySignature==="";
  const follow=firstRender || pane.scrollHeight-pane.scrollTop-pane.clientHeight<100;
  const oldTop=pane.scrollTop;
  const expanded=new Set([...byId("wake-history-messages").querySelectorAll<HTMLDetailsElement>("details[open]")].map(d=>d.dataset["turnId"]));
  const signature=JSON.stringify({turns:wakeTurns,note:wakeHistoryNote});
  if(signature===wakeHistorySignature)return;
  wakeHistorySignature=signature;
  byId("wake-history-status").textContent = wakeHistoryNote || (!wakeTurns.length ? tr("Aucun échange disponible.") : "");
  const items=wakeTurns.flatMap(turn=>[
    {id:turn.id,at:turn.at,text:turn.prompt,prompt:true,missing:turn.promptMissing===true},
    ...turn.responses.map(r=>({...r,prompt:false,missing:false})),
    ...(turn.responses.length ? [] : [{id:`pending:${turn.id}`,at:turn.at,text:tr("Aucune réponse visible enregistrée pour ce réveil pour le moment."),prompt:false,missing:false}]),
  ]);
  byId("wake-history-messages").replaceChildren(...items.map(m=>{
    const li=document.createElement("li"),meta=document.createElement("strong"),body=document.createElement("p");
    li.dataset["from"]=m.prompt?"prompt":"agent";
    li.dataset["messageId"]=m.id;
    const pending=m.id.startsWith("pending:");
    if(pending)li.className="wake-placeholder";
    meta.textContent=`${pending?tr("État du réveil"):m.prompt?m.missing?tr("Échange partiel"):tr("Réveil"):tr("Réponse de l’agent")} · ${new Date(m.at).toLocaleString(formatLocale())}`;
    if(m.prompt) {
      const cue=document.createElement("p"),details=document.createElement("details"),summary=document.createElement("summary"),pre=document.createElement("pre");
      cue.className="wake-cue";cue.textContent=m.missing?tr("Début de ce réveil non chargé"):m.text.split("\n")[0]??m.text;
      summary.textContent=tr("Voir le prompt complet et son contexte");
      pre.textContent=m.text;details.dataset["turnId"]=m.id;details.open=expanded.has(m.id);details.append(summary,pre);li.append(meta,cue);if(!m.missing)li.append(details);
    } else { body.textContent=m.text;messageLinks(body);appendMessageImages(body,m.text,(command,args)=>tauri!.core.invoke(command,args));li.append(meta,body); }
    return li;
  }));
  pane.scrollTop=follow?pane.scrollHeight:oldTop;
}
async function refreshWakeHistory(): Promise<void> {
  try {
    const env=await invoke("wake_history");
    if(env.ok!==true)throw new Error(errorText(env));
    const data=env.data;
    if(!data || !Array.isArray(data["turns"]))throw new Error(tr("Format inattendu"));
    const locations=data["locations"] as {workspace?:string;systemPrompt?:string|null} | undefined;
    byId<HTMLButtonElement>("open-system-prompt").disabled=!locations?.systemPrompt;
    byId("open-system-prompt").title=locations?.systemPrompt ?? tr("Aucun prompt MIND chargé disponible.");
    byId("open-agent-folder").title=locations?.workspace ?? tr("Dossier de travail de l’agent");
    wakeTurns=data["turns"] as WakeTurnView[];
    wakeHistoryNote=typeof data["note"]==="string"?data["note"]:"";
    renderWakeHistory();
  } catch(error) {byId("wake-history-status").textContent=tr("Historique indisponible : {0}", [message(error)]);}
}
byId("tab-history").addEventListener("click",()=>selectTab("history"));
async function openWakeLocation(kind: "workspace" | "systemPrompt"): Promise<void> {
  const status=byId("runtime-link-status");
  try {
    if(!tauri)throw new Error(tr("Ouvrir depuis l’app desktop."));
    await tauri.core.invoke("wake_open_location",{kind});
    status.textContent=kind==="workspace"?tr("Dossier ouvert dans l’Explorateur."):tr("Prompt système MIND ouvert dans le Bloc-notes.");
  } catch(error){status.textContent=message(error);}
}
byId("open-system-prompt").addEventListener("click",()=>void openWakeLocation("systemPrompt"));
byId("open-agent-folder").addEventListener("click",()=>void openWakeLocation("workspace"));
setInterval(()=>{if(!byId("view-history").hidden)void refreshWakeHistory();},5000);
selectTab("documents");
const onboarding = tauri ? mountOnboarding((command, args) => tauri.core.invoke(command, args), () => selectTab("chat")) : null;
void onboarding?.refresh();
setInterval(() => void onboarding?.refresh(), 5000);

// Updates have their own status: no interference with agent activity or drafts.
let updateBusy = false;
async function refreshAppUpdate(check = false): Promise<void> {
  if (!tauri || updateBusy) return;
  const button = byId<HTMLButtonElement>("app-update-check");
  const label = byId("app-update-status");
  if (check) { updateBusy = true; button.disabled = true; label.textContent = tr("Vérification et installation en cours…"); }
  try {
    const result = await tauri.core.invoke("app_update", {check}) as {state: string; development?: boolean; message?: string; revision?: string};
    const labels: Record<string, string> = {
      disabled: tr("Désactivé en mode développement."), idle: tr("Vérification automatique au démarrage et toutes les 6 heures."),
      checking: tr("Recherche d’une mise à jour…"), building: tr("Installation en arrière-plan…"),
      busy: tr("Une mise à jour est déjà en cours."), current: tr("Application à jour."),
      installed: tr("Mise à jour installée. Quittez puis rouvrez le panneau pour l’utiliser. Les sessions déjà actives continuent avec leur version actuelle."),
      error: tr("Échec de la mise à jour. La version précédente est conservée."),
    };
    label.textContent = result.development ? tr("Désactivé en mode développement.") : (labels[result.state] || result.state);
    if (result.message && !result.development) label.textContent += ` ${result.message}`;
    button.disabled = !!result.development || ["building", "checking", "busy"].includes(result.state);
  } catch (error) { label.textContent = String(error); button.disabled = false; }
  finally { updateBusy = false; }
}
byId("app-update-check").addEventListener("click", () => { void refreshAppUpdate(true); });
void refreshAppUpdate();
setInterval(() => { void refreshAppUpdate(); }, 5000);

// Build metadata stays accurate while an update is staged for the next launch.
async function showAppVersion(): Promise<void> {
  const version = byId("app-version");
  const sourceDate = byId("app-revision-date");
  const buildDate = byId("app-build-date");
  const formatDate = (value: string): string => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? tr("Indisponible") : date.toLocaleString(formatLocale(), {dateStyle: "long", timeStyle: "short"});
  };
  try {
    if (!tauri) throw new Error(tr("hors de l’application"));
    const info = await tauri.core.invoke("app_version") as {
      version: string; revision: string; revisionDate: string; builtAt: string; dirty: string; debug: boolean;
    };
    version.textContent = `v${info.version} · ${info.revision ? info.revision.slice(0, 12) : tr("révision inconnue")}${info.debug ? " · dev" : ""}${info.dirty === "true" ? tr(" · modifications locales") : ""}`;
    sourceDate.textContent = formatDate(info.revisionDate) + (info.dirty === "true" ? tr(" (dernier commit ; modifications locales incluses dans ce build)") : "");
    buildDate.textContent = formatDate(new Date(Number(info.builtAt) * 1000).toISOString());
  } catch {
    version.textContent = tr("Version indisponible");
    sourceDate.textContent = tr("Indisponible");
    buildDate.textContent = tr("Indisponible");
  }
}
void showAppVersion();

const engineSelect = byId("agent-engine") as HTMLSelectElement;
let savedEngine = "";
async function updateAgentEngine(preferred?: string) {
  if (!tauri) return;
  engineSelect.disabled = true;
  try {
    const request = { action: "agentEngine", preferred };
    const run = await tauri.core.invoke("agent_prompts", {request}) as CliRun;
    const result = JSON.parse(run.stdout);
    if (run.exitCode || result.error) throw Error(result.error ?? "Réglage indisponible");
    savedEngine = result.preferred ?? "";
    byId("agent-engine-status").textContent = preferred ? "Choix enregistré." : "";
  } catch (err) {
    byId("agent-engine-status").textContent = String(err);
  } finally {
    engineSelect.value = savedEngine;
    engineSelect.disabled = false;
  }
}
engineSelect.addEventListener("change", () => void updateAgentEngine(engineSelect.value));
byId("tab-settings").addEventListener("click", () => { selectTab("settings"); void updateAgentEngine(); });
if (tauri) initDuo((command, args) => tauri.core.invoke(command, args));
if (tauri) initWorkspaceSync((command, args) => tauri.core.invoke(command, args));
if (tauri) {const voicePlayer=initElevenLabs((command, args) => tauri.core.invoke(command, args), voiceChatPlayback,clip=>{voiceCapture.played(clip);voiceRouteStatus.textContent=" · Dernier vocal : "+(threadSettings.get().find(t=>t.id===clip.threadId)?.label??"non attribué")+" · tes prochains messages vont aux destinataires choisis";},event=>voiceCycle.event(event));
  voiceChatBargeIn({enabled:()=>bargeInSetting.enabled(),interrupt:()=>{if(bargeInSetting.enabled())voicePlayer.interrupt();}});}
if (tauri) mountFastReply((command,args)=>tauri.core.invoke(command,args));
if (tauri) mountTelegramAccount((command,args)=>tauri.core.invoke(command,args));

byId("tab-documents").addEventListener("click", () => { selectTab("documents"); });
if (tauri) {
  initDocuments((command, args) => tauri.core.invoke(command, args));
}
byId("tab-authorizations").addEventListener("click", () => { selectTab("authorizations"); });

byId("tab-projects").addEventListener("click",()=>selectTab("projects"));
if(tauri)initProjects((command,args)=>tauri.core.invoke(command,args));


