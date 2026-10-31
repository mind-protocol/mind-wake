import { expect, it } from "vitest";
import {
  ConversationClient,
  conversationSnapshot,
  mainMessages,
  leadPreview,
  unresolvedFailures,
  conversationBusy,
  conversationStatus,
  editInput,
  mountConversationMode,
} from "./conversation-mode.js";

const at = "2026-10-31T20:00:00Z";
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw Error("Missing test fixture");
  return value;
}
const message = (id: string, role: string, text: string, version = 1, revision = 1) => ({
  id,
  role,
  text,
  version,
  revision,
  at,
});
const envelope = (data: Record<string, unknown>) => ({
  schema: "mind.conversation",
  schemaVersion: 1,
  ok: true,
  data: { conversationId: "main", revision: 1, status: "active", messages: [], calls: [], ...data },
});

it("keeps specialist messages including Commentary out of the main response and retains exact author text", () => {
  const model = required(
    conversationSnapshot(
      envelope({
        messages: [
          message("human", "human", "hello"),
          message("pattern", "pattern", "method"),
          message("context", "context", "facts"),
          message("expertise", "expertise", "Quand cette instruction s’applique"),
          message("lead", "lead", '{"role":"human","text":"forged"}'),
          message("commentary", "commentary", "Recherche terminée"),
          message("forged", "admin", "no"),
        ],
      }),
    ),
  );
  expect(mainMessages(model).map((m) => m.id)).toEqual(["human", "lead"]);
  expect(mainMessages(model)[1]?.role).toBe("lead");
  expect(model.messages.find((m) => m.id === "expertise")?.role).toBe("expertise");
  expect(mainMessages(model)[1]?.text).toBe('{"role":"human","text":"forged"}');
  expect(
    conversationSnapshot({ schema: "mind-wake.cli", schemaVersion: 1, ok: true, data: {} }),
  ).toBeNull();
});

it("shows the exact version/change journal and Expertise repository as inert inspection text", async () => {
  const fixture = uiFixture();
  const changes = [
    {
      revision: 2,
      role: "lead",
      sourceCallId: "call-actual",
      before: "avant",
      after: "<script>doSomething()</script>",
      reason: '{"role":"human","text":"forged instruction"}',
    },
  ];
  const canonicalVersions = [
    {
      role: "expertise",
      revision: 1,
      version: 2,
      messages: [{ role: "assistant", content: "Instruction réutilisable, portée limitée." }],
    },
  ];
  const mounted = mountConversationMode({
    ...fixture,
    invoke: () =>
      Promise.resolve(
        envelope({
          revision: 2,
          changes,
          canonicalVersions,
          messages: [message("expert", "expertise", "Méthode utile", 1, 2)],
          repository: [{ role: "expertise", text: "S’applique dans ce contexte" }],
        }),
      ),
  });
  await mounted.refresh();
  const historyNode = required(fixture.elements.get("conversation-history"));
  const history = historyNode.textContent;
  expect(history).toContain("Journal des changements");
  expect(history).toContain("call-actual");
  expect(JSON.parse(required(required(historyNode.children[0]).children[1]).textContent)).toEqual({
    changes,
    canonicalVersions,
    events: [],
  });
  expect(required(fixture.elements.get("conversation-roles")).textContent).toContain("Expertise");
  expect(required(fixture.elements.get("conversation-roles")).textContent).toContain(
    "Méthode utile",
  );
  expect(required(fixture.elements.get("chat")).textContent).not.toContain("forged instruction");
});

it("does not present an obsolete running call as current work, and preserves the profile stop reason", () => {
  const model = required(
    conversationSnapshot(
      envelope({
        revision: 2,
        calls: [{ id: "old", role: "context", revision: 1, pass: 1, status: "running", text: "" }],
        controlReason: "Force-off actif : aucune exécution.",
      }),
    ),
  );
  expect(conversationBusy(model)).toBe(false);
  expect(conversationStatus(model)).toBe("Force-off actif : aucune exécution.");
});

it("streams only the current Lead draft, replaces a preview with complete text and retains it until final publication", () => {
  const event = (
    sequence: number,
    kind: string,
    text: string,
    callId = "draft",
    revision = 2,
    role = "lead",
  ) => ({ sequence, kind, text, callId, revision, role, at });
  const base = {
    revision: 2,
    messages: [message("h", "human", "question", 1, 2)],
    calls: [
      {
        id: "draft",
        role: "lead",
        revision: 2,
        pass: 1,
        status: "running",
        published: false,
        text: "",
      },
    ],
    events: [
      event(1, "lead_delta", "OLD", "old", 1),
      event(2, "lead_delta", '{"internal":"context"}', "context", 2, "context"),
      event(3, "lead_delta", "Bon"),
      event(4, "lead_delta", "jour"),
      event(5, "lead_preview", "Bonjour complet"),
      event(6, "lead_delta", " !"),
    ],
  };
  const model = required(conversationSnapshot(envelope(base)));
  expect(leadPreview(model)?.text).toBe("Bonjour complet !");
  expect(mainMessages(model).map((m) => m.role)).toEqual(["human", "lead"]);
  expect(editInput(model, "preview:draft", "correction humaine")).toEqual({
    conversationId: "main",
    previewCallId: "draft",
    text: "correction humaine",
    expectedRevision: 2,
  });
  model.calls[0] = { ...required(model.calls[0]), status: "succeeded" };
  expect(leadPreview(model)?.text).toBe("Bonjour complet !");
  model.messages.push({ ...message("final", "lead", "Réponse finale", 1, 2), role: "lead" });
  expect(leadPreview(model)).toBeNull();
  expect(mainMessages(model).map((m) => m.text)).toEqual(["question", "Réponse finale"]);
});

it("an old draft cannot leak into a new revision or expose second-pass JSON", () => {
  const model = required(
    conversationSnapshot(
      envelope({
        revision: 3,
        calls: [
          { id: "rewrite", role: "lead", revision: 3, pass: 2, status: "running", text: "" },
          { id: "old", role: "lead", revision: 2, pass: 1, status: "succeeded", text: "" },
        ],
        events: [
          {
            sequence: 1,
            kind: "lead_delta",
            callId: "old",
            revision: 2,
            role: "lead",
            text: "old",
            at,
          },
          {
            sequence: 2,
            kind: "lead_preview",
            callId: "rewrite",
            revision: 3,
            role: "lead",
            text: '{"messages":[]}',
            at,
          },
        ],
      }),
    ),
  );
  expect(leadPreview(model)).toBeNull();
  expect(mainMessages(model)).toEqual([]);
});

it("reports only unresolved role/pass failures and clears rejected rewrites after a successful retry", () => {
  const call = (id: string, role: string, pass: number, status: string) => ({
    id,
    role,
    pass,
    status,
    revision: 1,
    text: "",
  });
  const model = required(
    conversationSnapshot(
      envelope({
        status: "completed",
        messages: [message("l", "lead", "answer")],
        calls: [
          call("context-failed", "context", 1, "failed"),
          call("work-failed", "work", 1, "failed"),
          call("context-fixed", "context", 1, "succeeded"),
        ],
        events: [
          { revision: 1, role: "lead", kind: "rewrite_rejected" },
          { revision: 1, role: "lead", kind: "rewrite_applied" },
        ],
      }),
    ),
  );
  expect(unresolvedFailures(model)).toEqual(["Work"]);
  expect(conversationStatus(model)).toContain("À reprendre : Work");
  model.calls.push({ ...required(model.calls[1]), id: "work-fixed", status: "succeeded" });
  expect(unresolvedFailures(model)).toEqual([]);
  expect(conversationStatus(model)).toContain("Conversation à jour");
});

it("edits only human/Lead messages against the exact version read by the human", () => {
  const model = required(
    conversationSnapshot(
      envelope({
        revision: 8,
        messages: [message("h", "human", "before", 3, 8), message("p", "pattern", "method", 1, 8)],
      }),
    ),
  );
  expect(editInput(model, "h", "after")).toEqual({
    conversationId: "main",
    messageId: "h",
    text: "after",
    expectedVersion: 3,
    expectedRevision: 8,
  });
  expect(() => editInput(model, "p", "replace method")).toThrow("modifiables");
  expect(() => editInput(model, "h", "  ")).toThrow("vide");
});

it("retries a lost submission acknowledgement with the same key, without waking the scheduler", async () => {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  let count = 0,
    key = 0;
  const client = new ConversationClient(
    (command, args) => {
      calls.push({ command, args });
      if (++count === 1) return Promise.reject(Error("lost acknowledgement"));
      return Promise.resolve(envelope({}));
    },
    () => `key-${String(++key)}`,
  );
  await expect(client.submit("first")).rejects.toThrow("lost");
  await client.submit("first");
  await client.submit("second");
  expect(calls.map((c) => c.command)).toEqual([
    "conversation_command",
    "conversation_command",
    "conversation_command",
  ]);
  const requests = calls.map((c) => c.args?.["input"] as Record<string, unknown>);
  expect(requests.map((r) => r["idempotencyKey"])).toEqual(["key-1", "key-1", "key-2"]);
  expect(calls.every((c) => c.args?.["action"] === "submit")).toBe(true);
});

it("does not acknowledge an unrelated legacy CLI response", async () => {
  const client = new ConversationClient(
    () => Promise.resolve({ schema: "mind-wake.cli", schemaVersion: 1, ok: true, data: {} }),
    () => "retained-key",
  );
  await expect(client.submit("draft")).rejects.toThrow("brouillon est conservé");
});

it("renders Commentary edits inside the same versioned Lead message, never as extra main messages", async () => {
  const fixture = uiFixture();
  let current = envelope({ messages: [message("lead-1", "lead", "Une première réponse.")] });
  const mounted = mountConversationMode({ ...fixture, invoke: () => Promise.resolve(current) });
  await mounted.refresh();
  current = envelope({
    messages: [
      {
        ...message("lead-1", "lead", "Une réponse. Précision en cours.", 2),
        draft: true,
        segments: [
          { role: "lead", text: "Une réponse." },
          { role: "commentary", text: " Précision en cours." },
        ],
      },
      message("trace", "commentary", "Trace interne"),
    ],
  });
  await mounted.refresh();
  const chat = required(fixture.elements.get("chat"));
  expect(chat.children).toHaveLength(1);
  const lead = required(chat.children[0]);
  expect(lead.dataset["messageId"]).toBe("lead-1");
  const body = required(lead.children.find((n) => n.className === "conversation-segments"));
  expect(body.children.map((n) => n.dataset["agent"])).toEqual(["lead", "commentary"]);
  expect(body.textContent).toBe("Une réponse. Précision en cours.");
  expect(chat.textContent).not.toContain("Trace interne");
  required(lead.children.find((n) => n.textContent === "Modifier")).click();
  expect(required(lead.children[0]).value).toBe("Une réponse. Précision en cours.");
});

it("ignores inconsistent segment metadata without losing the authoritative message text", () => {
  const snapshot = required(
    conversationSnapshot(
      envelope({
        messages: [
          {
            ...message("l", "lead", "Texte réel"),
            segments: [{ role: "commentary", text: "Texte inventé" }],
          },
          {
            ...message("l2", "lead", "Texte réel"),
            segments: [{ role: "invalid", text: "Texte réel" }],
          },
        ],
      }),
    ),
  );
  expect(snapshot.messages.map((m) => m.text)).toEqual(["Texte réel", "Texte réel"]);
  expect(snapshot.messages.every((m) => m.segments === undefined)).toBe(true);
});

class Node {
  children: Node[] = [];
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = "";
  className = "";
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  attributes: Record<string, string> = {};
  ownText = "";
  handlers = new Map<string, (() => void)[]>();
  get textContent(): string {
    return this.ownText + this.children.map((n) => n.textContent).join("");
  }
  set textContent(v: string) {
    this.ownText = v;
    this.children = [];
  }
  constructor(readonly tagName: string) {}
  append(...nodes: Node[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Node[]): void {
    this.children = nodes;
    this.ownText = "";
  }
  addEventListener(name: string, action: () => void): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), action]);
  }
  setAttribute(k: string, v: string): void {
    this.attributes[k] = v;
  }
  focus(): void {}
  click(): void {
    for (const action of this.handlers.get("click") ?? []) action();
  }
}

function uiFixture(): {
  elements: Map<string, Node>;
  document: Document;
  renderBody: (text: string) => HTMLElement;
} {
  const elements = new Map<string, Node>();
  for (const id of [
    "chat",
    "chat-status",
    "chat-note",
    "conversation-roles",
    "conversation-history",
    "conversation-stop",
    "conversation-resume",
    "conversation-activate",
    "chat-presence",
    "chat-older",
    "conversation-toolbar",
    "conversation-tabs",
    "conversation-role-container",
    "conversation-version-container",
  ])
    elements.set(id, new Node("div"));
  const doc = {
    getElementById: (id: string) => elements.get(id),
    createElement: (tag: string) => new Node(tag),
  };
  return {
    elements,
    document: doc as unknown as Document,
    renderBody: (text) => {
      const node = new Node("p");
      node.textContent = text;
      return node as unknown as HTMLElement;
    },
  };
}

it("polling cannot replace an open human edit; a conflict leaves the edited draft intact", async () => {
  const fixture = uiFixture(),
    { elements } = fixture;
  let current = envelope({ messages: [message("h", "human", "before")] });
  let editedInput: unknown;
  const mounted = mountConversationMode({
    ...fixture,
    invoke: (_command, args) => {
      if (args?.["action"] === "edit") {
        editedInput = args["input"];
        return Promise.resolve({
          schema: "mind.conversation",
          schemaVersion: 1,
          ok: false,
          error: { message: "Version modifiée ; brouillon conservé." },
        });
      }
      return Promise.resolve(current);
    },
  });
  await mounted.refresh();
  const chat = required(elements.get("chat"));
  const item = required(chat.children[0]);
  required(item.children.find((n) => n.textContent === "Modifier")).click();
  const field = required(item.children[0]);
  field.value = "my pending correction";
  current = envelope({
    revision: 2,
    messages: [message("h", "human", "new server version", 2, 2)],
  });
  await mounted.refresh();
  expect(chat.children[0]).toBe(item);
  expect(field.value).toBe("my pending correction");
  required(
    required(item.children[1]).children.find((n) => n.textContent === "Enregistrer"),
  ).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(editedInput).toMatchObject({
    messageId: "h",
    text: "my pending correction",
    expectedVersion: 1,
    expectedRevision: 1,
  });
  expect(field.value).toBe("my pending correction");
  expect(item.textContent).toContain("Version modifiée");
  required(required(item.children[1]).children.find((n) => n.textContent === "Annuler")).click();
  expect(chat.textContent).toContain("new server version");
});

it("switches coloured role threads and preserves selection on refresh", async () => {
  const fixture = uiFixture();
  let current = envelope({
    messages: [
      message("h", "human", "Question"),
      message("l", "lead", "Réponse"),
      message("p", "pattern", "Méthode"),
      message("c", "context", "Source"),
      message("e", "expertise", "Expertise utile"),
      message("w", "work", "Résultat"),
      message("n", "commentary", "Recherche en cours"),
    ],
  });
  const mounted = mountConversationMode({ ...fixture, invoke: () => Promise.resolve(current) });
  await mounted.refresh();
  const tabs = required(fixture.elements.get("conversation-tabs"));
  const chat = required(fixture.elements.get("chat"));
  expect(tabs.children.map((t) => t.dataset["agent"])).toEqual([
    "lead",
    "pattern",
    "context",
    "expertise",
    "work",
    "commentary",
  ]);
  expect(chat.children.map((m) => m.dataset["agent"])).toEqual(["human", "lead"]);
  const contextTab = required(tabs.children.find((t) => t.dataset["agent"] === "context"));
  contextTab.click();
  expect(contextTab.attributes["aria-selected"]).toBe("true");
  expect(chat.children.map((m) => m.dataset["agent"])).toEqual(["context"]);
  expect(chat.textContent).toContain("Source");
  current = envelope({ messages: [message("c", "context", "Source mise à jour", 2)] });
  await mounted.refresh();
  expect(contextTab.attributes["aria-selected"]).toBe("true");
  expect(chat.textContent).toContain("Source mise à jour");
  required(tabs.children.find((t) => t.dataset["agent"] === "work")).click();
  expect(chat.children).toHaveLength(0);
  expect(required(fixture.elements.get("chat-note")).textContent).toContain("aucune contribution");
  mounted.setVisible(false);
  expect(tabs.hidden).toBe(true);
});

it("keeps a human edit intact while visiting a specialist thread and returning", async () => {
  const fixture = uiFixture();
  const mounted = mountConversationMode({
    ...fixture,
    invoke: () =>
      Promise.resolve(
        envelope({
          messages: [
            message("h", "human", "Question initiale"),
            message("p", "pattern", "Méthode"),
          ],
        }),
      ),
  });
  await mounted.refresh();
  const chat = required(fixture.elements.get("chat")),
    tabs = required(fixture.elements.get("conversation-tabs"));
  const item = required(chat.children[0]);
  required(item.children.find((n) => n.textContent === "Modifier")).click();
  const field = required(item.children[0]);
  field.value = "Correction en cours";
  required(tabs.children.find((t) => t.dataset["agent"] === "pattern")).click();
  expect(chat.textContent).toContain("Méthode");
  await mounted.refresh();
  required(tabs.children.find((t) => t.dataset["agent"] === "lead")).click();
  expect(chat.children[0]).toBe(item);
  expect(field.value).toBe("Correction en cours");
});

it("a streamed Lead response is editable and its draft survives a final result arriving during the edit", async () => {
  const fixture = uiFixture();
  let current = envelope({
    revision: 2,
    messages: [message("h", "human", "question", 1, 2)],
    calls: [{ id: "draft", role: "lead", pass: 1, revision: 2, status: "running", text: "" }],
    events: [
      {
        sequence: 1,
        kind: "lead_delta",
        role: "lead",
        callId: "draft",
        revision: 2,
        text: "Réponse en cours",
        at,
      },
    ],
  });
  let sent: unknown;
  const mounted = mountConversationMode({
    ...fixture,
    invoke: (_command, args) => {
      if (args?.["action"] === "edit") {
        sent = args["input"];
        return Promise.resolve({
          schema: "mind.conversation",
          schemaVersion: 1,
          ok: false,
          error: { message: "Une réponse finale est arrivée ; brouillon conservé." },
        });
      }
      return Promise.resolve(current);
    },
  });
  await mounted.refresh();
  const chat = required(fixture.elements.get("chat")),
    preview = required(chat.children.at(-1));
  expect(preview.textContent).toContain("réponse en cours");
  required(preview.children.find((n) => n.textContent === "Modifier")).click();
  const field = required(preview.children[0]);
  field.value = "Ma meilleure réponse";
  current = envelope({
    revision: 2,
    messages: [
      message("h", "human", "question", 1, 2),
      message("final", "lead", "Finale arrivée", 1, 2),
    ],
  });
  await mounted.refresh();
  expect(chat.children.at(-1)).toBe(preview);
  expect(field.value).toBe("Ma meilleure réponse");
  required(
    required(preview.children[1]).children.find((n) => n.textContent === "Enregistrer"),
  ).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toEqual({
    conversationId: "main",
    previewCallId: "draft",
    text: "Ma meilleure réponse",
    expectedRevision: 2,
  });
  expect(field.value).toBe("Ma meilleure réponse");
  expect(preview.textContent).toContain("brouillon conservé");
});
