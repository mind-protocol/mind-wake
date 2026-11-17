interface Option {
  id: string;
  label: string;
}
interface Response {
  frames?: { id: number; time: string; target: string; cols: number; grid: string }[];
  agents?: { id: string; name: string }[];
  parts?: Option[];
  text?: string;
  fields?: (Option & { text: string; revision: string; start: number; end: number })[];
  editable?: boolean;
  revision?: string;
}
export function mountPromptEditor(invoke: (request: Record<string, unknown>) => Promise<Response>) {
  const agent = document.querySelector<HTMLSelectElement>("#prompt-agent")!;
  const part = document.querySelector<HTMLSelectElement>("#prompt-part")!;
  const editor = document.querySelector<HTMLTextAreaElement>("#prompt-text")!;
  const save = document.querySelector<HTMLButtonElement>("#prompt-save")!;
  const reload = document.querySelector<HTMLButtonElement>("#prompt-reload")!;
  const status = document.getElementById("prompt-status")!;
  let id = "",
    source = "preview",
    loaded = false,
    busy = false;
  const container = document.getElementById("prompt-fields")!;
  interface Draft {
    input: HTMLTextAreaElement;
    original: string;
    newline: string;
    revision: string | undefined;
    part: string;
  }
  let drafts: Draft[] = [];
  const vision = document.getElementById("prompt-vision")!;
  vision.hidden = true;
  const visionStatus = document.getElementById("prompt-vision-status")!;
  const tiles = document.getElementById("prompt-vision-grid")!;
  const editTab = document.getElementById("prompt-edit-view")!;
  const visionTab = document.getElementById("prompt-vision-view")!;
  const dialog = document.querySelector<HTMLDialogElement>("#prompt-vision-dialog")!;
  document.getElementById("prompt-vision-close")!.onclick = () => dialog.close();
  let promptAgents: {id:string; name:string}[] = [];
  let visionAgent = "", generation = 0, loadingVision = false, tileKey = "";
  let refreshTimer: number | undefined;
  let followLatest = false;
  let agentChoices = "";

  function selectView(visionActive: boolean) {
    window.clearInterval(refreshTimer);
    if (visionActive) refreshTimer = window.setInterval(() => {
      if (!document.hidden && !document.getElementById("view-prompts")!.hidden) void showVision();
    }, 2000);
    reload.hidden = visionActive;
    agentChoices = "";
    vision.hidden = !visionActive;
    document.getElementById("prompt-edit-panel")!.hidden = visionActive;
    document.getElementById("prompt-source-label")!.hidden = visionActive;
    editTab.setAttribute("aria-pressed", String(!visionActive));
    visionTab.setAttribute("aria-pressed", String(visionActive));
    generation++;
    loadingVision = false;
  }
  async function showVision(clear = false) {
    if (clear) {
      generation++;
      tileKey = "";
      tiles.replaceChildren();
      visionStatus.textContent = "Chargement des captures…";
    } else if (loadingVision) return;
    const version = generation;
    loadingVision = true;
    try {
      const data = await invoke({action:"vision", agent:visionAgent});
      if (version !== generation) return;
      const choices = new Map([...promptAgents, ...(data.agents ?? [])].map(a => [a.id, a.name]));
      const choicesKey = JSON.stringify([...choices]);
      if (agentChoices !== choicesKey) {
        agent.replaceChildren(...Array.from(choices, ([value,name]) => new Option(name,value)));
        agentChoices = choicesKey;
      }
      agent.value = visionAgent;
      if (!visionAgent && agent.options.length) {
        visionAgent = agent.options[0]!.value;
        await showVision(true);
        return;
      }
      const frames = data.frames ?? [];
      visionStatus.textContent = frames.length ? "" : "Aucune capture ASCII enregistrée pour cet agent.";
      const key = frames.map(f => f.id).join(",");
      if (key === tileKey) return;
      tileKey = key;
      if (dialog.open && followLatest && frames[0]) {
        dialog.querySelector("pre")!.textContent = frames[0].grid;
        dialog.setAttribute("aria-label",new Date(frames[0].time).toLocaleString() + " · " + frames[0].target);
      }
      tiles.replaceChildren(...frames.map(frame => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "vision-frame";
        const caption = document.createElement("span");
        caption.textContent = new Date(frame.time).toLocaleString() + " · " + frame.target;
        const square = document.createElement("span");
        square.className = "vision-square";
        const pre = document.createElement("pre");
        pre.style.setProperty("--vision-size", Math.min(150/frame.cols,90/frame.grid.split("\n").length)+"cqw");
        pre.textContent = frame.grid;
        pre.setAttribute("aria-hidden","true");
        square.append(pre);
        card.append(square, caption);
        card.onclick = () => {
          followLatest = frame.id === frames[0]?.id;
          dialog.querySelector("pre")!.textContent = frame.grid;
          dialog.setAttribute("aria-label",caption.textContent ?? "Capture ASCII");
          dialog.showModal();
        };
        return card;
      }));
    } catch (error) {
      if (version === generation) visionStatus.textContent = String(error);
    } finally {
      if (version === generation) loadingVision = false;
    }
  }
  visionTab.onclick = () => {
    if (busy || !vision.hidden) return;
    selectView(true);
    visionAgent = id;
    void showVision(true);
  };
  editTab.onclick = () => {
    if (vision.hidden) return;
    const next = promptAgents.some(a => a.id === visionAgent) ? visionAgent : id;
    if (next !== id && !canLeave()) return;
    selectView(false);
    agent.replaceChildren(...promptAgents.map(a => new Option(a.name,a.id)));
    agent.value = id;
    if (next !== id) void perform(() => read(next,"preview"));
  };
  const dirty = () => drafts.some((d) => d.input.value !== d.original);
  function track(input: HTMLTextAreaElement, part: string, raw: string, revision?: string) {
    input.value = raw;
    drafts.push({
      input,
      part,
      original: input.value,
      revision,
      newline: raw.includes("\r\n") ? "\r\n" : "\n",
    });
    input.oninput = () => {
      controls();
      status.textContent = dirty() ? "Modifications non enregistrées." : "";
    };
  }
  function showFields(data: Response) {
    container.replaceChildren();
    const text = data.text ?? "";
    let cursor = 0;
    function literal(raw: string) {
      if (!raw.trim()) return;
      const pre = document.createElement("pre");
      pre.textContent = raw;
      container.append(pre);
    }
    const fields = [...(data.fields ?? [])].sort(
      (a, b) => (a.start < 0 ? Infinity : a.start) - (b.start < 0 ? Infinity : b.start),
    );
    for (const f of fields) {
      if (f.start < 0) {
        literal(text.slice(cursor));
        cursor = text.length;
      } else {
        literal(text.slice(cursor, f.start));
        cursor = f.end;
      }
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = document.createElement("textarea");
      input.spellcheck = false;
      input.rows = Math.max(3, Math.min(16, f.text.split("\n").length + 1));
      label.append(input);
      container.append(label);
      track(input, f.id, f.text, f.revision);
    }
    literal(text.slice(cursor));
  }
  function controls() {
    agent.disabled = part.disabled = reload.disabled = busy;
    editor.disabled = busy || !loaded;
    for (const d of drafts) d.input.disabled = busy || !loaded;
    save.disabled = busy || !loaded || !dirty();
  }
  async function perform(task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    controls();
    try {
      await task();
    } catch (e) {
      status.textContent = String(e);
    } finally {
      busy = false;
      controls();
    }
  }
  async function read(nextId: string, nextPart: string) {
    const data = await invoke({ action: "read", agent: nextId, part: nextPart });
    id = nextId;
    source = nextPart;
    agent.value = id;
    part.replaceChildren(...(data.parts ?? []).map((p) => new Option(p.label, p.id)));
    part.value = source;
    const raw = data.text ?? "";
    drafts = [];
    container.hidden = !data.fields;
    editor.hidden = !!data.fields;
    loaded = true;
    editor.readOnly = !data.editable;
    if (data.fields) showFields(data);
    else if (data.editable) track(editor, source, raw, data.revision);
    else editor.value = raw;
    status.textContent = data.editable ? "" : "Archive du dernier appel.";
  }
  function canLeave() {
    return !dirty() || confirm("Abandonner les modifications non enregistrées ?");
  }
  async function load() {
    const data = await invoke({ action: "list" });
    const agents = data.agents ?? [];
    promptAgents = agents;
    agent.replaceChildren(...agents.map((a) => new Option(a.name, a.id)));
    if (!agents.length) {
      loaded = false;
      editor.value = "";
      drafts = [];
      container.replaceChildren();
      part.replaceChildren();
      status.textContent = "Aucun agent disponible.";
      return;
    }
    const exists = agents.some((a) => a.id === id);
    await read(exists ? id : agents[0]!.id, exists ? source : "preview");
  }
  agent.onchange = () => {
    const next = agent.value;
    if (!vision.hidden) {
      visionAgent = next;
      void showVision(true);
      return;
    }
    agent.value = id;
    if (canLeave()) void perform(() => read(next, "preview"));
  };
  part.onchange = () => {
    const next = part.value;
    part.value = source;
    if (canLeave()) void perform(() => read(id, next));
  };
  reload.onclick = () => {
    if (!vision.hidden) { void showVision(true); return; }
    if (canLeave()) void perform(load);
  };
  save.onclick = () =>
    void perform(async () => {
      for (const d of drafts) {
        if (d.input.value === d.original) continue;
        const result = await invoke({
          action: "save",
          agent: id,
          part: d.part,
          text: d.input.value.replace(/\n/g, d.newline),
          revision: d.revision,
        });
        d.original = d.input.value;
        d.revision = result.revision;
      }
      status.textContent = "Enregistré.";
    });
  window.addEventListener("beforeunload", (e) => {
    if (dirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  return {
    open: () => {
      if (!vision.hidden) void showVision(true);
      else if (!dirty()) void perform(load);
    },
  };
}
