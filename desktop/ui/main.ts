import { tr, formatLocale } from "./i18n.js";
import { initDuo } from "./duo.js";
import { initAutoCall } from "./auto-call.js";
import { initProjects } from "./projects.js";
import { mountWakePreview } from "./wake-preview.js";
import { initWorkspaceSync } from "./workspace-sync.js";
import { initElevenLabs } from "./elevenlabs.js";
import { mountSttVocabularySettings } from "./stt-vocabulary-settings.js";
import { mountFastReply } from "./fast-reply.js";
import { mountTelegramAccount } from "./telegram-account.js";
import { mountPontP2P } from "./pont-p2p.js";
import { initDocuments } from "./documents.js";
import { mountMainThread } from "./main-thread.js";
import { mountAgentControls } from "./agent-controls.js";
import { activityModel, type ActivityModel } from "./activity.js";
import { mountPromptEditor } from "./prompt-editor.js";
import { callVisionFeed } from "./call-vision.js";
import { plainText } from "./conversation.js";
import { mountConversation } from "./conversation-panel.js";
import { copyButton } from "./copy-button.js";
import { authorMarker } from "./author-tint.js";
import { appendMessageImages } from "./message-images.js";
import { decorateMessageLinks } from "./message-links.js";
import { LIGHT_LABELS, panelView, type Line, type PanelView, type StatusRead } from "./view.js";
import { reloadGuard, pendingBadge } from "./reload-guard.js";
import { CALL_RETRY_MS, shouldReopenCall, callWaitStatus } from "./call-frame.js";

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
const prompts = mountPromptEditor(async request => {
  if (!tauri) throw Error("Ouvre cet onglet dans MIND Wake.");
  const run = await tauri.core.invoke("agent_prompts", {request}) as CliRun;
  const result = JSON.parse(run.stdout);
  if (run.exitCode || result.error) throw Error(result.error ?? "Prompts indisponibles");
  return result;
});
const POLL_MS = 2000;
const CHART_EVERY = 5;
const DAY_MS = 86_400_000;
const SEEN_KEY = "mind-wake.seen-sequence";

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

function messageLinks(body: HTMLElement): void {
  decorateMessageLinks(body, (command, args) => {
    if (!tauri) return Promise.reject(Error(tr("Ouverture disponible dans l’application MIND Wake")));
    return tauri.core.invoke(command, args);
  });
}

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
  try {
    const envelope = await invoke("wake_status");
    lastRead = { ok: true, fetchedAt: Date.now(), envelope };
    mainThreadView?.update(envelope.data);
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
  window.dispatchEvent(new Event("wake-interface-ready"));
  if (tick % CHART_EVERY === 0) await refreshChart();
  if (tick % CHART_EVERY === 0) await refreshThreads();
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
  off.textContent = armed ? tr("Confirmer l'arrêt") : tr("Arrêt");
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

// --- Navigation et événements -------------------------------------------------------------

const callFrame = byId("call-frame") as HTMLIFrameElement;
const callOrigin = "http://127.0.0.1:8789";
const displayCallVision = callVisionFeed(byId("call-vision-feed"), async (call,after) => {
  const run = await tauri!.core.invoke("agent_prompts", {request:{action:"callVision",call,after}}) as CliRun;
  const result = JSON.parse(run.stdout);
  if (run.exitCode || result.error) throw Error(result.error ?? "Captures indisponibles");
  return result.events;
}, message => callFrame.contentWindow?.postMessage(message, callOrigin));
type DesktopInvite = {id:string; label:string; until:number; ringtone?: "common" | "marco" | "vox" | "equerre" | "rose_des_vents" | "medicis"};
let incomingCall: DesktopInvite | null = null;
let callOpenedAt = 0;
let callFrameLoaded = false;
let callFrameReady = false;
const callFrameState = () => ({hidden: !callFrameReady, loaded: callFrameLoaded, openedAt: callOpenedAt, now: Date.now()});
callFrame.addEventListener("load", () => { callFrameLoaded = true; });
// Rechargement de .reload-stamp différé pendant un appel (sonnerie ou en cours).
const uiReload = reloadGuard({reload: () => location.reload(), showPending: pendingBadge(document, () => location.reload())});
(window as unknown as {__mindWakeUiUpdated?: () => void}).__mindWakeUiUpdated = () => uiReload.requested();
setInterval(() => uiReload.check(), 5000);
function setPhoneToast(stage: "ringing" | "active" | null, invite: DesktopInvite | null) {
  uiReload.callStage(stage && invite ? stage : null, invite?.until);
  // NLR, 17 nov. 2026 : le toast ne sert qu'à la sonnerie. Dès le décroché (stage « active »)
  // on le retire, sans compter sur la version native : un ancien binaire garderait sinon un
  // toast « En appel » par-dessus le fil. Le raccrochage se fait dans l'onglet Appel.
  // (uiReload.callStage ci-dessus garde « active » : le rechargement reste différé pendant l'appel.)
  const toast = stage === "ringing" && invite ? {stage, id:invite.id, label:invite.label, until:invite.until, ringtone:invite.ringtone ?? "common"} : null;
  if (tauri) void tauri.core.invoke("phone_toast_set", {toast}).catch(console.error);
}
let callTimer: ReturnType<typeof setTimeout> | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
function releaseCallFrame() {
  clearTimeout(releaseTimer);
  clearTimeout(callTimer);
  callFrame.removeAttribute("src");
  callFrameReady = false;
  callFrame.hidden = true;
}
function openCall() {
  displayCallVision("");
  clearTimeout(callTimer);
  byId("call-status").textContent = "Ouverture de l’appel…";
  byId("call-retry").hidden = true;
  // A display:none iframe can defer React's rendering in WebView2. Waiting for
  // its mount effect before showing it makes readiness depend on visibility.
  callFrameReady = false;
  callFrame.hidden = false;
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
    // Recover even when the native phone-poll event is absent. A late ready
    // message cancels this retry before it can interrupt a loaded call.
    callTimer = setTimeout(openCall, CALL_RETRY_MS);
  };
  callTimer = setTimeout(waitForCall, 10000);
}
window.addEventListener("message", event => {
  if (event.source !== callFrame.contentWindow || event.origin !== callOrigin) return;
  if (event.data === 'mind.call.recovering') { selectTab('call'); return; }
  if (tauri) {
    const message = event.data;
    if (message?.type === "mind.call.open-url" && typeof message.url === "string") {
      // Lien d'un message d'appel : l'iframe est sandboxée, le navigateur externe s'ouvre d'ici (comme message-links.ts).
      try { const u = new URL(message.url); if (u.protocol === "http:" || u.protocol === "https:") void tauri.core.invoke("open_external_url", {url: u.href}).catch(console.error); } catch { /* URL invalide */ }
      return;
    }
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
  callFrameReady = true;
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
const conversationPanel = tauri ? mountConversation({
  invoke: (command, args) => invoke(command, args),
  decorate: (body, text) => {
    messageLinks(body);
    appendMessageImages(body, text, (command, args) => tauri.core.invoke(command, args));
  },
}) : null;
void tauri?.event?.listen("owner-messages-changed", () => void conversationPanel?.refresh());
byId("tab-chat").addEventListener("click", () => selectTab("chat"));
const tabs = ["call", "chat", "panel", "threads", "settings", "projects", "prompts", "documents"] as const;
type Tab = typeof tabs[number];
function selectTab(tab: Tab): void {
  if (tab === "call") {
    clearTimeout(releaseTimer);
    if (!callFrame.hasAttribute("src")) openCall();
  }
  if (tab !== "call" && !byId("view-call").hidden && !byId("view-call").classList.contains("call-preloaded")) {
    clearTimeout(callTimer);
    if (tauri) callFrame.contentWindow?.postMessage("mind.call.leave", callOrigin);
    else if (callFrame.hidden) releaseCallFrame();
    else {
      callFrame.contentWindow?.postMessage("mind.call.leave", callOrigin);
      releaseTimer = setTimeout(releaseCallFrame, 1500);
    }
  }
  document.querySelector("main")?.setAttribute("data-active-tab", tab);
  byId("tab-documents").setAttribute("aria-selected", String(tab === "documents"));
  for (const name of tabs) {
    byId(`tab-${name}`).setAttribute("aria-selected", String(name === tab));
    byId(`view-${name}`).hidden = name !== "chat" && name !== tab;
  }
  byId("view-documents").hidden = tab !== "documents" && tab !== "chat";
  // WebView2 can suspend a display:none cross-origin frame before React mounts.
  // Keep the phone receiver laid out behind the desktop, inert and inaccessible.
  if (tauri) {
    const callView = byId("view-call");
    callView.hidden = false;
    callView.inert = tab !== "call";
    callView.classList.toggle("call-preloaded", tab !== "call");
    callView.setAttribute("aria-hidden", String(tab !== "call"));
  }
  if (tab === "prompts") void prompts.open();
  void conversationPanel?.refresh();
  if (tab === "threads") void refreshThreads();
  try { localStorage.setItem("mind-wake-active-tab", tab); } catch { /* Display preference only. */ }
}

byId("tab-prompts").addEventListener("click", () => selectTab("prompts"));
byId("tab-panel").addEventListener("click", () => {
  selectTab("panel");
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
byId("pause").addEventListener("click", () => {void control("wake_pause", tr("Pause appliquée."));});
byId("mode-off").addEventListener("click", () => {
  // Deux clics rapprochés : l'arrêt ne se lève que par une action explicite
  // ultérieure de l'humain, une confirmation évite qu'un clic égaré l'impose.
  if (Date.now() < stopArmedUntil) {
    stopArmedUntil = 0;
    void control("wake_stop", tr("Arrêt appliqué."));
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

let initialTab: Tab = "documents";
try {
  const saved = localStorage.getItem("mind-wake-active-tab");
  if (tabs.some(tab => tab === saved)) initialTab = saved as Tab;
} catch { /* Display preference only. */ }
selectTab(initialTab);
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
let savedEngine = "claude";
async function updateAgentEngine(preferred?: string) {
  if (!tauri) return;
  engineSelect.disabled = true;
  try {
    const request = { action: "agentEngine", preferred };
    const run = await tauri.core.invoke("agent_prompts", {request}) as CliRun;
    const result = JSON.parse(run.stdout);
    if (run.exitCode || result.error) throw Error(result.error ?? "Réglage indisponible");
    savedEngine = result.preferred ?? "claude";
    byId("agent-engine-status").textContent = preferred ? "Choix enregistré pour tous les agents." : "";
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
if (tauri) initAutoCall((command, args) => tauri.core.invoke(command, args));
if (tauri) initWorkspaceSync((command, args) => tauri.core.invoke(command, args));
if (tauri) mountFastReply((command,args)=>tauri.core.invoke(command,args));
if (tauri) mountTelegramAccount((command,args)=>tauri.core.invoke(command,args));
if (tauri) mountPontP2P((command,args)=>tauri.core.invoke(command,args));

byId("tab-documents").addEventListener("click", () => { selectTab("documents"); });
if (tauri) {
  initDocuments((command, args) => tauri.core.invoke(command, args));
}


byId("tab-projects").addEventListener("click",()=>selectTab("projects"));
if(tauri)initProjects((command,args)=>tauri.core.invoke(command,args));



if (tauri) {
  mountAgentControls((command, args) => invoke(command, args));
  initElevenLabs((command, args) => tauri.core.invoke(command, args));
}
void mountSttVocabularySettings(byId<HTMLFormElement>('stt-vocabulary-form'),byId<HTMLTextAreaElement>('stt-vocabulary-terms'),byId<HTMLInputElement>('stt-vocabulary-elevenlabs'),byId('stt-vocabulary-status'),tauri?(action,audio)=>invoke('voice_input',{action,audio}):undefined);
