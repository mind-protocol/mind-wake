/** Contacts Telegram : inbox du principal, réveil du coach, outils MCP. Faux envoi, aucun appel réel. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { callClaude as CallClaude } from "../src/communication/fast-reply.js";
import { readOwnerInboxHistory, ownerMessagePending } from "../src/communication/owner-inbox.js";
import { readFil, tickPatternHolders } from "../src/communication/pattern-holders.js";
import {
  enqueueTelegramContactMessage,
  telegramCoachFor,
  type TelegramContactMessage,
} from "../src/communication/telegram-contacts.js";
import {
  CONTACT_SCHEMA,
  registerTelegramTools,
  telegramBotSender,
  telegramChannelFor,
  type TelegramSend,
} from "../services/mcp/telegram-tools.js";

let dataDir: string;
let clock: number;
const holdersDir = () => path.join(dataDir, "workspace", "artifacts", "pattern-holders");
const REGISTRY = {
  version: 1,
  coachs: {
    "coach-colony": { nom: "Coach Colony" },
    "coach-telegram": { nom: "Coach Telegram", prive: true },
  },
  personnes: [
    {
      id: "spark-the-cat",
      coach: "coach-colony",
      handles: [{ plateforme: "colony", handle: "bigbosefx2" }],
    },
    {
      id: "bigbosefx2",
      coach: "coach-telegram",
      prive: true,
      handles: [{ plateforme: "telegram", handle: "@BigBoseFX2" }],
    },
    {
      id: "leo",
      coach: "coach-telegram",
      prive: true,
      handles: [{ plateforme: "telegram", handle: "4242" }],
    },
  ],
};
const holderSection = (name: string) =>
  `# ${name}\n\n\`\`\`json pattern-holder\n{ "name": "${name}", "emoji": "🧭" }\n\`\`\`\n`;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-contacts-"));
  for (const slug of ["coach-colony", "coach-telegram"]) {
    const dir = path.join(holdersDir(), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "_holder.md"), holderSection(slug));
  }
  fs.writeFileSync(path.join(holdersDir(), "COACHS-REGISTRE.json"), JSON.stringify(REGISTRY));
  clock = Date.parse("2026-11-16T11:30:00.000Z");
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const contact = (over: Partial<TelegramContactMessage> = {}): TelegramContactMessage => ({
  chatId: 555,
  userId: 555,
  username: "bigbosefx2",
  firstName: "Big",
  messageId: 9,
  at: new Date(clock - 30_000).toISOString(),
  text: "Salut, tu as vu @spark-the-cat ?",
  ...over,
});

const holderCall =
  (seen: string[]): typeof CallClaude =>
  (_claude, _args, prompt, cwd) => {
    if (prompt.includes('"candidats"')) return Promise.resolve({ text: "[]" });
    seen.push(path.basename(cwd));
    return Promise.resolve({ text: "SILENCE" });
  };
const claude = { executable: "unused", model: "sonnet" };

describe("injection dans l'inbox du principal", () => {
  it("matches the registry by telegram handle (any case) or user id, never another platform", () => {
    expect(telegramCoachFor(holdersDir(), { username: "BIGBOSEFX2", userId: 1 })).toEqual({
      person: "bigbosefx2",
      coach: "coach-telegram",
      private: true,
    });
    expect(telegramCoachFor(holdersDir(), { username: null, userId: 4242 })?.person).toBe("leo");
    expect(telegramCoachFor(holdersDir(), { username: "inconnu", userId: 1 })).toBeNull();
    expect(
      telegramCoachFor(path.join(dataDir, "absent"), { username: "bigbosefx2", userId: 1 }),
    ).toBeNull();
  });

  it("names the coach without @ when the registry matches, with telegram origin and a wake-eligible id", () => {
    const r = enqueueTelegramContactMessage(dataDir, contact());
    expect(r).toEqual({ id: "telegram-contact:555:9", coach: "coach-telegram", duplicate: false });
    const [m] = readOwnerInboxHistory(dataDir);
    expect(m?.origin).toMatchObject({
      kind: "peer_message",
      channel: "telegram",
      author: "Telegram · @bigbosefx2",
      senderRef: "telegram:user/555",
    });
    expect(m?.text).toContain("\n\ncoach : coach-telegram (personne : bigbosefx2).");
    expect(m?.text).toContain("Coach privé");
    // Aucune mention : c'est le principal qui transmet au coach.
    expect(m?.text).not.toContain("@coach-telegram");
    expect(m?.text).not.toContain("@");
    // Les @ du contact sont inertes : il ne réveille personne lui-même.
    expect(m?.text).toContain("＠spark-the-cat");
    expect(m?.text).not.toContain("@spark-the-cat");
    expect(m?.text).not.toContain("@bigbosefx2");
    expect(ownerMessagePending(dataDir, true)).toBe(true);
    // Idempotent par chat et message.
    expect(enqueueTelegramContactMessage(dataDir, contact()).duplicate).toBe(true);
    expect(readOwnerInboxHistory(dataDir)).toHaveLength(1);
  });

  it("has no mention without a registry match, and the principal is still told", () => {
    const r = enqueueTelegramContactMessage(
      dataDir,
      contact({ username: null, firstName: "Anne", userId: 77, chatId: 77 }),
    );
    expect(r.coach).toBeNull();
    const [m] = readOwnerInboxHistory(dataDir);
    expect(m?.origin?.author).toBe("Telegram · Anne");
    expect(m?.text).not.toMatch(/(^|\s)@/);
    expect(ownerMessagePending(dataDir, true)).toBe(true);
  });

  it("keeps a contact message out of the holders' fil and wakes no holder, even its coach", async () => {
    const seen: string[] = [];
    await tickPatternHolders({ dataDir, claude, call: holderCall(seen), now: () => clock });
    const r = enqueueTelegramContactMessage(dataDir, contact());
    expect(r.coach).toBe("coach-telegram");
    expect(readOwnerInboxHistory(dataDir).map((m) => m.id)).toEqual(["telegram-contact:555:9"]);
    expect(readFil(dataDir).map((m) => m.id)).not.toContain("telegram-contact:555:9");
    expect(readFil(dataDir).some((m) => m.text.includes("bigbosefx2"))).toBe(false);
    const outcomes = await tickPatternHolders({
      dataDir,
      claude,
      call: holderCall(seen),
      now: () => clock,
    });
    expect(outcomes).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("wakes no coach for an unmatched contact", async () => {
    const seen: string[] = [];
    await tickPatternHolders({ dataDir, claude, call: holderCall(seen), now: () => clock });
    enqueueTelegramContactMessage(dataDir, contact({ username: "autre", userId: 88, chatId: 88 }));
    const outcomes = await tickPatternHolders({
      dataDir,
      claude,
      call: holderCall(seen),
      now: () => clock,
    });
    expect(outcomes.filter((o) => o.reason === "mention" || o.reason === "handle")).toEqual([]);
    expect(seen.filter((s) => s === "coach-telegram")).toEqual([]);
  });
});

describe("outils MCP telegram_list_contacts / telegram_send_contact", () => {
  /** Comme le bridge : contact gardé quand il écrit, propriétaire épinglé dans `state`. */
  function store(rows: { chat: string; user: string; username: string | null; wrote: boolean }[]) {
    const db = new Database(path.join(dataDir, "telegram.sqlite"));
    db.exec(CONTACT_SCHEMA);
    db.prepare("INSERT INTO state VALUES('user','1864364329'),('chat','1864364329')").run();
    for (const r of rows) {
      db.prepare(
        "INSERT INTO contacts(chat_id,user_id,username,first_name,last_seen) VALUES(?,?,?,?,?)",
      ).run(r.chat, r.user, r.username, "Big", "2026-11-16T11:00:00.000Z");
      if (r.wrote)
        db.prepare("INSERT INTO contact_incoming(id,chat_id,text,at) VALUES(?,?,?,?)").run(
          `tg-contact-${r.chat}-1`,
          r.chat,
          "/start",
          "2026-11-16T11:00:00.000Z",
        );
    }
    db.close();
    // Faux fichier de test : seulement le nom du propriétaire, aucun jeton.
    fs.writeFileSync(path.join(dataDir, "telegram.json"), JSON.stringify({ ownerUsername: "@nlr_ai" }));
  }
  async function harness() {
    const sends: { chat: string; text: string }[] = [];
    const send: TelegramSend = (chat, text) => {
      sends.push({ chat, text });
      return Promise.resolve({ message_id: 100 + sends.length });
    };
    const server = new McpServer({ name: "telegram-test", version: "1" });
    registerTelegramTools(server, { MIND_WAKE_DATA_DIR: dataDir }, send);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return {
        isError: r.isError === true,
        body: JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>,
      };
    };
    return { sends, call, close: () => client.close() };
  }

  it("bridge and tool share the same contact tables", () => {
    const bridge = fs.readFileSync(
      path.join(import.meta.dirname, "../services/telegram/bridge.mjs"),
      "utf8",
    );
    const tables = CONTACT_SCHEMA.split(";")
      .map((s) => s.trim())
      .filter((s) => s.includes("contact"));
    expect(tables).toHaveLength(3);
    for (const table of tables) expect(bridge).toContain(table);
  });

  it("lists known contacts with can_send, never the owner", async () => {
    store([
      { chat: "555", user: "555", username: "Bigbosefx2", wrote: true },
      { chat: "1864364329", user: "1864364329", username: "nlr_ai", wrote: true },
    ]);
    const h = await harness();
    try {
      const r = await h.call("telegram_list_contacts", {});
      expect(r.isError).toBe(false);
      expect(r.body["data"]).toEqual({
        contacts: [
          {
            chat_id: "555",
            user_id: "555",
            username: "Bigbosefx2",
            first_name: "Big",
            last_message_at: "2026-11-16T11:00:00.000Z",
            can_send: true,
          },
        ],
      });
    } finally {
      await h.close();
    }
  });

  it("refuses a contact who never started the bot, an unknown one, and the owner", async () => {
    store([{ chat: "600", user: "600", username: "silent", wrote: false }]);
    const h = await harness();
    try {
      for (const to of ["@silent", "600", "@inconnu"]) {
        const r = await h.call("telegram_send_contact", {
          to,
          text: "Bonjour",
          idempotency_key: `k-${to}`,
        });
        expect(r.isError).toBe(true);
        expect(r.body["error"]).toBe("not_started");
        expect(r.body["message"]).toContain("ce contact n'a pas lancé le bot (/start)");
      }
      for (const to of ["@nlr_ai", "@NLR_AI", "1864364329"]) {
        const r = await h.call("telegram_send_contact", {
          to,
          text: "Bonjour",
          idempotency_key: `o-${to}`,
        });
        expect(r.isError).toBe(true);
        expect(r.body["error"]).toBe("owner");
      }
      expect(h.sends).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("sends the text as is to a contact who wrote, logs it, and refuses a reused key", async () => {
    store([{ chat: "555", user: "555", username: "Bigbosefx2", wrote: true }]);
    const h = await harness();
    try {
      const text = "Bonjour, ici NLR. Merci pour ton message.";
      const ok = await h.call("telegram_send_contact", {
        to: "@bigbosefx2",
        text,
        idempotency_key: "first",
      });
      expect(ok.isError).toBe(false);
      expect(ok.body["data"]).toEqual({
        chat_id: "555",
        username: "Bigbosefx2",
        message_id: 101,
        idempotency_key: "first",
      });
      expect(h.sends).toEqual([{ chat: "555", text }]);
      const again = await h.call("telegram_send_contact", {
        to: "555",
        text: "autre",
        idempotency_key: "first",
      });
      expect(again.isError).toBe(true);
      expect(again.body["error"]).toBe("duplicate_key");
      expect(h.sends).toHaveLength(1);
      const next = await h.call("telegram_send_contact", {
        to: "555",
        text: "suite",
        idempotency_key: "second",
      });
      expect(next.isError).toBe(false);
      expect(h.sends).toHaveLength(2);
      const db = new Database(path.join(dataDir, "telegram.sqlite"), { readonly: true });
      try {
        expect(
          db
            .prepare("SELECT key,chat_id,text,status,message_id FROM contact_outgoing ORDER BY key")
            .all(),
        ).toEqual([
          { key: "first", chat_id: "555", text, status: "sent", message_id: "101" },
          { key: "second", chat_id: "555", text: "suite", status: "sent", message_id: "102" },
        ]);
      } finally {
        db.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe("outil telegram_post_channel", () => {
  /** Faux API Telegram : rien ne sort du poste. */
  function fakeApi(reply: (body: { chat_id: string; text: string }) => { status: number; json: unknown }) {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const http = ((url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { chat_id: string; text: string };
      requests.push({ url, body });
      const r = reply(body);
      return Promise.resolve(new Response(JSON.stringify(r.json), { status: r.status }));
    }) as unknown as typeof fetch;
    return { http, requests };
  }
  async function harness(send: TelegramSend, env: Record<string, string> = {}) {
    // Faux fichier de test, jeton factice : le vrai telegram.json n'est jamais lu.
    fs.writeFileSync(
      path.join(dataDir, "telegram.json"),
      JSON.stringify({ enabled: true, botToken: "123:fake_token" }),
    );
    const server = new McpServer({ name: "telegram-test", version: "1" });
    registerTelegramTools(server, { MIND_WAKE_DATA_DIR: dataDir, ...env }, send);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const post = async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: "telegram_post_channel", arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return {
        isError: r.isError === true,
        body: (r.content[0]?.text ?? "{}").startsWith("{") ? (JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>) : { raw: r.content[0]?.text },
      };
    };
    return { post, close: () => client.close() };
  }
  const journal = () => {
    const db = new Database(path.join(dataDir, "telegram.sqlite"), { readonly: true });
    try {
      return db.prepare("SELECT key,channel,text,status,message_id FROM channel_outgoing ORDER BY key").all();
    } finally {
      db.close();
    }
  };

  it("publishes the text as is on @mindprotocol_ai, logs it, and refuses a reused key", async () => {
    const api = fakeApi(() => ({ status: 200, json: { ok: true, result: { message_id: 31 } } }));
    const h = await harness(telegramBotSender(dataDir, api.http));
    try {
      const text = "MIND : *nouvelle* note <b>publique</b> — @tous";
      const ok = await h.post({ text, idempotency_key: "annonce-1" });
      expect(ok.isError).toBe(false);
      expect(ok.body["data"]).toEqual({
        channel: "@mindprotocol_ai",
        message_id: 31,
        idempotency_key: "annonce-1",
        format: "plain",
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toBe("https://api.telegram.org/bot123:fake_token/sendMessage");
      // Tel quel : ni parse_mode ni signature.
      expect(api.requests[0]?.body).toEqual({ chat_id: "@mindprotocol_ai", text });
      const again = await h.post({ text: "autre", idempotency_key: "annonce-1" });
      expect(again.isError).toBe(true);
      expect(again.body["error"]).toBe("duplicate_key");
      expect(api.requests).toHaveLength(1);
      expect(journal()).toEqual([
        { key: "annonce-1", channel: "@mindprotocol_ai", text, status: "sent", message_id: "31" },
      ]);
    } finally {
      await h.close();
    }
  });

  it("returns Telegram's refusal as is and gives the key back", async () => {
    let refuse = true;
    const api = fakeApi(() =>
      refuse
        ? {
            status: 403,
            json: { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the channel chat" },
          }
        : { status: 200, json: { ok: true, result: { message_id: 7 } } },
    );
    const h = await harness(telegramBotSender(dataDir, api.http));
    try {
      const r = await h.post({ text: "Bonjour", idempotency_key: "k" });
      expect(r.isError).toBe(true);
      expect(r.body["error"]).toBe("telegram_refused");
      expect(r.body["message"]).toContain("Forbidden: bot is not a member of the channel chat");
      expect(r.body["message"]).not.toContain("fake_token");
      expect(journal()).toEqual([]);
      // Refus net : la clé est rendue, la même clé publie une fois le bot admis.
      refuse = false;
      const ok = await h.post({ text: "Bonjour", idempotency_key: "k" });
      expect(ok.isError).toBe(false);
      expect(api.requests).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it("keeps the key as uncertain when the outcome is unknown", async () => {
    const send: TelegramSend = () => Promise.reject(new Error("socket hang up"));
    const h = await harness(send);
    try {
      const r = await h.post({ text: "Bonjour", idempotency_key: "net" });
      expect(r.isError).toBe(true);
      expect(journal()).toEqual([
        { key: "net", channel: "@mindprotocol_ai", text: "Bonjour", status: "uncertain", message_id: null },
      ]);
      const again = await h.post({ text: "Bonjour", idempotency_key: "net" });
      expect(again.body["error"]).toBe("duplicate_key");
    } finally {
      await h.close();
    }
  });

  it("uses the channel from the variable, then telegram.json, then the default; refuses an invalid one", async () => {
    expect(telegramChannelFor(dataDir)).toBe("@mindprotocol_ai");
    fs.writeFileSync(path.join(dataDir, "telegram.json"), JSON.stringify({ channel: "@autre_canal" }));
    expect(telegramChannelFor(dataDir)).toBe("@autre_canal");
    expect(telegramChannelFor(dataDir, { MIND_WAKE_TELEGRAM_CHANNEL: "-1001234567890" })).toBe("-1001234567890");
    expect(() => telegramChannelFor(dataDir, { MIND_WAKE_TELEGRAM_CHANNEL: "pas un canal" })).toThrow(
      "Canal Telegram invalide",
    );
    const sends: string[] = [];
    const h = await harness((chat) => {
      sends.push(chat);
      return Promise.resolve({ message_id: 1 });
    }, { MIND_WAKE_TELEGRAM_CHANNEL: "@essai_canal" });
    try {
      const r = await h.post({ text: "x", idempotency_key: "c" });
      expect(r.body["data"]).toMatchObject({ channel: "@essai_canal" });
      expect(sends).toEqual(["@essai_canal"]);
      const tooLong = await h.post({ text: "a".repeat(4001), idempotency_key: "long" });
      expect(tooLong.isError).toBe(true);
      expect(sends).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("is registered for the principal only, never in the room server", () => {
    const main = fs.readFileSync(path.join(import.meta.dirname, "../services/mcp/server-main.ts"), "utf8");
    const room = fs.readFileSync(path.join(import.meta.dirname, "../services/mcp/fork-owner-main.ts"), "utf8");
    expect(main).toContain("registerTelegramTools(");
    expect(room).not.toMatch(/telegram-tools|registerTelegramTools|telegram_post_channel/);
  });
});
