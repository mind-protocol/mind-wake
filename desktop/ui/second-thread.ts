import { projectWakesCard } from "./project-wakes.js";
/**
 * Second fil Claude Code : sélecteur de la vue d'ensemble (défaut Off) et onglet dédié.
 * Sa transcription vient de `mind-wake second-thread status --json`, séparée de la
 * conversation principale ; le texte est rendu par le moteur Markdown sûr du panneau.
 */
import { renderMarkdown } from "./markdown.js";

export interface SecondThreadEntryView {
  readonly id: number;
  readonly at: string;
  readonly role: "agent" | "human" | "event";
  readonly text: string;
  readonly projectId: string | null;
  readonly delivered: boolean;
}
export interface SecondThreadModel {
  readonly projectWakes?: unknown;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly turnActive: boolean;
  readonly profile: "run" | "hold" | "stop";
  readonly projectId: string | null;
  readonly inBlock: number;
  readonly lastOutcome: string | null;
  readonly entries: readonly SecondThreadEntryView[];
}

type Json = Record<string, unknown>;
const object = (v: unknown): Json | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;

export function secondThreadModel(data: unknown): SecondThreadModel | null {
  const d = object(data);
  if (d === null) return null;
  const position = object(d["position"]),
    last = object(d["lastTurn"]);
  const entries = Array.isArray(d["entries"])
    ? d["entries"].flatMap((raw): SecondThreadEntryView[] => {
        const e = object(raw);
        if (
          e === null ||
          typeof e["text"] !== "string" ||
          typeof e["at"] !== "string" ||
          !["agent", "human", "event"].includes(String(e["role"]))
        )
          return [];
        return [
          {
            id: Number(e["id"]),
            at: e["at"],
            role: e["role"] as SecondThreadEntryView["role"],
            text: e["text"],
            projectId: typeof e["projectId"] === "string" ? e["projectId"] : null,
            delivered: e["delivered"] !== false,
          },
        ];
      })
    : [];
  const profile = d["profile"] === "hold" || d["profile"] === "stop" ? d["profile"] : "run";
  return {
    projectWakes: d["projectWakes"],
    enabled: d["enabled"] === true,
    running: d["running"] === true,
    turnActive: last !== null && last["endedAt"] === null,
    profile,
    projectId: typeof position?.["projectId"] === "string" ? position["projectId"] : null,
    inBlock: typeof position?.["inBlock"] === "number" ? position["inBlock"] : 0,
    lastOutcome:
      typeof last?.["outcome"] === "string" ? last["outcome"] : last === null ? null : "en cours",
    entries,
  };
}

export function secondThreadIsWorking(model: SecondThreadModel): boolean {
  return model.enabled && model.running && model.profile === "run" && model.turnActive;
}

export function secondThreadStatus(model: SecondThreadModel): string {
  if (!model.enabled) return "Second fil désactivé. Son historique est conservé.";
  if (model.profile === "stop")
    return "Second fil en attente : Wake est arrêté ou le mode hôte n’est pas consenti.";
  if (model.profile === "hold") return "Second fil en pause avec Wake.";
  if (!model.running) return "Second fil activé ; démarrage du worker Claude Code…";
  const project =
    model.projectId === null
      ? "exploration libre"
      : `${model.projectId} (${String(model.inBlock)}/10)`;
  if (secondThreadIsWorking(model)) return `Claude Code travaille sur ${project}.`;
  if (model.lastOutcome === "rate_limited") return "Claude Code attend le fournisseur avant de reprendre.";
  return `Claude Code attend le prochain tour sur ${project}.`;
}

export interface SecondThreadMount {
  readonly invoke: (
    cmd: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok?: unknown; data?: unknown; error?: { message?: unknown } }>;
  readonly selectTab: () => void;
  readonly decorate?: (body: HTMLElement, text: string) => void;
}

const ENSURE_EVERY_MS = 60_000;

export function mountSecondThread(options: SecondThreadMount): { refresh: () => Promise<void> } {
  const el = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`élément #${id} absent`);
    return found;
  };
  const on = el("second-thread-on"),
    off = el("second-thread-off");
  const tab = el("tab-second"),
    list = el("second-thread-messages");
  const status = el("second-thread-status"),
    panelStatus = el("second-thread-feedback");
  const form = el("second-thread-form"),
    text = el("second-thread-text") as HTMLTextAreaElement;
  const sendStatus = el("second-thread-send-status");
  const presence = el("second-thread-presence"), tabPresence = el("second-thread-tab-presence");
  let model: SecondThreadModel | null = null,
    lastEnsure = 0,
    signature = "";

  const render = () => {
    if (model === null) return;
    on.setAttribute("aria-pressed", String(model.enabled));
    off.setAttribute("aria-pressed", String(!model.enabled));
    tab.hidden = !model.enabled && model.entries.length === 0;
    const working = secondThreadIsWorking(model);
    presence.hidden = !working;
    tabPresence.hidden = !working;
    const line = secondThreadStatus(model);
    status.textContent = line;
    panelStatus.textContent = line;
    const next = JSON.stringify([model.entries.map((e) => [e.id, e.delivered]),model.projectWakes]);
    if (next === signature) return;
    signature = next;
    const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
    list.replaceChildren(
      ...model.entries.map((e) => {
        const li = document.createElement("li"),
          meta = document.createElement("small");
        li.dataset["self"] = String(e.role === "human");
        li.dataset["from"] =
          e.role === "event" ? "session" : e.role === "human" ? "owner" : "agent";
        const who =
          e.role === "human"
            ? `Toi${e.delivered ? "" : " · en attente du prochain tour"}`
            : e.role === "event"
              ? "État du second fil"
              : `Claude Code${e.projectId === null ? "" : ` · ${e.projectId}`}`;
        meta.textContent = `${who} · ${new Date(e.at).toLocaleString("fr-FR")}`;
        let body: HTMLElement;
        if (e.role === "agent") {
          body = renderMarkdown(e.text);
          options.decorate?.(body, e.text);
        } else {
          body = document.createElement("p");
          body.textContent = e.text;
        }
        li.append(meta, body);
        return li;
      }),
    );
    const objectives = projectWakesCard(model.projectWakes, "claude");
    if (objectives) list.append(objectives);
    if (follow) list.scrollTop = list.scrollHeight;
  };

  const refresh = async () => {
    try {
      const ensure = Date.now() - lastEnsure > ENSURE_EVERY_MS;
      if (ensure) lastEnsure = Date.now();
      const envelope = await options.invoke("second_thread", {
        action: ensure ? "ensure" : "status",
      });
      if (envelope.ok !== true)
        throw new Error(
          typeof envelope.error?.message === "string" ? envelope.error.message : "refusé",
        );
      model = secondThreadModel(envelope.data);
      render();
    } catch (error) {
      presence.hidden = true;
      tabPresence.hidden = true;
      status.textContent = `Second fil indisponible : ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const toggle = async (action: "on" | "off") => {
    panelStatus.textContent =
      action === "on" ? "Activation du second fil…" : "Arrêt du second fil…";
    try {
      lastEnsure = Date.now();
      const envelope = await options.invoke("second_thread", { action });
      model = secondThreadModel(envelope.data) ?? model;
      render();
      const detail = object(envelope.data)?.["detail"];
      if (typeof detail === "string") panelStatus.textContent = detail;
    } catch (error) {
      panelStatus.textContent = `Second fil : ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  on.addEventListener("click", () => void toggle("on"));
  off.addEventListener("click", () => void toggle("off"));
  tab.addEventListener("click", () => {
    options.selectTab();
    list.scrollTop = list.scrollHeight;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = text.value.trim();
    if (value === "") return;
    sendStatus.textContent = "Envoi…";
    void options
      .invoke("second_thread", { action: "send", text: value })
      .then((envelope) => {
        if (envelope.ok !== true)
          throw new Error(
            typeof envelope.error?.message === "string" ? envelope.error.message : "refusé",
          );
        text.value = "";
        sendStatus.textContent = "Ajouté au second fil ; Claude Code le lira au prochain tour.";
        return refresh();
      })
      .catch((error: unknown) => {
        sendStatus.textContent = `Non envoyé : ${error instanceof Error ? error.message : String(error)}`;
      });
  });
  void refresh();
  setInterval(() => void refresh(), 5000);
  return { refresh };
}
