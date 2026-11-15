import {
  visibleMessages,
  selectedMessage,
  type GraphSelection,
  type VoiceGraph,
} from "./voice-graph-model.js";

type Invoke = (command: string) => Promise<unknown>;
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}
const stamp = (at: string | null) =>
  at ? new Date(at).toLocaleString("fr-FR") : "date inconnue";
export function mountVoiceGraph(root: HTMLElement, invoke: Invoke) {
  const selection: GraphSelection = { tab: "all", selected: null, query: "" };
  let graph: VoiceGraph | undefined,
    busy = false,
    disposed = false,
    inspectKey = "",
    page = 0;
  const toolbar = element("div"),
    reload = element("button", "Actualiser le graphe"),
    status = element("p", "Graphe non lu");
  reload.type = "button";
  status.setAttribute("role", "status");
  const search = element("input");
  search.type = "search";
  search.placeholder = "Message, identité, statut…";
  search.setAttribute("aria-label", "Filtrer les messages");
  const tabs = element("div");
  tabs.className = "vg-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Fil du graphe");
  const overview = element("div");
  overview.className = "vg-overview";
  overview.setAttribute("aria-label", "Vue globale des sessions et services");
  const panel = element("div");
  panel.id = "voice-graph-panel";
  panel.setAttribute("role", "tabpanel");
  const diagram = element("div");
  diagram.className = "vg-diagram";
  diagram.setAttribute(
    "aria-label",
    "Graphe dirig? ; chaque ar?te est accessible dans la liste de messages",
  );
  const count = element("p"),
    list = element("div"),
    inspector = element("article"),
    limits = element("details"),
    summary = element("summary", "Sources, preuves et limites");
  list.className = "vg-messages";
  list.tabIndex = 0;
  list.setAttribute("aria-label", "Messages : source → destination");
  inspector.className = "vg-inspector";
  inspector.tabIndex = 0;
  inspector.setAttribute("aria-label", "Message sélectionné");
  limits.append(summary);
  const previous = element("button", "Page précédente"),
    next = element("button", "Page suivante");
  previous.type = "button";
  next.type = "button";
  previous.onclick = () => {
    page = Math.max(0, page - 1);
    render();
  };
  next.onclick = () => {
    page++;
    render();
  };
  toolbar.append(reload, search, previous, next);
  panel.append(count, diagram, list, inspector);
  root.append(toolbar, status, tabs, overview, panel, limits);
  function inspect() {
    if (!graph) return;
    const scroll = inspector.scrollTop,
      m = selectedMessage(graph, selection);
    const key = JSON.stringify([
      selection.selected,
      m,
      visibleMessages(graph, selection).some((x) => x.id === m?.id),
    ]);
    if (key === inspectKey) return;
    inspectKey = key;
    inspector.replaceChildren();
    if (!m) {
      inspector.append(
        element(
          "p",
          selection.selected
            ? "Message sélectionné absent de cette fenêtre de sources ; sélection conservée."
            : "Choisir une arête ou un message.",
        ),
      );
      return;
    }
    const title = element("h3", `${m.from} → ${m.to}`),
      meta = element("p", `${m.kind} · ${m.state} · ${stamp(m.at)}`),
      body = element("pre", m.text);
    const details = element("dl");
    for (const [label, value] of Object.entries({
      ID: m.id,
      Correlation: m.correlationId ?? "inconnue",
      Fil: m.threadId ?? "inconnu",
      Provenance: m.source,
      Retries: m.retry === null ? "inconnus" : JSON.stringify(m.retry),
      Limite: m.detail || "Aucune preuve supplémentaire",
      Visibilité: visibleMessages(graph, selection).some((x) => x.id === m.id)
        ? "dans le filtre"
        : "hors filtre · sélection conservée",
    }))
      details.append(element("dt", label), element("dd", value));
    const history = element("ol");
    m.history.forEach((h) => {
      history.append(element("li", `${h.state} · ${stamp(h.at)}`));
    });
    inspector.append(title, meta, body, details, history);
    inspector.scrollTop = scroll;
  }
  function render() {
    if (!graph) return;
    const activeTab = document.activeElement?.id;
    const data = graph,
      scroll = list.scrollTop,
      focus = (document.activeElement as HTMLElement | null)?.dataset[
        "messageId"
      ];
    tabs.replaceChildren();
    for (const tab of [{ id: "all", label: "Global" }, ...data.tabs]) {
      const button = element("button", tab.label);
      button.type = "button";
      button.id = `vg-tab-${tab.id}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", panel.id);
      button.setAttribute("aria-selected", String(selection.tab === tab.id));
      button.tabIndex = selection.tab === tab.id ? 0 : -1;
      button.onclick = () => {
        selection.tab = tab.id;
        page = 0;
        render();
        document.getElementById(button.id)?.focus();
      };
      button.onkeydown = (e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const choices = Array.from(tabs.querySelectorAll("button"));
        const index = choices.indexOf(button);
        const target =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? choices.length - 1
              : (index + (e.key === "ArrowRight" ? 1 : -1) + choices.length) %
                choices.length;
        choices[target]?.click();
      };
      tabs.append(button);
    }
    panel.setAttribute("aria-labelledby", `vg-tab-${selection.tab}`);
    overview.replaceChildren();
    // The global graph stays present while tabs filter edges. Every edge has textual endpoints.
    for (const n of data.nodes) {
      const card = element("div");
      card.className = "vg-node";
      card.dataset["activity"] = n.activity;
      card.append(
        element("strong", n.label),
        element("small", `${n.kind} · ${n.activity} · ${stamp(n.at)}`),
        element("code", n.id),
        element("small", n.detail),
      );
      if (n.threadId) card.append(element("small", `Fil ${n.threadId}`));
      overview.append(card);
    }
    const filtered = visibleMessages(data, selection);
    page = Math.min(page, Math.max(0, Math.ceil(filtered.length / 150) - 1));
    const rows = filtered.slice(page * 150, (page + 1) * 150);
    previous.disabled = page === 0;
    next.disabled = (page + 1) * 150 >= filtered.length;
    count.textContent = `${String(filtered.length)} / ${String(data.messages.length)} arêtes observées · page ${String(page + 1)} (150 par page) · vue globale conservée ci-dessus`;
    diagram.replaceChildren();
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    const ids = [...new Set(rows.flatMap((m) => [m.from, m.to]))],
      positions = new Map(
        ids.map((id, i) => [
          id,
          { x: i % 2 === 0 ? 20 : 540, y: 40 + Math.floor(i / 2) * 85 },
        ]),
      );
    svg.setAttribute(
      "viewBox",
      `0 0 800 ${String(Math.max(220, Math.ceil(ids.length / 2) * 85 + 40))}`,
    );
    svg.setAttribute("aria-hidden", "true");
    for (const m of rows) {
      const a = positions.get(m.from),
        b = positions.get(m.to);
      if (!a || !b) continue;
      const edge = document.createElementNS(ns, "path"),
        x = a.x + 115,
        y = a.y + 15,
        tx = b.x + 115,
        ty = b.y + 15;
      edge.setAttribute(
        "d",
        m.from === m.to
          ? `M ${String(x)} ${String(y)} C ${String(x + 130)} ${String(y - 55)}, ${String(x + 130)} ${String(y + 55)}, ${String(x)} ${String(y + 10)}`
          : `M ${String(x)} ${String(y)} Q 400 ${String((y + ty) / 2 - 25)} ${String(tx)} ${String(ty)}`,
      );
      edge.setAttribute("fill", "none");
      edge.setAttribute(
        "stroke",
        selection.selected === m.id ? "#80591f" : "#33755e",
      );
      edge.setAttribute(
        "stroke-width",
        selection.selected === m.id ? "4" : "1",
      );
      edge.setAttribute("marker-end", "url(#vg-arrow)");
      const title = document.createElementNS(ns, "title");
      title.textContent = `${m.from} → ${m.to} · ${m.state} · ${m.id}`;
      edge.append(title);
      edge.onclick = () => {
        selection.selected = m.id;
        render();
      };
      svg.append(edge);
    }
    const defs = document.createElementNS(ns, "defs"),
      marker = document.createElementNS(ns, "marker"),
      arrow = document.createElementNS(ns, "path");
    marker.id = "vg-arrow";
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", "#33755e");
    marker.append(arrow);
    defs.append(marker);
    svg.prepend(defs);
    for (const id of ids) {
      const pos = positions.get(id);
      if (!pos) continue;
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", String(pos.x));
      label.setAttribute("y", String(pos.y));
      label.textContent = data.nodes.find((n) => n.id === id)?.label || id;
      const title = document.createElementNS(ns, "title");
      title.textContent = id;
      label.append(title);
      svg.append(label);
    }
    diagram.append(svg);
    const old = new Map(
      Array.from(list.querySelectorAll<HTMLButtonElement>("button")).map(
        (el) => [el.dataset["messageId"], el],
      ),
    );
    const children = rows.map((m) => {
      const button = old.get(m.id) || element("button");
      button.type = "button";
      button.dataset["messageId"] = m.id;
      button.setAttribute("aria-pressed", String(selection.selected === m.id));
      button.replaceChildren(
        element("strong", `${m.from} → ${m.to}`),
        element("span", `${m.kind} · ${m.state}`),
        element("small", stamp(m.at)),
        element("span", m.text.slice(0, 180) || "(sans contenu)"),
      );
      button.onclick = () => {
        selection.selected = m.id;
        for (const b of list.querySelectorAll("button"))
          b.setAttribute("aria-pressed", String(b === button));
        inspect();
      };
      return button;
    });
    // Reconcile existing nodes: preserve keyboard focus and scroll during read refreshes.
    for (const child of Array.from(list.children))
      if (!children.includes(child as HTMLButtonElement)) child.remove();
    children.forEach((child, i) => {
      if (list.children[i] !== child)
        list.insertBefore(child, list.children[i] || null);
    });
    list.scrollTop = scroll;
    if (focus)
      children
        .find((b) => b.dataset["messageId"] === focus)
        ?.focus({ preventScroll: true });
    const detailScroll = limits.scrollTop;
    limits.replaceChildren(
      summary,
      ...data.limits.map((x) => element("p", x)),
      ...data.sources.map((s) =>
        element(
          "p",
          `${s.path} · ${s.state}${s.error ? " · " + s.error : ""} · source ${stamp(s.at)} · lu ${stamp(s.readAt)}`,
        ),
      ),
    );
    limits.scrollTop = detailScroll;
    inspect();
    if (activeTab?.startsWith("vg-tab-"))
      document.getElementById(activeTab)?.focus({ preventScroll: true });
  }
  async function refresh() {
    if (busy || disposed) return;
    busy = true;
    reload.disabled = true;
    status.textContent =
      "Lecture locale en cours · dernière observation conservée · activité actuelle non rafraîchie";
    try {
      const run = (await invoke("voice_graph")) as {
        stdout: string;
        exitCode: number;
      };
      const response = JSON.parse(run.stdout) as {
        ok: boolean;
        data?: VoiceGraph;
        error?: { message: string };
      };
      if (run.exitCode !== 0 || !response.ok || response.data?.version !== 1)
        throw Error(
          response.error?.message || "Contrat du graphe indisponible",
        );
      graph = response.data;
      status.textContent = `Lecture seule · observé ${stamp(graph.observedAt)} · aucun envoi depuis cette vue`;
      render();
    } catch (error) {
      status.textContent = `État indisponible · ${String(error)} · dernière lecture conservée, activité actuelle inconnue`;
    } finally {
      busy = false;
      reload.disabled = false;
    }
  }
  reload.onclick = () => {
    void refresh();
  };
  search.oninput = () => {
    selection.query = search.value;
    page = 0;
    render();
  };
  // No polling while hidden, no concurrency, and no timer that advances a message status.
  const timer = window.setInterval(() => {
    if (!root.closest("[hidden]")) void refresh();
  }, 15000);
  const open = () => {
    void refresh();
  };
  document.getElementById("tab-voice")?.addEventListener("click", open);
  if (!root.closest("[hidden]")) void refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      document.getElementById("tab-voice")?.removeEventListener("click", open);
      window.clearInterval(timer);
    },
  };
}
