import { tr, formatLocale } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";

export interface CoachEntry {
  id: number;
  at: string;
  role: "human" | "agent" | "event";
  text: string;
  delivered: boolean;
}
export interface CoachView {
  enabled: boolean;
  active: boolean;
  entries: CoachEntry[];
  retryAt: number;
}
export function coachView(value: unknown): CoachView | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (!Array.isArray(d["entries"])) return null;
  const entries = d["entries"].flatMap((raw: unknown): CoachEntry[] => {
    if (!raw || typeof raw !== "object") return [];
    const e = raw as Record<string, unknown>;
    if (
      typeof e["id"] !== "number" ||
      typeof e["text"] !== "string" ||
      typeof e["at"] !== "string" ||
      !["human", "agent", "event"].includes(String(e["role"]))
    )
      return [];
    return [
      {
        id: e["id"],
        at: e["at"],
        role: e["role"] as CoachEntry["role"],
        text: e["text"],
        delivered: e["delivered"] === true,
      },
    ];
  });
  return {
    enabled: d["enabled"] === true,
    active: d["active"] === true,
    retryAt: typeof d["retryAt"] === "number" ? d["retryAt"] : 0,
    entries,
  };
}
export function mountCoach(options: {
  invoke: (
    command: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok?: unknown; data?: unknown; error?: { message?: unknown } }>;
  selectTab: () => void;
  decorate: (body: HTMLElement, text: string) => void;
}): void {
  const panel = document.getElementById("view-coach"),
    tab = document.getElementById("tab-coach");
  if (!panel || !tab) return;
  const heading = document.createElement("h2");
  heading.textContent = tr("Coach");
  const status = document.createElement("p");
  status.id = "coach-status";
  status.setAttribute("role", "status");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", tr("Activer le coach"));
  const messages = document.createElement("ol");
  messages.className = "messages";
  messages.id = "coach-messages";
  messages.setAttribute("aria-live", "polite");
  const form = document.createElement("form"),
    text = document.createElement("textarea"),
    send = document.createElement("button"),
    feedback = document.createElement("p");
  form.id = "coach-form";
  feedback.id = "coach-feedback";
  text.id = "coach-text";
  text.rows = 3;
  text.maxLength = 4000;
  text.required = true;
  text.placeholder = tr("Écris au coach…");
  text.setAttribute("aria-label", tr("Message au coach"));
  send.type = "submit";
  send.textContent = tr("Envoyer");
  feedback.setAttribute("role", "status");
  form.append(text, send, feedback);
  const header = document.createElement("header");
  header.className = "coach-heading";
  header.append(heading, toggle);
  panel.append(header, status, messages, form);
  let model: CoachView | null = null,
    signature = "",
    loading = false,
    sending = false;
  const refresh = async () => {
    if (loading) return;
    loading = true;
    try {
      const result = await options.invoke("wake_coach", { action: "status" });
      if (result.ok !== true)
        throw Error(
          typeof result.error?.message === "string"
            ? result.error.message
            : tr("Coach indisponible"),
        );
      model = coachView(result.data);
      if (!model) return;
      toggle.textContent = model.enabled ? "On" : "Off";
      toggle.setAttribute("aria-checked", String(model.enabled));
      status.textContent = !model.enabled
        ? tr("Coach désactivé · historique conservé")
        : model.retryAt > Date.now()
          ? tr("En attente du fournisseur")
          : model.active
            ? tr("Le coach travaille…")
            : tr("Le coach suit les wakes et lit tes messages.");
      const next = JSON.stringify(model.entries);
      if (next === signature) return;
      signature = next;
      const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
      messages.replaceChildren(
        ...model.entries.map((e) => {
          const li = document.createElement("li"),
            meta = document.createElement("small");
          li.dataset["self"] = String(e.role === "human");
          li.dataset["from"] = e.role === "human" ? "owner" : "agent";
          meta.textContent = `${e.role === "human" ? tr("Toi") : tr("Coach")} · ${new Date(e.at).toLocaleString(formatLocale())}${e.role === "human" && !e.delivered ? tr(" · en attente") : ""}`;
          const body = e.role === "agent" ? renderMarkdown(e.text) : document.createElement("p");
          if (e.role === "agent") options.decorate(body, e.text);
          else body.textContent = e.text;
          li.append(meta, body);
          return li;
        }),
      );
      if (follow) messages.scrollTop = messages.scrollHeight;
    } catch (error) {
      status.textContent = String(error);
    } finally {
      loading = false;
    }
  };
  tab.addEventListener("click", () => {
    options.selectTab();
    void refresh();
  });
  toggle.addEventListener("click", () => {
    toggle.disabled = true;
    void options
      .invoke("wake_coach", { action: model?.enabled ? "off" : "on" })
      .then((result) => {
        if (result.ok !== true) throw Error(tr("Coach indisponible"));
        return refresh();
      })
      .catch((error: unknown) => {
        feedback.textContent = String(error);
      })
      .finally(() => {
        toggle.disabled = false;
      });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = text.value.trim();
    if (!value || sending) return;
    sending = true;
    send.disabled = true;
    feedback.textContent = tr("Envoi…");
    void options
      .invoke("wake_coach", { action: "send", text: value })
      .then((result) => {
        if (result.ok !== true)
          throw Error(
            typeof result.error?.message === "string" ? result.error.message : tr("Non envoyé"),
          );
        if (text.value.trim() === value) text.value = "";
        feedback.textContent = tr("Message transmis au coach.");
        return refresh();
      })
      .catch((error: unknown) => {
        feedback.textContent = String(error);
      })
      .finally(() => {
        sending = false;
        send.disabled = false;
      });
  });
  void refresh();
  setInterval(() => void refresh(), 5000);
}
