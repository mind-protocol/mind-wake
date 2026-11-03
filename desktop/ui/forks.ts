import { projectWakesCard } from "./project-wakes.js";
import { renderMarkdown } from "./markdown.js";

interface ForkEntry {
  id: number;
  at: string;
  role: "agent" | "human" | "event";
  text: string;
  delivered: boolean;
  activity?: boolean;
  source?: string;
}
export interface ForkView {
  projectWakes?: unknown;
  planning?: boolean;
  id: number;
  enabled: boolean;
  projects: string[];
  threadId: string | null;
  lastTurn: { projectId: string | null; endedAt: string | null; outcome: string | null } | null;
  entries: ForkEntry[];
  activity?: { id:string; at:string; text:string; kind?:"final"; source?:string; threadId?:string }[];
}
export interface ForksView {
  running: boolean;
  retryAtMs?: number;
  profile: string;
  forks: ForkView[];
}
/** Keep public activity separate from persisted replies and their unread cursors. */
export function forkConversationEntries(fork: ForkView): ForkEntry[] {
  return [...fork.entries, ...(fork.activity ?? [])
    .filter((item) => item.kind !== "final" || item.threadId !== undefined)
    .map((item): ForkEntry => ({id:0, at:item.at, text:item.text, role:"event", delivered:true,
      activity:true, ...(item.source === undefined ? {} : {source:item.source})}))]
    .sort((a,b) => Date.parse(a.at)-Date.parse(b.at));
}

export function forkIsWorking(fork: ForkView, model: ForksView, now = Date.now()): boolean {
  return (
    fork.enabled &&
    model.running &&
    model.profile === "run" &&
    (model.retryAtMs ?? 0) <= now &&
    fork.lastTurn?.endedAt === null &&
    (fork.planning === true || (
    fork.lastTurn.projectId !== null &&
    fork.projects.includes(fork.lastTurn.projectId)))
  );
}

/** Independent read cursors; human messages and lifecycle events never trigger a badge. */
export class ForkReadState {
  readonly cursors = new Map<number, number>();
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">) {}
  private cursor(id: number): number {
    let value = this.cursors.get(id);
    if (value === undefined) {
      try {
        value = Number(this.storage.getItem(`mind-wake-fork-${String(id)}-read`));
      } catch {
        value = 0;
      }
      if (!Number.isSafeInteger(value) || value < 0) value = 0;
      this.cursors.set(id, value);
    }
    return value;
  }
  unread(fork: ForkView): number {
    const cursor = this.cursor(fork.id);
    return fork.entries.filter((entry) => entry.role === "agent" && entry.id > cursor).length;
  }
  markRead(fork: ForkView): void {
    const cursor = Math.max(
      this.cursor(fork.id),
      ...fork.entries.filter((entry) => entry.role === "agent").map((entry) => entry.id),
    );
    this.cursors.set(fork.id, cursor);
    try {
      this.storage.setItem(`mind-wake-fork-${String(fork.id)}-read`, String(cursor));
    } catch {
      /* Keep the cursor in memory when storage is unavailable. */
    }
  }
}

export function forkStatus(fork: ForkView, model: ForksView): string {
  if (!fork.enabled) return "Off · historique conservé";
  if (model.profile === "hold") return "En pause avec Wake";
  if (model.profile === "stop") return "En attente du profil Codex natif actif";
  if ((model.retryAtMs ?? 0) > Date.now()) return "En attente du fournisseur";
  if (!model.running) return "Démarrage du moteur…";
  if (fork.planning && forkIsWorking(fork, model)) return "Travaille · choix de ses prochains wakes";
  if (fork.projects.length === 0) return "En attente d’un projet disponible";
  if (forkIsWorking(fork, model)) return `Travaille · ${fork.lastTurn?.projectId ?? "projet"}`;
  return fork.lastTurn?.outcome === "rate_limited" ? "En attente du fournisseur" : "On";
}
export function mountForks(options: {
  invoke: (
    command: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok?: unknown; data?: unknown; error?: { message?: unknown } }>;
  selectTab: () => void;
  decorate: (body: HTMLElement, text: string) => void;
}): void {
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (found === null) throw Error(`Élément #${id} absent`);
    return found;
  };
  const controls = element("fork-controls");
  const panel = element("view-forks");
  const heading = document.createElement("h2");
  const icon = (id: number): HTMLElement => {
    const avatar = document.createElement("span");
    avatar.className = "fork-icon";
    avatar.dataset["forkIcon"] = String(id);
    avatar.setAttribute("role", "img");
    avatar.setAttribute("aria-label", `Agent Codex · fork ${String(id)}`);
    avatar.textContent = `⑂${String(id)}`;
    return avatar;
  };
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const messages = document.createElement("ol");
  messages.id = "fork-thread-messages";
  messages.className = "messages";
  const presence = document.createElement("p");
  presence.className = "fork-presence";
  presence.setAttribute("role", "status");
  presence.hidden = true;
  const form = document.createElement("form");
  const text = document.createElement("textarea");
  text.rows = 3;
  text.maxLength = 4000;
  text.required = true;
  text.setAttribute("aria-label", "Message au fork sélectionné");
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Envoyer";
  const feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  form.append(text, send, feedback);
  panel.append(heading, status, messages, presence, form);
  // Access to localStorage itself may be disabled by the webview.
  const readState = new ForkReadState({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => {
      localStorage.setItem(key, value);
    },
  });
  let current = 2,
    model: ForksView | null = null,
    busy = false,
    lastEnsure = 0,
    signature = "",
    fresh = false;
  const rows = new Map<
    number,
    {
      toggle: HTMLButtonElement;
      detail: HTMLElement;
      tab: HTMLButtonElement;
      unread: HTMLElement[];
      working: HTMLElement[];
    }
  >();
  const drafts = new Map<number, string>();
  for (let id = 2; id <= 8; id++) {
    const row = document.createElement("div");
    row.className = "fork-control";
    const label = document.createElement("strong");
    label.append(icon(id), ` Fork ${String(id)} · Codex`);
    const badge = (): HTMLElement => {
      const node = document.createElement("span");
      node.className = "fork-unread";
      node.hidden = true;
      return node;
    };
    const working = (): HTMLElement => {
      const node = document.createElement("span");
      node.className = "fork-working";
      node.textContent = "Travaille";
      node.hidden = true;
      return node;
    };
    const overviewUnread = badge(),
      overviewWorking = working();
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", `Activer le fork Codex ${String(id)}`);
    toggle.setAttribute("aria-checked", "false");
    toggle.textContent = "Off";
    const detail = document.createElement("small");
    detail.textContent = "Lecture…";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Ouvrir le fil";
    row.append(label, toggle, open, overviewWorking, overviewUnread, detail);
    controls.append(row);
    const tab = document.createElement("button");
    tab.type = "button";
    tab.id = `tab-fork-${String(id)}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "view-forks");
    tab.setAttribute("aria-selected", "false");
    tab.dataset["forkTab"] = String(id);
    const tabUnread = badge(),
      tabWorking = working();
    tab.append(icon(id), ` Fork ${String(id)}`, tabWorking, tabUnread);
    tab.hidden = true;
    element("tab-second").before(tab);
    const select = () => {
      drafts.set(current, text.value);
      current = id;
      text.value = drafts.get(id) ?? "";
      feedback.textContent = "";
      signature = "";
      options.selectTab();
      document.querySelectorAll("[data-fork-tab]").forEach((button) => {
        button.setAttribute("aria-selected", "false");
      });
      panel.hidden = false;
      panel.setAttribute("aria-labelledby", tab.id);
      tab.setAttribute("aria-selected", "true");
      render();
      messages.scrollTop = messages.scrollHeight;
      updateIndicators();
    };
    tab.addEventListener("click", select);
    open.addEventListener("click", select);
    toggle.addEventListener("click", () => {
      const fork = model?.forks.find((f) => f.id === id);
      if (!fork) return;
      toggle.disabled = true;
      void request(fork.enabled ? "off" : "on", { id })
        .then(apply)
        .catch(showError)
        .finally(() => {
          toggle.disabled = false;
        });
    });
    rows.set(id, {
      toggle,
      detail,
      tab,
      unread: [overviewUnread, tabUnread],
      working: [overviewWorking, tabWorking],
    });
  }
  function showError(error: unknown) {
    fresh = false;
    updateIndicators();
    feedback.textContent = error instanceof Error ? error.message : String(error);
    element("fork-feedback").textContent = feedback.textContent;
  }
  async function request(action: string, args: Record<string, unknown> = {}) {
    const response = await options.invoke("wake_forks", { action, ...args });
    if (response.ok !== true)
      throw Error(
        typeof response.error?.message === "string"
          ? response.error.message
          : "Commande de fork refusée",
      );
    return response.data as ForksView;
  }
  function apply(next: ForksView) {
    model = next;
    fresh = true;
    render();
  }
  function updateIndicators() {
    if (model === null) return;
    const active = model.forks.find((fork) => fork.id === current);
    if (
      active &&
      !panel.hidden &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100
    )
      readState.markRead(active);
    for (const fork of model.forks) {
      const row = rows.get(fork.id);
      if (!row) continue;
      const count = readState.unread(fork);
      for (const badge of row.unread) {
        badge.hidden = count === 0;
        badge.textContent = count > 1 ? `Nouveau message · ${String(count)}` : "Nouveau message";
      }
      const working = fresh && forkIsWorking(fork, model);
      for (const indicator of row.working) indicator.hidden = !working;
      row.tab.dataset["working"] = String(working);
      row.tab.setAttribute(
        "aria-label",
        `Fork ${String(fork.id)}${working ? " · Travaille" : ""}${count ? ` · ${String(count)} message(s) non lu(s)` : ""}`,
      );
    }
    const working = active !== undefined && fresh && forkIsWorking(active, model);
    presence.hidden = !working;
    if (working)
      presence.replaceChildren(
        icon(current),
        document.createTextNode(` Fork ${String(current)} travaille`),
      );
  }
  function render() {
    if (!model) return;
    for (const fork of model.forks) {
      const row = rows.get(fork.id);
      if (!row) continue;
      row.toggle.textContent = fork.enabled ? "On" : "Off";
      row.toggle.setAttribute("aria-checked", String(fork.enabled));
      row.detail.textContent = `${forkStatus(fork, model)}${fork.projects.length ? ` · ${fork.projects.join(", ")}` : ""}`;
      row.tab.hidden =
        !fork.enabled &&
        !fork.entries.length &&
        fork.threadId === null &&
        (fork.id !== current || panel.hidden);
    }
    const fork = model.forks.find((f) => f.id === current);
    if (!fork) return;
    heading.replaceChildren(
      icon(current),
      document.createTextNode(` Fork ${String(current)} · Codex`),
    );
    status.textContent = forkStatus(fork, model);
    const conversation = forkConversationEntries(fork);
    const next = JSON.stringify([current, conversation, fork.projectWakes]);
    if (next === signature) {
      updateIndicators();
      return;
    }
    signature = next;
    const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    messages.replaceChildren(
      ...conversation.map((entry) => {
        const li = document.createElement("li");
        li.dataset["self"] = String(entry.role === "human");
        if (entry.activity) li.dataset["from"] = "activity";
        const meta = document.createElement("small");
        if (entry.role === "agent") meta.append(icon(current), " ");
        meta.append(
          `${entry.role === "human" ? "Toi" : entry.role === "agent" ? `Codex · fork ${String(current)}` : entry.activity ? `Activité${entry.source ? ` · ${entry.source}` : ""}` : "État"} · ${new Date(entry.at).toLocaleString("fr-FR")}${entry.delivered ? "" : " · en attente"}`,
        );
        const body =
          entry.role === "agent" ? renderMarkdown(entry.text) : document.createElement("p");
        if (entry.role === "agent") options.decorate(body, entry.text);
        else body.textContent = entry.text;
        li.append(meta, body);
        return li;
      }),
    );
    const objectives = projectWakesCard(fork.projectWakes, `fork-${String(current)}`);
    if (objectives) messages.append(objectives);
    if (follow) messages.scrollTop = messages.scrollHeight;
    updateIndicators();
  }
  messages.addEventListener("scroll", updateIndicators);
  document.addEventListener("visibilitychange", updateIndicators);
  window.addEventListener("focus", updateIndicators);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = text.value.trim();
    if (!value || send.disabled) return;
    const id = current;
    send.disabled = true;
    void request("send", { id, text: value })
      .then((next) => {
        drafts.set(id, "");
        if (current === id && text.value.trim() === value) text.value = "";
        feedback.textContent = `Message enregistré pour le fork ${String(id)}, à lire au prochain tour.`;
        apply(next);
      })
      .catch(showError)
      .finally(() => {
        send.disabled = false;
      });
  });
  async function refresh() {
    if (busy) return;
    busy = true;
    const ensure = Date.now() - lastEnsure > 60_000;
    if (ensure) lastEnsure = Date.now();
    try {
      apply(await request(ensure ? "ensure" : "status"));
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }
  void refresh();
  setInterval(() => void refresh(), 5000);
}
