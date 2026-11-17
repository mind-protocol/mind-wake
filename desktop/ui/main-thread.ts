import { tr } from "./i18n.js";

/**
 * Fil principal On/Off dans la vue d'ensemble (NLR, 13 nov. 2026). Off : plus aucun
 * nouveau réveil de l'agent principal ; forks, second fil, pause et Force-off gardent
 * leurs propres commandes. L'état vient de `wake status` (`data.mainThread`) ; le bouton
 * passe par la commande Rust `wake_main_thread` (`mind-wake main-thread on|off`).
 * Off reste visible dans la vue d'ensemble et dans la conversation : un fil éteint ne
 * doit pas passer pour un agent silencieux.
 */
export interface MainThreadModel {
  readonly enabled: boolean;
  /** Session principale encore en cours (elle se termine normalement). */
  readonly sessionActive: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Lecture de `wake status` ; champ absent (moteur plus ancien) : null, rien n'est affiché. */
export function mainThreadModel(statusData: unknown): MainThreadModel | null {
  const data = record(statusData);
  const setting = record(data?.["mainThread"]);
  if (setting === null || typeof setting["enabled"] !== "boolean") return null;
  const state = record(data?.["profile"])?.["state"];
  return {
    enabled: setting["enabled"],
    sessionActive: state === "running" || state === "checkpointing",
  };
}

/** Ligne d'état de la vue d'ensemble. */
export function mainThreadStatus(model: MainThreadModel): string {
  if (model.enabled) return tr("Fil principal actif : les réveils suivent le mode choisi.");
  return model.sessionActive
    ? tr("Fil principal Off : la session en cours se termine, puis aucun nouveau réveil. Historique conservé.")
    : tr("Fil principal Off : aucun nouveau réveil de ton agent. Historique conservé.");
}

/** Bandeau de la conversation ; null quand le fil principal est actif. */
export function mainThreadChatNotice(model: MainThreadModel | null): string | null {
  if (model === null || model.enabled) return null;
  return model.sessionActive
    ? tr("Fil principal désactivé : ton agent termine sa session en cours puis ne se réveille plus. Tes messages sont conservés et seront lus quand tu le réactiveras (vue d’ensemble).")
    : tr("Fil principal désactivé : ton agent ne se réveille plus et ne répondra pas. Tes messages sont conservés et seront lus quand tu le réactiveras (vue d’ensemble).");
}

export interface MainThreadMount {
  readonly invoke: (
    command: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok?: unknown; data?: unknown; error?: { message?: unknown } }>;
  /** Relit `wake status` après un changement. */
  readonly refresh: () => Promise<void>;
}

export function mountMainThread(options: MainThreadMount): { update: (statusData: unknown) => void } {
  const anchor = document.querySelector('section[aria-label="Second fil Claude Code"]');
  const section = document.createElement("section");
  section.className = "switch-section";
  section.setAttribute("aria-label", tr("Fil principal"));
  const group = document.createElement("div");
  group.className = "switch";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", tr("Fil principal"));
  const off = document.createElement("button");
  off.id = "main-thread-off";
  off.type = "button";
  off.textContent = "Off";
  off.setAttribute("aria-pressed", "false");
  const on = document.createElement("button");
  on.id = "main-thread-on";
  on.type = "button";
  on.textContent = tr("Fil principal");
  on.title = tr("Réveils de ton agent principal (conversation « Marco »)");
  on.setAttribute("aria-pressed", "false");
  group.append(off, on);
  section.append(group);
  const feedback = document.createElement("p");
  feedback.id = "main-thread-feedback";
  feedback.className = "hint";
  feedback.setAttribute("role", "status");
  if (anchor?.parentElement) anchor.parentElement.insertBefore(section, anchor);
  else document.getElementById("view-panel")?.prepend(section);
  section.after(feedback);

  const notice = document.createElement("p");
  notice.id = "main-thread-chat-status";
  notice.className = "hint main-thread-off-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const chat = document.getElementById("chat");
  chat?.after(notice);

  let model: MainThreadModel | null = null,
    busy = false,
    message: string | null = null;
  const render = () => {
    section.hidden = model === null;
    feedback.hidden = model === null;
    on.disabled = off.disabled = busy || model === null;
    if (model === null) {
      notice.hidden = true;
      return;
    }
    on.setAttribute("aria-pressed", String(model.enabled));
    off.setAttribute("aria-pressed", String(!model.enabled));
    feedback.textContent = message ?? mainThreadStatus(model);
    const text = mainThreadChatNotice(model);
    notice.hidden = text === null;
    if (notice.textContent !== (text ?? "")) notice.textContent = text ?? "";
  };
  const toggle = async (enabled: boolean) => {
    if (busy || model?.enabled === enabled) return;
    busy = true;
    message = enabled ? tr("Activation du fil principal…") : tr("Arrêt du fil principal…");
    render();
    try {
      const envelope = await options.invoke("wake_main_thread", { action: enabled ? "on" : "off" });
      if (envelope.ok !== true)
        throw new Error(
          typeof envelope.error?.message === "string" ? envelope.error.message : tr("refusé"),
        );
      const data = record(envelope.data);
      if (model !== null && typeof data?.["enabled"] === "boolean") model = { ...model, enabled: data["enabled"] };
      message = null;
    } catch (error) {
      message = tr("Fil principal : {0}", [error instanceof Error ? error.message : String(error)]);
    } finally {
      busy = false;
      render();
    }
    await options.refresh();
  };
  on.addEventListener("click", () => void toggle(true));
  off.addEventListener("click", () => void toggle(false));
  render();
  return {
    update: (statusData) => {
      const next = mainThreadModel(statusData);
      // Une lecture en échec ne fait pas disparaître un Off connu.
      if (next !== null || model === null) model = next;
      render();
    },
  };
}
