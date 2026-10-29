/**
 * Panneau « Que fait mon agent ? » et fils privés. Chaque lecture et chaque action passe
 * par une commande Rust qui exécute la CLI correspondante (`mind-wake … --json`,
 * `owner-main.ts … --json`). Aucun appel modèle, aucun secret, aucun accès réseau : le
 * webview ne parle qu'au processus Tauri. Le texte des messages est inséré comme texte,
 * jamais comme HTML.
 */

import { activityModel, type ActivityModel } from "./activity.js";
import { LIGHT_LABELS, panelView, type Line, type PanelView, type StatusRead } from "./view.js";

interface TauriGlobal {
  readonly core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
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
const POLL_MS = 2000;
const CHART_EVERY = 5;
const DAY_MS = 86_400_000;
const SEEN_KEY = "mind-wake.seen-sequence";

let lastRead: StatusRead | null = null;
let stopArmedUntil = 0;
let tick = 0;
let openThread: string | null = null;
let lastMessageId: string | null = null;
let draftKey: string | null = null;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- type d'élément choisi par l'appelant
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`élément #${id} absent`);
  return el as T;
}

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<Envelope> {
  if (tauri === undefined) throw new Error("hors de l'application desktop");
  const run = (await tauri.core.invoke(cmd, args)) as CliRun;
  return JSON.parse(run.stdout) as Envelope;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorText(envelope: Envelope): string {
  const m = envelope.error?.message;
  return typeof m === "string" ? m : "refusé";
}

// --- Agent : statut, voyant, sélecteur ---------------------------------------------------

async function refresh(): Promise<void> {
  try {
    const envelope = await invoke("wake_status");
    lastRead = { ok: true, fetchedAt: Date.now(), envelope };
  } catch (error) {
    lastRead = { ok: false, fetchedAt: Date.now(), error: message(error) };
  }
  render(panelView(lastRead, Date.now()));
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
  light.setAttribute("aria-label", `Voyant : ${LIGHT_LABELS[view.light]}`);
  light.title = LIGHT_LABELS[view.light];
  byId("headline").textContent = view.headline;
  byId("reason").textContent = view.reason;
  byId("simulated").hidden = !view.simulated;
  byId("last-contact").textContent = `Dernier contact avec Wake : ${view.lastContact}`;
  fillLines("activity", view.activity);
  fillLines("consumption", view.consumption);
  fillLines("protection", view.protection);

  const on = byId<HTMLButtonElement>("mode-on");
  const wake = byId<HTMLButtonElement>("mode-wake");
  const off = byId<HTMLButtonElement>("mode-off");
  on.setAttribute("aria-pressed", String(view.light === "on"));
  wake.setAttribute("aria-pressed", String(view.light === "awake"));
  off.setAttribute("aria-pressed", String(view.light === "forced_off"));
  on.disabled = !view.canResume;
  wake.disabled = !view.canWake;
  off.disabled = !view.canStop;
  byId<HTMLButtonElement>("pause").disabled = !view.canPause;
  const armed = Date.now() < stopArmedUntil;
  off.textContent = armed ? "Confirmer l'arrêt" : "Force-off";
  off.dataset["armed"] = String(armed);
}

function feedback(text: string): void {
  byId("feedback").textContent = text;
}

async function control(cmd: string, done: string): Promise<void> {
  feedback("Commande envoyée…");
  try {
    const envelope = await invoke(cmd);
    const detail =
      typeof envelope.data?.["detail"] === "string" ? ` ${envelope.data["detail"]}` : "";
    feedback(envelope.ok === true ? `${done}${detail}` : `Refusé.${detail}`);
  } catch (error) {
    feedback(`Échec : ${message(error)}`);
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
    summary.textContent = "Journal indisponible : aucun graphe affiché.";
    return;
  }
  const W = 400;
  const H = 120;
  const PAD = 18;
  const chart = svg("svg", { viewBox: `0 0 ${String(W)} ${String(H)}`, role: "img" });
  chart.setAttribute(
    "aria-label",
    `${String(model.sessions.length)} réveils sur 24 h, ${model.totalKnownTokens.toLocaleString("fr-FR")} tokens mesurés`,
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
    if (h === 24) label.setAttribute("text-anchor", "end");
    label.textContent = h === 24 ? "maintenant" : `-${String(24 - h)} h`;
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
    title.textContent = `${new Date(start).toLocaleString("fr-FR")} — ${
      s.tokens === null ? "tokens inconnus" : `${s.tokens.toLocaleString("fr-FR")} tokens`
    }${s.outcome === null ? " (en cours)" : ` · ${s.outcome}`}${s.simulated ? " · SIMULÉ" : ""}`;
    dot.append(title);
    chart.append(dot);
  }
  box.replaceChildren(chart);
  summary.textContent =
    model.sessions.length === 0
      ? "Aucun réveil sur les dernières 24 h."
      : `${String(model.sessions.length)} réveil(s) · ${model.totalKnownTokens.toLocaleString("fr-FR")} tokens mesurés` +
        (model.unknownCount > 0
          ? ` · ${String(model.unknownCount)} session(s) à consommation inconnue (barres grisées)`
          : "") +
        (model.simulated ? " · contient des sessions SIMULÉES" : "");
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
    if (envelope.ok !== true) {
      status.textContent = `Fils indisponibles : ${errorText(envelope)}`;
      byId("threads").replaceChildren();
      byId("unread").hidden = true;
      return;
    }
    threads = (envelope.data?.["threads"] ?? []) as ThreadSummary[];
  } catch (error) {
    status.textContent = `Fils indisponibles : ${message(error)}`;
    return;
  }
  const seen = seenSequence();
  const unread = threads.filter((t) => t.last_sequence > seen).length;
  byId("unread").textContent = String(unread);
  byId("unread").hidden = unread === 0;
  status.textContent = threads.length === 0 ? "Aucun message de ton agent pour l'instant." : "";
  byId("threads").replaceChildren(
    ...threads.map((t) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["unread"] = String(t.last_sequence > seen);
      const subject = document.createElement("strong");
      subject.textContent = t.subject ?? "(sans sujet)";
      const preview = document.createElement("span");
      preview.textContent = t.preview;
      const when = document.createElement("small");
      when.textContent = new Date(t.last_at).toLocaleString("fr-FR");
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
  byId("thread-subject").textContent = subject ?? "(sans sujet)";
  try {
    const envelope = await invoke("owner_thread", { threadId });
    if (envelope.ok !== true) {
      byId("reply-status").textContent = `Fil indisponible : ${errorText(envelope)}`;
      return;
    }
    const messages = (envelope.data?.["messages"] ?? []) as Message[];
    lastMessageId = messages.findLast((m) => !m.from_self)?.message_id ?? null;
    byId("messages").replaceChildren(
      ...messages.map((m) => {
        const li = document.createElement("li");
        li.dataset["self"] = String(m.from_self);
        const meta = document.createElement("small");
        meta.textContent = `${m.from_self ? "Toi" : m.provenance.kind === "agent" ? "Ton agent" : m.provenance.kind} · ${new Date(m.provenance.received_at).toLocaleString("fr-FR")}`;
        const body = document.createElement("p");
        body.textContent = m.text;
        li.append(meta, body);
        return li;
      }),
    );
    markSeen(lastSequence);
    await refreshThreads();
  } catch (error) {
    byId("reply-status").textContent = `Fil indisponible : ${message(error)}`;
  }
}

async function sendReply(): Promise<void> {
  const text = byId<HTMLTextAreaElement>("reply-text").value.trim();
  if (openThread === null || text === "") return;
  // Une clé par brouillon : un renvoi après échec réseau ne crée pas de doublon.
  draftKey ??= `ui-${crypto.randomUUID()}`;
  const status = byId("reply-status");
  status.textContent = "Envoi…";
  try {
    const envelope = await invoke("owner_reply", {
      threadId: openThread,
      inReplyTo: lastMessageId,
      idempotencyKey: draftKey,
      text,
    });
    if (envelope.ok !== true) {
      status.textContent = `Non envoyé : ${errorText(envelope)}`;
      return;
    }
    status.textContent = "Envoyé dans le fil. Ton agent le lira à sa prochaine session autorisée.";
    byId<HTMLTextAreaElement>("reply-text").value = "";
    draftKey = null;
    const subject = byId("thread-subject").textContent;
    await showThread(openThread, subject, 0);
  } catch (error) {
    status.textContent = `Non envoyé : ${message(error)}`;
  }
}

// --- Navigation et événements -------------------------------------------------------------

function selectTab(threads: boolean): void {
  byId("tab-panel").setAttribute("aria-selected", String(!threads));
  byId("tab-threads").setAttribute("aria-selected", String(threads));
  byId("view-panel").hidden = threads;
  byId("view-threads").hidden = !threads;
  if (threads) void refreshThreads();
}

byId("tab-panel").addEventListener("click", () => {
  selectTab(false);
});
byId("tab-threads").addEventListener("click", () => {
  selectTab(true);
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
  () => void control("wake_resume", "Allumé : réveils autorisés."),
);
byId("mode-wake").addEventListener("click", () => void control("wake_now", "Réveil demandé."));
byId("pause").addEventListener("click", () => void control("wake_pause", "Pause appliquée."));
byId("mode-off").addEventListener("click", () => {
  // Deux clics rapprochés : l'arrêt d'urgence ne se lève que par une action explicite
  // ultérieure de l'humain, une confirmation évite qu'un clic égaré l'impose.
  if (Date.now() < stopArmedUntil) {
    stopArmedUntil = 0;
    void control("wake_stop", "Arrêt d'urgence appliqué.");
  } else {
    stopArmedUntil = Date.now() + 5000;
    render(panelView(lastRead, Date.now()));
  }
});

void refresh();
setInterval(() => void refresh(), POLL_MS);
