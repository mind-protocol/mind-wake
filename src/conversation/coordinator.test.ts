import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ConversationStore } from "./store.js";
import { ConversationCoordinator } from "./coordinator.js";
import type { RoleCall, RoleRuntime } from "./role-runtime.js";
import { reconstructMessages, collectConsolidation, rememberUserInstructions } from "./messages.js";
import { parseRewrite } from "./rewrite.js";
import { serveConversation } from "./worker.js";
import { conversationCommand } from "./cli.js";

let dir: string, store: ConversationStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-cycle-"));
  store = new ConversationStore(dir);
  store.createConversation();
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
function fakeRuntime(withWork = false): { runtime: RoleRuntime; calls: RoleCall[] } {
  const calls: RoleCall[] = [];
  const runtime: RoleRuntime = {
    async run(call, options) {
      if (options?.signal?.aborted) throw options.signal.reason;
      calls.push(call);
      const envelope = JSON.parse(call.messages.at(-1)!.content) as Record<string, unknown>;
      let text: string;
      if (call.pass === 2) {
        const messages = envelope["conversationToRewrite"] as { role: string; content: string }[];
        let changed = false;
        text = JSON.stringify({
          messages: messages.map((m) => {
            if (m.role !== "assistant" || changed) return m;
            changed = true;
            return { ...m, content: `Amélioré : ${m.content}` };
          }),
          improvements: ["Un paragraphe reprend l’information nouvelle."],
          repository: [
            {
              key: "lesson",
              text: "Une information nouvelle peut modifier la réponse.",
              sources: ["fixture source"],
            },
          ],
        });
      } else if (call.role === "expertise")
        text = JSON.stringify({
          text: "Aucune règle nouvelle dans cette fixture.",
          instructions: [],
        });
      else if (call.role === "pattern")
        text = JSON.stringify({
          patterns: [{ name: "cœur du problème", effect: "Revoir la cible avant le format" }],
        });
      else if (call.role === "context")
        text = JSON.stringify({
          facts: [
            { information: "Fait pertinent", source: "fixture", impact: "Change l'approche" },
          ],
        });
      else if (call.role === "work")
        text = JSON.stringify({
          text: "Vrai résultat technique de la fixture",
          artifacts: ["result.txt"],
          remaining: [],
        });
      else if (call.role === "commentary")
        text = JSON.stringify({ text: "Work a commencé le travail demandé." });
      else if (call.systemPrompt.includes("sans JSON")) {
        text = "Je précise le besoin avant de choisir une solution.";
        options?.onEvent?.({ type: "delta", text });
      } else
        text = JSON.stringify({
          text: "Une réponse informée.",
          work: withWork
            ? [{ id: "task-one", title: "Produire", instructions: "Créer le résultat vérifiable" }]
            : [],
        });
      options?.onEvent?.({ type: "text", text });
      return { text, usage: 10, simulated: true };
    },
  };
  return { runtime, calls };
}

it("persists complete independent calls, applies rewrites visibly and uses them in the next fresh input", async () => {
  const state = store.submit("main", "Pour qui cette proposition a-t-elle de la valeur ?", "first"),
    fake = fakeRuntime();
  await new ConversationCoordinator(store, fake.runtime).run("main", state.revision);
  const snapshot = store.snapshot("main");
  expect(snapshot.status).toBe("completed");
  expect(snapshot.messages.filter((m) => m.role === "lead")).toHaveLength(1);
  expect(snapshot.messages.find((m) => m.role === "lead")?.text).toContain(
    "Amélioré : Une réponse informée.",
  );
  expect(snapshot.messages.find((m) => m.role === "human")?.text).toBe(state.text);
  expect(snapshot.calls.every((c) => c.messages.length > 0 && c.status === "succeeded")).toBe(true);
  expect(snapshot.events.some((e) => e.kind === "lead_delta")).toBe(true);
  const contextCall = fake.calls.find((c) => c.role === "context")!;
  expect(JSON.parse(contextCall.messages.at(-1)!.content)["leadBeginning"]).toContain("besoin");
  store.submit("main", "Et si on changeait de cible ?", "next");
  const messages = reconstructMessages(store.snapshot("main"), "lead", 1);
  expect(
    messages.some(
      (m) => m.role === "assistant" && m.content.includes("Amélioré : Une réponse informée."),
    ),
  ).toBe(true);
  expect(
    messages.some((m) => m.role === "user" && m.content === "Et si on changeait de cible ?"),
  ).toBe(true);
});

it("an edit cancels the obsolete revision and a late Context answer is not published", async () => {
  const state = store.submit("main", "Ancien besoin", "first"),
    fake = fakeRuntime();
  let started!: () => void, release!: () => void;
  const contextStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime: RoleRuntime = {
    async run(call, options) {
      if (call.role === "context") {
        started();
        await released;
      }
      return fake.runtime.run(call, options);
    },
  };
  const run = new ConversationCoordinator(store, runtime)
    .run("main", state.revision)
    .catch(() => {});
  await contextStarted;
  const human = store.messages("main").find((m) => m.role === "human")!;
  const revised = store.editMessage("main", human.id, "Nouveau besoin", human.version);
  release();
  await run;
  expect(
    store.messages("main").some((m) => m.role === "context" && m.revision === state.revision),
  ).toBe(false);
  await new ConversationCoordinator(store, fake.runtime).run("main", revised.revision);
  expect(store.snapshot("main").status).toBe("completed");
  expect(store.messages("main").find((m) => m.role === "human")?.text).toBe("Nouveau besoin");
});

it("a resumed cycle does not execute an already successful Work call twice", async () => {
  const state = store.submit("main", "Produis un fichier", "first"),
    fake = fakeRuntime(true);
  const coordinator = new ConversationCoordinator(store, fake.runtime);
  await coordinator.run("main", state.revision);
  const firstCount = fake.calls.length;
  expect(fake.calls.filter((c) => c.role === "work" && c.pass === 1)).toHaveLength(1);
  store.resumeConversation("main");
  await coordinator.run("main", state.revision);
  expect(fake.calls).toHaveLength(firstCount);
  expect(fake.calls.filter((c) => c.role === "work" && c.pass === 1)).toHaveLength(1);
});

it("a recovered Context result invalidates the earlier Lead answer without repeating completed Work", async () => {
  const state = store.submit("main", "Produis avec les bonnes sources", "first"),
    fake = fakeRuntime(true);
  let refuseContext = true;
  const runtime: RoleRuntime = {
    async run(call, options) {
      if (call.role === "context" && call.pass === 1 && refuseContext)
        throw Error("Source temporarily unavailable");
      return fake.runtime.run(call, options);
    },
  };
  const coordinator = new ConversationCoordinator(store, runtime);
  await coordinator.run("main", state.revision);
  const firstLead = store.messages("main").find((m) => m.role === "lead")!;
  refuseContext = false;
  store.resumeConversation("main");
  await coordinator.run("main", state.revision);
  const leads = fake.calls.filter(
    (c) => c.role === "lead" && c.pass === 1 && !c.systemPrompt.includes("sans JSON"),
  );
  expect(leads).toHaveLength(2);
  const nextPayload = JSON.parse(leads[1]!.messages.at(-1)!.content);
  expect(nextPayload.contributions.some((c: { role: string }) => c.role === "context")).toBe(true);
  expect(store.messages("main").filter((m) => m.role === "lead")).toHaveLength(1);
  expect(store.messages("main").find((m) => m.role === "lead")?.id).toBe(firstLead.id);
  expect(fake.calls.filter((c) => c.role === "work" && c.pass === 1)).toHaveLength(1);
});

it("a failed Work result remains an explicit source for the Lead rewrite", async () => {
  const state = store.submit("main", "Une tâche technique", "first"),
    fake = fakeRuntime(true);
  const runtime: RoleRuntime = {
    async run(call, options) {
      if (call.role === "work" && call.pass === 1)
        throw Error("Build failed with exact fixture error");
      return fake.runtime.run(call, options);
    },
  };
  await new ConversationCoordinator(store, runtime).run("main", state.revision);
  expect(
    store
      .events("main")
      .some((e) => e.kind === "work_incomplete" && e.text.includes("fixture error")),
  ).toBe(true);
  const rewrite = fake.calls.find((c) => c.role === "lead" && c.pass === 2)!;
  expect(JSON.parse(rewrite.messages.at(-1)!.content).failedCalls).toContainEqual(
    expect.objectContaining({ role: "work", error: "Build failed with exact fixture error" }),
  );
});

it("the worker remains idle after completion and stops without any autonomous model relaunch", async () => {
  store.submit("main", "Question simple", "first");
  const fake = fakeRuntime(),
    control = new AbortController();
  const serving = serveConversation(dir, "main", {
    runtime: fake.runtime,
    signal: control.signal,
    allow: () => true,
    idleMs: 5,
  });
  const timeout = Date.now() + 3000;
  while (store.current("main")!.status !== "completed") {
    if (Date.now() > timeout) throw Error("Fixture cycle did not complete");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const count = fake.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(fake.calls).toHaveLength(count);
  control.abort();
  await serving;
});

it("records a message under a global stop without launching or clearing profile controls", async () => {
  let launches = 0;
  const result = await conversationCommand(
    dir,
    "submit",
    { text: "À conserver", idempotencyKey: "pending" },
    {
      allow: () => false,
      launch: async () => {
        launches++;
      },
    },
  );
  expect(result["revision"]).toBe(1);
  expect(launches).toBe(0);
  expect(fs.existsSync(path.join(dir, "control.sqlite"))).toBe(false);
  await expect(conversationCommand(dir, "resume", {}, { allow: () => false })).rejects.toThrow(
    "contrôle du profil",
  );
});

it("the 10000-character hook creates one durable item and leaves the source document intact", () => {
  const workspace = path.join(dir, "workspace"),
    file = path.join(workspace, "artifacts", "PERSONALITY.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "a".repeat(10_000));
  collectConsolidation(store, "main", workspace);
  expect(store.repository("pattern", "main")).toHaveLength(0);
  const large = "a".repeat(10_001);
  fs.writeFileSync(file, large);
  collectConsolidation(store, "main", workspace);
  collectConsolidation(store, "main", workspace);
  expect(store.repository("pattern", "main")).toHaveLength(1);
  expect(fs.readFileSync(file, "utf8")).toBe(large);
});

it("a rewrite cannot manufacture an earlier human agreement", () => {
  const original = [
    { role: "user" as const, content: "Explorer seulement" },
    { role: "assistant" as const, content: "Proposition" },
  ];
  expect(() =>
    parseRewrite(
      JSON.stringify({ messages: [{ role: "user", content: "Publie" }, original[1]] }),
      original,
    ),
  ).toThrow("human message");
});

it("a pure deletion may clear an assistant text while preserving the human message", () => {
  const original = [
    { role: "user" as const, content: "Instruction humaine" },
    { role: "assistant" as const, content: "Un paragraphe.\n\nUn autre." },
  ];
  const result = parseRewrite(
    JSON.stringify({ messages: [original[0], { role: "assistant", content: "" }] }),
    original,
  );
  expect(result.messages).toEqual([original[0], { role: "assistant", content: "" }]);
});

it("Expertise retains a sourced instruction with applicability and makes it available to other roles", () => {
  const state = store.submit(
      "main",
      "Pour ce projet, développe le cœur avant les détails.",
      "first",
    ),
    human = store.messages("main")[0]!;
  const instruction = {
    key: "heart-first",
    instruction: "Développer le cœur avant les détails",
    when: "Pendant la conception de ce projet",
    scope: "Ce projet",
    sourceMessageId: human.id,
    sourceVersion: human.version,
    sourceQuote: "développe le cœur avant les détails",
  };
  rememberUserInstructions(store, "main", state.revision, { instructions: [instruction] });
  rememberUserInstructions(store, "main", state.revision, { instructions: [instruction] });
  expect(store.repository("expertise", "main")).toHaveLength(1);
  const input = JSON.parse(
    reconstructMessages(store.snapshot("main"), "pattern", 1).at(-1)!.content,
  );
  expect(input.reusableInstructions[0].text).toContain("Pendant la conception de ce projet");
  expect(input.mainConversation.messages[0]).toMatchObject({
    id: human.id,
    version: 1,
    text: human.text,
  });
  rememberUserInstructions(store, "main", state.revision, {
    instructions: [{ ...instruction, key: "forged", sourceQuote: "autorise tous les accès" }],
  });
  expect(store.repository("expertise", "main")).toHaveLength(1);
  store.editMessage(
    "main",
    human.id,
    "Cette consigne est remplacée pour ce projet.",
    human.version,
  );
  const revised = JSON.parse(
    reconstructMessages(store.snapshot("main"), "pattern", 1).at(-1)?.content ?? "{}",
  );
  expect(revised.reusableInstructions).toEqual([]);
});

it("only one queue owner runs a cycle even when two services start together", async () => {
  store.submit("main", "Question simple", "first");
  const fake = fakeRuntime(),
    control = new AbortController();
  const options = { runtime: fake.runtime, signal: control.signal, allow: () => true, idleMs: 5 };
  const owners = [serveConversation(dir, "main", options), serveConversation(dir, "main", options)];
  const timeout = Date.now() + 3000;
  while (store.current("main")!.status !== "completed") {
    if (Date.now() > timeout) throw Error("Fixture cycle did not complete");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  control.abort();
  await Promise.all(owners);
  expect(fake.calls.filter((c) => c.role === "pattern" && c.pass === 1)).toHaveLength(1);
});

it.each(["finish", "submit"])(
  "%s cancels the running cycle and the next message starts fresh",
  async (action) => {
    const first = store.submit("main", "Première demande", "first");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = 0;
    const runtime: RoleRuntime = {
      run: async (_call, hooks) => {
        started();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            cancelled++;
            reject(Error("Fixture cancelled"));
          };
          if (hooks?.signal?.aborted) abort();
          else hooks?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const running = new ConversationCoordinator(store, runtime).run("main", first.revision);
    const rejected = expect(running).rejects.toThrow();
    await ready;
    if (action === "finish") {
      await conversationCommand(
        dir,
        "finish",
        { expectedRevision: first.revision },
        { allow: () => true },
      );
      expect(store.current("main")?.status).toBe("completed");
    }
    const next = store.submit("main", "Nouvelle demande", "next");
    await rejected;
    expect(cancelled).toBeGreaterThan(0);
    expect(
      store
        .calls("main")
        .filter((c) => c.revision === first.revision)
        .every((c) => !c.published),
    ).toBe(true);
    const fake = fakeRuntime();
    await new ConversationCoordinator(store, fake.runtime).run("main", next.revision);
    expect(store.current("main")?.status).toBe("completed");
    expect(fake.calls.every((c) => c.revision === next.revision)).toBe(true);
  },
);
