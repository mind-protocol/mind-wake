/**
 * `messages` et `reply` : fil humain ↔ agent sur un profil SQLite réel. Registre hors de
 * l'espace d'exploration, recopie balisée dans la note de l'agent, idempotence, refus.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_NOTE_FILE, agentText, HUMAN_LOG_FILE } from "./commands/messages.js";
import { processContext, type CliContext } from "./context.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./output.js";
import { runCli } from "./run.js";
import { ownerMessagePending, enqueueOwnerMessage } from "../communication/owner-inbox.js";
import { ownerInboxHook } from "../communication/owner-inbox-hook.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-messages-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function cli(
  args: string[],
  input = "",
): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const ctx: CliContext = {
    ...processContext(),
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    readStdin: () => Promise.resolve(input),
  };
  const code = await runCli([...args, "--json", "--data-dir", dir], ctx);
  return { code, json: JSON.parse(out.join("")) as Record<string, unknown> };
}

function data(json: Record<string, unknown>): Record<string, unknown> {
  return json["data"] as Record<string, unknown>;
}

const note = (): string => path.join(dir, "workspace", "artifacts", AGENT_NOTE_FILE);

describe("fil humain ↔ agent", () => {
  it("does not reclassify humans outside the 200 visible replies as unattributed inbox senders", async () => {
    await cli(["init"]);
    const rows=Array.from({length:205},(_,i)=>({id:`human-${i}`,at:new Date(Date.UTC(2026,9,30,10,0,i)).toISOString(),text:`human ${i}`,noteMtimeBeforeMs:null}));
    fs.writeFileSync(path.join(dir,HUMAN_LOG_FILE),rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
    enqueueOwnerMessage(dir,rows[0]!);
    enqueueOwnerMessage(dir,rows[204]!);
    const result=data((await cli(["messages"])).json);
    expect(result["replies"]).toHaveLength(200);
    expect(result["receivedMessages"]).toEqual([]);
  });
  it("exposes a desktop receipt only after the hook has emitted that exact message", async () => {
    await cli(["init"]);
    await cli(["reply","--idempotency-key","desktop-receipt-01"],"Bonjour");
    expect(data((await cli(["messages"])).json)["deliveryReceipts"]).toEqual({});
    const receipt=ownerInboxHook(dir,"desktop-session",{session_id:"desktop-session",hook_event_name:"PostToolUse"});
    expect(receipt).not.toBeNull();
    const after=data((await cli(["messages"])).json)["deliveryReceipts"] as Record<string,string>;
    expect(Object.keys(after)).toEqual(["desktop-receipt-01"]);
    expect(Number.isFinite(Date.parse(after["desktop-receipt-01"]!))).toBe(true);
  });
  it("sans profil : refus explicite", async () => {
    expect((await cli(["messages"])).code).toBe(EXIT_FAILURE);
    expect((await cli(["reply"], "bonjour")).code).toBe(EXIT_FAILURE);
  });

  it("lit la note de l'agent, enregistre la réponse puis la recopie balisée", async () => {
    await cli(["init"]);
    fs.mkdirSync(path.dirname(note()), { recursive: true });
    fs.writeFileSync(note(), "# Questions\n\n1. Sur quoi travailler ?\n");

    const first = await cli(["messages"]);
    expect(data(first.json)["agentNote"]).toMatchObject({
      file: `artifacts/${AGENT_NOTE_FILE}`,
      trust: "untrusted_agent_content",
      text: "# Questions\n\n1. Sur quoi travailler ?",
    });

    const sent = await cli(
      ["reply", "--idempotency-key", "ui-0001-abcd"],
      "Les petits systèmes émergents.\r\n",
    );
    expect(sent.code).toBe(EXIT_OK);
    expect(data(sent.json)).toMatchObject({ status: "recorded", mirrored: true });
    expect(ownerMessagePending(dir)).toBe(true);

    // Registre hors de l'espace d'exploration, recopie dans la note.
    expect(fs.readFileSync(path.join(dir, HUMAN_LOG_FILE), "utf8")).toContain(
      "Les petits systèmes émergents.",
    );
    expect(fs.readFileSync(note(), "utf8")).toContain("## Réponse de ton humain");

    const after = await cli(["messages"]);
    expect((data(after.json)["agentNote"] as { text: string }).text).toBe(
      "# Questions\n\n1. Sur quoi travailler ?",
    );
    expect(data(after.json)["replies"]).toEqual([
      expect.objectContaining({ id: "ui-0001-abcd", text: "Les petits systèmes émergents." }),
    ]);
  });

  it("la recopie ne compte pas comme une écriture de l'agent ; une vraie écriture si", async () => {
    await cli(["init"]);
    fs.mkdirSync(path.dirname(note()), { recursive: true });
    fs.writeFileSync(note(), "Question ?\n");
    const agentAt = new Date("2026-10-29T10:00:00Z");
    fs.utimesSync(note(), agentAt, agentAt);
    await cli(["reply"], "Réponse.");
    await new Promise((r) => setTimeout(r, 5));
    await cli(["reply"], "Deuxième réponse d'affilée.");
    const seen = data((await cli(["messages"])).json)["agentNote"] as { updatedAt: string };
    expect(seen.updatedAt).toBe(agentAt.toISOString());

    const later = new Date("2099-01-01T00:00:00Z");
    fs.appendFileSync(note(), "Nouvelle question ?\n");
    fs.utimesSync(note(), later, later);
    const fresh = data((await cli(["messages"])).json)["agentNote"] as { updatedAt: string };
    expect(fresh.updatedAt).toBe(later.toISOString());
  });

  it("idempotence : même clé et même texte → doublon ; autre texte → refus", async () => {
    await cli(["init"]);
    const args = ["reply", "--idempotency-key", "ui-0002-abcd"];
    await cli(args, "Oui.");
    expect(data((await cli(args, "Oui.")).json)["status"]).toBe("duplicate");
    expect((await cli(args, "Non.")).code).toBe(EXIT_FAILURE);
    expect(fs.readFileSync(path.join(dir, HUMAN_LOG_FILE), "utf8").trim().split("\n")).toHaveLength(
      1,
    );
    expect(fs.readFileSync(note(), "utf8").match(/Réponse de ton humain/g)).toHaveLength(1);
  });

  it("refus d'usage : texte vide, trop long, clé invalide, option hors de reply", async () => {
    await cli(["init"]);
    expect((await cli(["reply"], "   ")).code).toBe(EXIT_USAGE);
    expect((await cli(["reply"], "x".repeat(4001))).code).toBe(EXIT_USAGE);
    expect((await cli(["reply", "--idempotency-key", "court"], "ok")).code).toBe(EXIT_USAGE);
    expect((await cli(["messages", "--idempotency-key", "ui-0003-abcd"])).code).toBe(EXIT_USAGE);
  });

  it("un dossier à la place de la note n'est ni lu ni écrit ; le registre fait foi", async () => {
    await cli(["init"]);
    fs.mkdirSync(note(), { recursive: true });
    expect(data((await cli(["messages"])).json)["agentNote"]).toBeNull();
    const sent = await cli(["reply"], "Message conservé.");
    expect(data(sent.json)).toMatchObject({ status: "recorded", mirrored: false });
    expect(data((await cli(["messages"])).json)["replies"]).toHaveLength(1);
  });

  it("agentText retire les blocs recopiés, y compris un bloc non fermé", () => {
    const text =
      "A\n<!-- mind-wake:reponse-humain id=x -->\nR\n<!-- /mind-wake:reponse-humain -->\nB\n<!-- mind-wake:reponse-humain id=y -->\ncoupé";
    expect(agentText(text)).toBe("A\n\nB");
  });
});

describe("messages --limit (fenêtre du desktop)", () => {
  it("garde les N éléments les plus récents, signale l'omission et ne garde que leurs accusés", async () => {
    await cli(["init"]);
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `human-limit-${String(i).padStart(2, "0")}`, at: new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString(), text: `h${i}`, noteMtimeBeforeMs: null }));
    fs.writeFileSync(path.join(dir, HUMAN_LOG_FILE), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const full = data((await cli(["messages"])).json);
    expect(full["replies"]).toHaveLength(30);
    expect(full["truncated"]).toBeUndefined();
    const limited = await cli(["messages", "--limit", "5"]);
    expect(limited.code).toBe(EXIT_OK);
    const result = data(limited.json);
    expect((result["replies"] as { id: string }[]).map((r) => r.id)).toEqual(rows.slice(-5).map((r) => r.id));
    expect(result["truncated"]).toBe(true);
    const all = data((await cli(["messages", "--limit", "50"])).json);
    expect(all["replies"]).toHaveLength(30);
    expect(all["truncated"]).toBe(false);
  });

  it("filtre les accusés de livraison sur les réponses gardées", async () => {
    const { latestMessages } = await import("./commands/messages.js");
    const base = { profileId: "default", hint: null, agentNote: null,
      replies: [{ id: "a", at: "2026-11-01T10:00:00.000Z", text: "a" }, { id: "b", at: "2026-11-01T11:00:00.000Z", text: "b" }],
      agentMessages: [{ id: "m1", text: "x", createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T12:00:00.000Z", version: 2 },
        { id: "m0", text: "y", createdAt: "2026-11-01T08:00:00.000Z", updatedAt: "2026-11-01T08:00:00.000Z", version: 1 }],
      deliveryReceipts: { a: "2026-11-01T10:00:01.000Z", b: "2026-11-01T11:00:01.000Z" } };
    const out = latestMessages(base, 2);
    expect(out.replies.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out.deliveryReceipts).toEqual(base.deliveryReceipts);
    // Message ancien mais modifié récemment : gardé pour que « nouveau » reste juste.
    expect(out.agentMessages?.map((m) => m.id)).toEqual(["m1"]);
    const one = latestMessages(base, 1);
    expect(one.replies.map((r) => r.id)).toEqual(["b"]);
    expect(one.deliveryReceipts).toEqual({ b: "2026-11-01T11:00:01.000Z" });
    expect(one.truncated).toBe(true);
  });

  it("refuse une limite invalide et --limit sur une autre commande", async () => {
    await cli(["init"]);
    expect((await cli(["messages", "--limit", "0"])).code).toBe(EXIT_USAGE);
    expect((await cli(["messages", "--limit", "abc"])).code).toBe(EXIT_USAGE);
    expect((await cli(["status", "--limit", "5"])).code).toBe(EXIT_USAGE);
  });
});

describe("sessionLaunching", () => {
  it("is true between budget_reserved and session_started, false afterwards or on a missing table", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { sessionLaunching } = await import("./commands/messages.js");
    const db = new Database(":memory:");
    expect(sessionLaunching(db, "default", "s1")).toBe(false);
    db.exec("CREATE TABLE journal_events (profile_id TEXT, sequence INTEGER, type TEXT, session_id TEXT, PRIMARY KEY (profile_id, sequence))");
    const add = db.prepare("INSERT INTO journal_events VALUES ('default', ?, ?, ?)");
    add.run(1, "session_started", "s0");
    add.run(2, "budget_reserved", "s1");
    add.run(3, "profile_state_changed", "s1");
    expect(sessionLaunching(db, "default", "s1")).toBe(true);
    add.run(4, "session_started", "s1");
    expect(sessionLaunching(db, "default", "s1")).toBe(false);
    expect(sessionLaunching(db, "default", "unknown")).toBe(false);
    db.close();
  });
});
