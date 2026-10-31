/** Main conversation owned by Wake, independent of provider session history. */
export const ROLE_LABELS = {
  human: "Toi",
  lead: "Lead",
  pattern: "Pattern",
  context: "Contexte",
  expertise: "Expertise",
  work: "Work",
  commentary: "Commentary",
} as const;
export type ConversationRole = keyof typeof ROLE_LABELS;
export const CONVERSATION_THREADS = [
  "lead",
  "pattern",
  "context",
  "expertise",
  "work",
  "commentary",
] as const;
export type ConversationThread = (typeof CONVERSATION_THREADS)[number];
export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  text: string;
  version: number;
  at: string;
  revision: number;
  pass?: number;
  edited?: boolean;
  provisional?: boolean;
  draft?: boolean;
  previewCallId?: string;
  segments?: { role: ConversationRole; text: string }[];
}
export interface ConversationCall {
  id: string;
  role: ConversationRole;
  revision: number;
  pass: number;
  status: string;
  text: string;
  error?: string;
  messages?: unknown;
  systemPrompt?: string;
  usage?: number;
  inputHash?: string;
  published?: boolean;
}
export interface ConversationSnapshot {
  conversationId: string;
  revision: number;
  status: string;
  messages: ConversationMessage[];
  calls: ConversationCall[];
  canonicals: unknown[];
  repository: unknown[];
  events: unknown[];
  controlReason: string | null;
  messageVersions: unknown[];
  changes: unknown[];
  canonicalVersions: unknown[];
}
type Rec = Record<string, unknown>;
function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function role(value: unknown): value is ConversationRole {
  return typeof value === "string" && Object.hasOwn(ROLE_LABELS, value);
}

export function conversationSnapshot(envelope: unknown): ConversationSnapshot | null {
  const env = rec(envelope),
    data = rec(env?.["data"]),
    state = rec(data?.["conversation"]);
  if (
    env?.["schema"] !== "mind.conversation" ||
    env["schemaVersion"] !== 1 ||
    env["ok"] !== true ||
    !data
  )
    return null;
  const conversationId = str(data["conversationId"]) ?? str(state?.["id"]),
    revision = data["revision"] ?? state?.["revision"],
    status = str(data["status"]) ?? str(state?.["status"]);
  if (!conversationId || !integer(revision) || !status) return null;
  const messages: ConversationMessage[] = [];
  for (const raw of Array.isArray(data["messages"]) ? data["messages"] : []) {
    const m = rec(raw),
      id = str(m?.["id"]),
      text = str(m?.["text"]),
      at = str(m?.["at"]);
    if (
      !id ||
      text === null ||
      !at ||
      !Number.isFinite(Date.parse(at)) ||
      !role(m?.["role"]) ||
      !integer(m["version"]) ||
      !integer(m["revision"])
    )
      continue;
    const segments = Array.isArray(m["segments"])
      ? m["segments"].flatMap((raw) => {
          const segment = rec(raw);
          return role(segment?.["role"]) && typeof segment["text"] === "string"
            ? [{ role: segment["role"], text: segment["text"] }]
            : [];
        })
      : [];
    messages.push({
      id,
      role: m["role"],
      text,
      version: m["version"],
      at,
      revision: m["revision"],
      ...(integer(m["pass"]) ? { pass: m["pass"] } : {}),
      ...(m["edited"] === true ? { edited: true } : {}),
      ...(m["draft"] === true ? { draft: true, provisional: true } : {}),
      ...(segments.length > 0 &&
      segments.length === (m["segments"] as unknown[]).length &&
      segments.map((s) => s.text).join("") === text
        ? { segments }
        : {}),
    });
  }
  const calls: ConversationCall[] = [];
  for (const raw of Array.isArray(data["calls"]) ? data["calls"] : []) {
    const c = rec(raw),
      id = str(c?.["id"]),
      status = str(c?.["status"]);
    if (!id || !status || !role(c?.["role"]) || !integer(c["revision"]) || !integer(c["pass"]))
      continue;
    const error = str(c["error"]),
      systemPrompt = str(c["systemPrompt"]);
    calls.push({
      id,
      role: c["role"],
      status: data["workerRunning"] === false && status === "running" ? "interrupted" : status,
      revision: c["revision"],
      pass: c["pass"],
      text: str(c["text"]) ?? "",
      ...(data["workerRunning"] === false && status === "running"
        ? { error: error ?? "Le moteur de conversation s’est arrêté avant de rendre son résultat." }
        : error
          ? { error }
          : {}),
      messages: c["messages"],
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(typeof c["usage"] === "number" && Number.isFinite(c["usage"]) && c["usage"] >= 0
        ? { usage: c["usage"] }
        : {}),
      ...(typeof c["inputHash"] === "string" ? { inputHash: c["inputHash"] } : {}),
      ...(typeof c["published"] === "boolean" ? { published: c["published"] } : {}),
    });
  }
  const array = (name: string): unknown[] =>
    Array.isArray(data[name]) ? (data[name] as unknown[]) : [];
  const controls = rec(data["controls"]);
  return {
    conversationId,
    revision,
    status,
    messages,
    calls,
    canonicals: array("canonicals"),
    repository: array("repository"),
    events: array("events"),
    messageVersions: array("messageVersions"),
    changes: array("changes"),
    canonicalVersions: array("canonicalVersions"),
    controlReason: str(data["controlReason"]) ?? str(controls?.["reason"]),
  };
}

/** Only public draft events tied to an eligible Lead call can become a preview. */
export function leadPreview(snapshot: ConversationSnapshot): ConversationMessage | null {
  if (snapshot.messages.some((m) => m.role === "lead" && m.revision === snapshot.revision))
    return null;
  const calls = new Map(
    snapshot.calls
      .filter(
        (c) =>
          c.role === "lead" &&
          c.pass === 1 &&
          c.revision === snapshot.revision &&
          ["running", "succeeded"].includes(c.status) &&
          c.published !== true,
      )
      .map((c) => [c.id, c]),
  );
  const drafts = new Map<string, { text: string; at: string; sequence: number }>();
  for (const raw of [...snapshot.events].sort(
    (a, b) => Number(rec(a)?.["sequence"] ?? 0) - Number(rec(b)?.["sequence"] ?? 0),
  )) {
    const event = rec(raw),
      callId = str(event?.["callId"]),
      text = str(event?.["text"]),
      at = str(event?.["at"]);
    if (
      event?.["revision"] !== snapshot.revision ||
      event["role"] !== "lead" ||
      !callId ||
      !calls.has(callId) ||
      text === null ||
      !at ||
      !Number.isFinite(Date.parse(at)) ||
      !integer(event["sequence"])
    )
      continue;
    if (event["kind"] !== "lead_delta" && event["kind"] !== "lead_preview") continue;
    const previous = drafts.get(callId);
    drafts.set(callId, {
      text: event["kind"] === "lead_preview" ? text : (previous?.text ?? "") + text,
      at,
      sequence: event["sequence"],
    });
  }
  const latest = [...drafts.entries()].sort((a, b) => a[1].sequence - b[1].sequence).at(-1);
  if (!latest || !latest[1].text) return null;
  return {
    id: `preview:${latest[0]}`,
    role: "lead",
    text: latest[1].text,
    version: 0,
    at: latest[1].at,
    revision: snapshot.revision,
    pass: 1,
    provisional: true,
    previewCallId: latest[0],
  };
}
export function mainMessages(snapshot: ConversationSnapshot): ConversationMessage[] {
  const messages = snapshot.messages.filter((m) => m.role === "human" || m.role === "lead");
  const preview = leadPreview(snapshot);
  return preview ? [...messages, preview] : messages;
}

/** A later successful retry recovers the failure of the same role and pass. */
export function unresolvedFailures(snapshot: ConversationSnapshot): string[] {
  const latest = new Map<string, ConversationCall>();
  for (const call of snapshot.calls)
    if (call.revision === snapshot.revision) latest.set(`${call.role}:${String(call.pass)}`, call);
  const failed = new Set(
    [...latest.values()]
      .filter((c) => c.status === "failed" || c.status === "interrupted")
      .map((c) => ROLE_LABELS[c.role]),
  );
  const rewrites = new Map<ConversationRole, boolean>();
  let cycleFailed = false;
  for (const raw of snapshot.events) {
    const event = rec(raw);
    if (event?.["revision"] !== snapshot.revision) continue;
    if (event["kind"] === "cycle_started" || event["kind"] === "cycle_completed")
      cycleFailed = false;
    if (event["kind"] === "cycle_failed") cycleFailed = true;
    if (role(event["role"]) && event["kind"] === "rewrite_rejected")
      rewrites.set(event["role"], true);
    if (role(event["role"]) && event["kind"] === "rewrite_applied")
      rewrites.set(event["role"], false);
    if (event["kind"] === "work_incomplete" && latest.get("work:1")?.status !== "succeeded")
      failed.add(ROLE_LABELS.work);
  }
  const result: string[] = [...failed];
  for (const [r, rejected] of rewrites) if (rejected) result.push(`${ROLE_LABELS[r]} · réécriture`);
  if (cycleFailed && !result.length) result.push("cycle interrompu");
  return result;
}
export function conversationBusy(snapshot: ConversationSnapshot): boolean {
  return snapshot.calls.some((c) => c.revision === snapshot.revision && c.status === "running");
}
export function conversationStatus(snapshot: ConversationSnapshot): string {
  if (snapshot.controlReason) return snapshot.controlReason;
  if (snapshot.status === "stopped")
    return "Conversation arrêtée. Les messages et versions sont conservés.";
  const current = snapshot.calls.filter((c) => c.revision === snapshot.revision),
    active = current.filter((c) => c.status === "running");
  if (active.length)
    return `En cours : ${active.map((c) => `${ROLE_LABELS[c.role]}${c.pass === 2 ? " · réécriture" : ""}`).join(", ")}.`;
  const failed = unresolvedFailures(snapshot);
  if (failed.length)
    return `À reprendre : ${failed.join(", ")}. Les contributions reçues sont conservées.`;
  if (
    snapshot.status === "active" &&
    snapshot.messages.some((m) => m.role === "human" && m.revision === snapshot.revision) &&
    !snapshot.messages.some((m) => m.role === "lead" && m.revision === snapshot.revision)
  )
    return "Message enregistré. Préparation du cycle de conversation…";
  return snapshot.messages.length
    ? "Conversation à jour. Chaque nouvel échange part de ses messages reconstruits."
    : "Écris un message pour commencer. Aucun réveil automatique.";
}
export function editInput(snapshot: ConversationSnapshot, messageId: string, text: string): Rec {
  const message = mainMessages(snapshot).find((m) => m.id === messageId);
  if (!message || (message.role !== "human" && message.role !== "lead"))
    throw Error("Seuls tes messages et ceux du Lead sont modifiables ici.");
  if (!text.trim()) throw Error("Le message ne peut pas être vide.");
  if (message.provisional && message.previewCallId)
    return {
      conversationId: snapshot.conversationId,
      previewCallId: message.previewCallId,
      text,
      expectedRevision: snapshot.revision,
    };
  return {
    conversationId: snapshot.conversationId,
    messageId,
    text,
    expectedVersion: message.version,
    expectedRevision: snapshot.revision,
  };
}

export type ConversationInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
function failure(envelope: unknown): string {
  const env = rec(envelope),
    data = rec(env?.["data"]),
    error = rec(env?.["error"]);
  return (
    str(error?.["message"]) ??
    str(data?.["detail"]) ??
    "Opération non confirmée. Le brouillon est conservé."
  );
}
export class ConversationClient {
  #pending: { text: string; key: string } | null = null;
  constructor(
    private readonly invoke: ConversationInvoke,
    private readonly makeKey: () => string,
    readonly conversationId = "main",
  ) {}
  async command(action: string, input: Rec = {}): Promise<unknown> {
    const result = await this.invoke("conversation_command", {
      action,
      input: { conversationId: this.conversationId, ...input },
    });
    if (rec(result)?.["ok"] !== true) throw Error(failure(result));
    if (rec(result)?.["schema"] !== "mind.conversation" || rec(result)?.["schemaVersion"] !== 1)
      throw Error("Format de conversation inattendu. Le brouillon est conservé.");
    return result;
  }
  async submit(text: string): Promise<unknown> {
    if (!text.trim()) throw Error("Le message ne peut pas être vide.");
    if (!this.#pending || this.#pending.text !== text)
      this.#pending = { text, key: this.makeKey() };
    const request = this.#pending;
    const result = await this.command("submit", { text, idempotencyKey: request.key });
    if (this.#pending === request) this.#pending = null;
    return result;
  }
}

export interface MountedConversation {
  refresh(): Promise<void>;
  submit(text: string): Promise<void>;
  control(action: "stop" | "finish" | "resume" | "activate"): Promise<void>;
  busy(): boolean;
  setVisible(visible: boolean): void;
}

/** Uses inert DOM nodes; never interprets role output as interface commands or HTML. */
export function mountConversationMode(options: {
  document: Document;
  invoke: ConversationInvoke;
  renderBody: (text: string) => HTMLElement;
  onUpdated?: (at: string) => void;
}): MountedConversation {
  const doc = options.document,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- ID-specific DOM return type is selected by the caller.
    element = <T extends HTMLElement>(id: string): T => {
      const value = doc.getElementById(id);
      if (!value) throw Error(`Élément absent : ${id}`);
      return value as T;
    };
  const client = new ConversationClient(
    options.invoke,
    () => `conversation-ui-${crypto.randomUUID()}`,
  );
  let snapshot: ConversationSnapshot | null = null,
    editing: string | null = null,
    visible = true,
    reading = false,
    lastSignature = "";
  let selectedThread: ConversationThread = "lead";
  let renderedThread: ConversationThread | null = null;
  let editingThread: ConversationThread | null = null;
  let editingNodes: HTMLElement[] | null = null;
  const scrollPositions = new Map<ConversationThread, number>();
  const tabButtons = new Map<ConversationThread, HTMLButtonElement>();
  const chat = element<HTMLOListElement>("chat"),
    tabs = element("conversation-tabs"),
    status = element("chat-status"),
    note = element("chat-note"),
    roles = element("conversation-roles"),
    history = element("conversation-history");
  function selectThread(thread: ConversationThread): void {
    if (thread === selectedThread) return;
    scrollPositions.set(selectedThread, chat.scrollTop);
    selectedThread = thread;
    lastSignature = "";
    render();
  }
  function button(label: string, action: () => void): HTMLButtonElement {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", action);
    return b;
  }
  function details(title: string, text: string): HTMLElement {
    const d = doc.createElement("details"),
      s = doc.createElement("summary"),
      p = doc.createElement("pre");
    s.textContent = title;
    p.textContent = text;
    d.append(s, p);
    return d;
  }
  tabs.replaceChildren(
    ...CONVERSATION_THREADS.map((thread, index) => {
      const tab = button(ROLE_LABELS[thread], () => {
        selectThread(thread);
      });
      tab.id = `conversation-tab-${thread}`;
      tab.dataset["agent"] = thread;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", "chat");
      tab.addEventListener("keydown", (event) => {
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % CONVERSATION_THREADS.length;
        else if (event.key === "ArrowLeft")
          next = (index + CONVERSATION_THREADS.length - 1) % CONVERSATION_THREADS.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = CONVERSATION_THREADS.length - 1;
        else return;
        event.preventDefault();
        const target = CONVERSATION_THREADS[next];
        if (!target) return;
        selectThread(target);
        tabButtons.get(target)?.focus();
      });
      tabButtons.set(thread, tab);
      return tab;
    }),
  );
  function render(): void {
    if (!snapshot || !visible) return;
    const state = snapshot;
    for (const [thread, tab] of tabButtons) {
      const active = thread === selectedThread;
      tab.setAttribute("aria-selected", String(active));
      tab.setAttribute("tabindex", active ? "0" : "-1");
      tab.dataset["busy"] = String(
        state.calls.some(
          (c) => c.role === thread && c.revision === state.revision && c.status === "running",
        ),
      );
    }
    chat.setAttribute("role", "tabpanel");
    chat.setAttribute("aria-labelledby", `conversation-tab-${selectedThread}`);
    if (editing !== null && selectedThread === editingThread && editingNodes) {
      if (chat.children[0] !== editingNodes[0]) chat.replaceChildren(...editingNodes);
      renderedThread = selectedThread;
      return;
    }
    const next = JSON.stringify([selectedThread, state]);
    if (next === lastSignature) return;
    lastSignature = next;
    const follow =
      chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100 || chat.children.length === 0;
    const ownMessages =
      selectedThread === "lead"
        ? mainMessages(state)
        : state.messages.filter((m) => m.role === selectedThread);
    const nodes = ownMessages.map((m) => {
      const li = doc.createElement("li"),
        meta = doc.createElement("small");
      li.dataset["self"] = String(m.role === "human");
      li.dataset["from"] =
        m.role === "commentary" ? "activity" : m.role === "human" ? "human" : "agent";
      li.dataset["messageId"] = m.id;
      li.dataset["agent"] = m.role;
      meta.textContent = `${ROLE_LABELS[m.role]} · ${new Date(m.at).toLocaleString("fr-FR")}${m.provisional ? " · réponse en cours" : ""}${m.pass === 2 ? " · réécrit" : ""}${m.edited ? " · modifié" : ""}`;
      if (m.segments?.length) {
        const body = doc.createElement("div");
        body.className = "conversation-segments";
        for (const segment of m.segments) {
          const part = options.renderBody(segment.text);
          part.className += " conversation-segment";
          part.dataset["agent"] = segment.role;
          body.append(part);
        }
        li.append(meta, body);
      } else li.append(meta, options.renderBody(m.text));
      if (m.role === "lead" && m.revision === state.revision && state.status === "active")
        li.append(
          button("Terminer l’activité", () => {
            void control("finish", m.revision);
          }),
        );
      if (m.role === "human" || m.role === "lead")
        li.append(
          button("Modifier", () => {
            beginEdit(m.id, li);
          }),
        );
      return li;
    });
    chat.replaceChildren(...nodes);
    if (renderedThread !== selectedThread)
      chat.scrollTop = scrollPositions.get(selectedThread) ?? chat.scrollHeight;
    else if (follow) chat.scrollTop = chat.scrollHeight;
    renderedThread = selectedThread;
    note.textContent =
      selectedThread !== "lead" && !ownMessages.length
        ? `${ROLE_LABELS[selectedThread]} · aucune contribution pour le moment. ${conversationStatus(state)}`
        : conversationStatus(state);
    element<HTMLButtonElement>("conversation-stop").disabled = state.status !== "active";
    element<HTMLButtonElement>("conversation-resume").hidden =
      state.status !== "stopped" && unresolvedFailures(state).length === 0;
    element("chat-presence").hidden = !conversationBusy(state);
    element("chat-older").hidden = true;
    roles.replaceChildren(
      ...(["pattern", "context", "expertise", "work"] as const).map((r) => {
        const own = state.messages.filter((m) => m.role === r),
          calls = state.calls.filter((c) => c.role === r),
          box = doc.createElement("details"),
          summary = doc.createElement("summary");
        box.dataset["agent"] = r;
        summary.textContent = `${ROLE_LABELS[r]} · ${calls.some((c) => c.status === "running" && c.revision === state.revision) ? "en cours" : `${String(own.length)} contribution(s)`}`;
        box.append(summary);
        for (const m of own) {
          const heading = doc.createElement("small");
          heading.textContent = `Révision ${String(m.revision)} · passe ${String(m.pass ?? 1)}`;
          box.append(heading, options.renderBody(m.text));
        }
        for (const c of calls) if (c.error) box.append(details(`Appel ${c.status}`, c.error));
        box.append(
          details(
            "Référentiel",
            JSON.stringify(
              state.repository.filter((entry) => rec(entry)?.["role"] === r),
              null,
              2,
            ),
          ),
        );
        return box;
      }),
    );
    history.replaceChildren(
      details(
        "Journal des changements",
        JSON.stringify(
          {
            changes: state.changes,
            canonicalVersions: state.canonicalVersions,
            events: state.events,
          },
          null,
          2,
        ),
      ),
      details("Conversations reconstruites", JSON.stringify(state.canonicals, null, 2)),
      details("Versions des messages", JSON.stringify(state.messageVersions, null, 2)),
      ...state.calls.map((c) =>
        details(
          `${ROLE_LABELS[c.role]} · révision ${String(c.revision)} · passe ${String(c.pass)} · ${c.status}`,
          JSON.stringify(
            {
              instructions: c.systemPrompt,
              messages: c.messages,
              resultat: c.text,
              erreur: c.error,
              consommation: c.usage ?? "inconnue",
              empreinteEntree: c.inputHash,
            },
            null,
            2,
          ),
        ),
      ),
    );
    const latest = mainMessages(state)
      .filter((m) => m.role !== "human")
      .at(-1)?.at;
    if (latest) options.onUpdated?.(latest);
  }
  function beginEdit(id: string, li: HTMLElement): void {
    if (!snapshot) return;
    const original = snapshot,
      message = mainMessages(snapshot).find((m) => m.id === id);
    if (!message) return;
    editing = id;
    editingThread = selectedThread;
    editingNodes = Array.from(chat.children) as HTMLElement[];
    const field = doc.createElement("textarea"),
      actions = doc.createElement("div"),
      error = doc.createElement("p");
    field.value = message.text;
    field.setAttribute("aria-label", `Modifier le message de ${ROLE_LABELS[message.role]}`);
    field.className = "conversation-edit";
    error.setAttribute("role", "status");
    const save = button("Enregistrer", () => {
      void (async () => {
        save.disabled = true;
        try {
          await client.command("edit", editInput(original, id, field.value));
          editing = null;
          editingThread = null;
          editingNodes = null;
          lastSignature = "";
          await refresh();
        } catch (e) {
          error.textContent = e instanceof Error ? e.message : String(e);
        } finally {
          save.disabled = false;
        }
      })();
    });
    actions.append(
      save,
      button("Annuler", () => {
        editing = null;
        editingThread = null;
        editingNodes = null;
        lastSignature = "";
        render();
      }),
    );
    li.replaceChildren(field, actions, error);
    field.focus();
  }
  async function refresh(): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      const result = await client.command("read");
      const next = conversationSnapshot(result);
      if (!next) throw Error("Format de conversation inattendu.");
      if (snapshot && next.revision < snapshot.revision) return;
      snapshot = next;
      render();
    } catch (e) {
      if (visible)
        note.textContent = `Conversation indisponible : ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      reading = false;
    }
  }
  async function control(
    action: "stop" | "finish" | "resume" | "activate",
    expectedRevision?: number,
  ): Promise<void> {
    status.textContent =
      action === "stop" || action === "finish"
        ? "Arrêt du travail…"
        : action === "activate"
          ? "Activation manuelle des conversations…"
          : "Reprise de la conversation…";
    try {
      await client.command(action, expectedRevision === undefined ? {} : { expectedRevision });
      status.textContent =
        action === "finish"
          ? "Activité terminée. Le prochain message lancera un nouveau cycle."
          : action === "stop"
            ? "Travail de la conversation arrêté."
            : action === "activate"
              ? "Conversations activées. Aucun réveil autonome."
              : "Reprise demandée. Les arrêts du profil restent appliqués.";
      await refresh();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  }
  element("conversation-stop").addEventListener("click", () => {
    void control("stop");
  });
  element("conversation-resume").addEventListener("click", () => {
    void control("resume");
  });
  element("conversation-activate").addEventListener("click", () => {
    void control("activate");
  });
  return {
    refresh,
    control,
    busy: () => snapshot !== null && conversationBusy(snapshot),
    setVisible(value) {
      if (value === visible) return;
      visible = value;
      element("conversation-toolbar").hidden = !value;
      tabs.hidden = !value;
      element("conversation-role-container").hidden = !value;
      element("conversation-version-container").hidden = !value;
      if (value) {
        lastSignature = "";
        render();
      }
    },
    async submit(text) {
      status.textContent = "Enregistrement du message…";
      const result = await client.submit(text);
      const confirmed = conversationSnapshot(result);
      if (!confirmed) throw Error("Format de conversation inattendu. Le brouillon est conservé.");
      if (!snapshot || confirmed.revision >= snapshot.revision) snapshot = confirmed;
      selectThread("lead");
      lastSignature = "";
      render();
      chat.scrollTop = chat.scrollHeight;
      status.textContent =
        "Message enregistré. Le cycle est pris en charge ; aucun réveil autonome.";
    },
  };
}
