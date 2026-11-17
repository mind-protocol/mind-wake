/**
 * telegram_post_channel `format` (mandat NLR du 16 nov. 2026, 17:40) : plain, html, markdown
 * (converti en HTML Telegram), repli en texte brut sur « can't parse entities ». API simulées :
 * rien n'est publié sur le vrai canal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { telegramBotFileSender, type TelegramSendFile } from "../services/mcp/media-tools.js";
import {
  TelegramChannel,
  registerTelegramTools,
  telegramBotSender,
  telegramHtmlToPlain,
  telegramMarkdownToHtml,
  type TelegramSend,
} from "../services/mcp/telegram-tools.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082", "hex");
const parseError = () =>
  Object.assign(new Error("Telegram sendMessage refusé : HTTP 400, code 400 : Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0"), {
    telegramCode: 400,
  });

let tmp: string;
let ws: string;
type Call = { chat: string; text: string; parseMode: string | undefined };
let texts: Call[];
let files: Call[];
let textReply: (c: Call) => Promise<{ message_id?: number }>;
let fileReply: (c: Call) => Promise<{ message_id?: number; method: "sendPhoto" | "sendDocument" }>;

const send: TelegramSend = (chat, text, o) => {
  const c = { chat, text, parseMode: o?.parseMode };
  texts.push(c);
  return textReply(c);
};
const sendFile: TelegramSendFile = (chat, _file, caption, o) => {
  const c = { chat, text: caption, parseMode: o?.parseMode };
  files.push(c);
  return fileReply(c);
};
const channel = () => new TelegramChannel(tmp, send, {}, sendFile, () => ws);
const journal = () => {
  const db = new Database(path.join(tmp, "telegram.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT key,status FROM channel_outgoing ORDER BY key").all();
  } finally {
    db.close();
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-channel-format-"));
  ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "affiche.png"), PNG);
  texts = [];
  files = [];
  textReply = () => Promise.resolve({ message_id: 8 });
  fileReply = () => Promise.resolve({ message_id: 7, method: "sendPhoto" });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("telegramMarkdownToHtml", () => {
  it("converts simple markdown to Telegram HTML and escapes the rest", () => {
    expect(telegramMarkdownToHtml("**gras** et *ital* et _aussi_ et __souligné__ ~~barré~~ ||secret||")).toBe(
      "<b>gras</b> et <i>ital</i> et <i>aussi</i> et <u>souligné</u> <s>barré</s> <tg-spoiler>secret</tg-spoiler>",
    );
    expect(telegramMarkdownToHtml("Voir [le site](https://mind.example/a?b=1&c=2) & 1 < 2")).toBe(
      'Voir <a href="https://mind.example/a?b=1&amp;c=2">le site</a> &amp; 1 &lt; 2',
    );
    expect(telegramMarkdownToHtml("`a<b>` puis\n```js\nif (a < b) **x**\n```")).toBe("<code>a&lt;b&gt;</code> puis\n<pre>if (a &lt; b) **x**</pre>");
    expect(telegramMarkdownToHtml("> ligne 1\n> ligne 2\nsuite")).toBe("<blockquote>ligne 1\nligne 2</blockquote>\nsuite");
    // Pas de lien hors http(s)/tg/mailto ; snake_case et 2 * 3 * 4 restent tels quels.
    expect(telegramMarkdownToHtml("[x](javascript:alert(1)) snake_case_name 2 * 3 * 4")).toBe("[x](javascript:alert(1)) snake_case_name 2 * 3 * 4");
  });

  it("telegramHtmlToPlain strips tags and decodes entities", () => {
    expect(telegramHtmlToPlain('<b>a</b> &lt;b&gt; &amp; <a href="https://x">lien</a>')).toBe("a <b> & lien");
  });
});

describe("telegram_post_channel format", () => {
  it("plain (default) sends without parse_mode, exactly as before", async () => {
    const r = await channel().post({ text: "<b>pas du HTML</b>", idempotency_key: "p1" });
    expect(texts).toEqual([{ chat: "@mindprotocol_ai", text: "<b>pas du HTML</b>", parseMode: undefined }]);
    expect(r.format).toBe("plain");
    expect(r.fallback_plain).toBeUndefined();
  });

  it("html sends the text as is with parse_mode HTML", async () => {
    const r = await channel().post({ text: '<b>Nouveau</b> : <a href="https://x.y">lien</a>', idempotency_key: "h1", format: "html" });
    expect(texts).toEqual([{ chat: "@mindprotocol_ai", text: '<b>Nouveau</b> : <a href="https://x.y">lien</a>', parseMode: "HTML" }]);
    expect(r).toMatchObject({ format: "html", message_id: 8 });
  });

  it("markdown is converted to HTML; the caption carries it too", async () => {
    await channel().post({ text: "**Sortie** du _clip_", idempotency_key: "m1", format: "markdown", image_path: "affiche.png" });
    expect(files).toEqual([{ chat: "@mindprotocol_ai", text: "<b>Sortie</b> du <i>clip</i>", parseMode: "HTML" }]);
    expect(texts).toEqual([]);
  });

  it("caption limit counts visible text; a long formatted text follows whole, never cut inside a tag", async () => {
    const visible900 = `<a href="https://x.y/${"q".repeat(300)}">${"x".repeat(900)}</a>`;
    expect(visible900.length).toBeGreaterThan(1024);
    await channel().post({ text: visible900, idempotency_key: "l1", format: "html", image_path: "affiche.png" });
    // 900 caractères visibles : légende formatée, malgré plus de 1024 caractères bruts.
    expect(files[0]?.parseMode).toBe("HTML");
    expect(texts).toEqual([]);
    const long = `<b>${"y".repeat(1100)}</b> <a href="https://x.y">lien</a>`;
    await channel().post({ text: long, idempotency_key: "l2", format: "html", image_path: "affiche.png" });
    expect(files[1]).toEqual({ chat: "@mindprotocol_ai", text: "", parseMode: undefined });
    expect(texts).toEqual([{ chat: "@mindprotocol_ai", text: long, parseMode: "HTML" }]);
  });

  it("on can't parse entities, retries once as plain text with tags removed and says so", async () => {
    textReply = (c) => (c.parseMode === "HTML" ? Promise.reject(parseError()) : Promise.resolve({ message_id: 9 }));
    const r = await channel().post({ text: "<b>gras</b> &amp; <x>", idempotency_key: "f1", format: "html" });
    expect(texts.map((t) => [t.text, t.parseMode])).toEqual([
      ["<b>gras</b> &amp; <x>", "HTML"],
      ["gras & ", undefined],
    ]);
    expect(r).toMatchObject({ message_id: 9, fallback_plain: true });
    expect(r.note).toContain("plain text");
    expect(journal()).toEqual([{ key: "f1", status: "sent" }]);
  });

  it("caption fallback: the file is resent once with a plain caption", async () => {
    fileReply = (c) => (c.parseMode === "HTML" ? Promise.reject(parseError()) : Promise.resolve({ message_id: 7, method: "sendPhoto" }));
    const r = await channel().post({ text: "**ok** <oups", idempotency_key: "f2", format: "markdown", image_path: "affiche.png" });
    expect(files.map((f) => [f.text, f.parseMode])).toEqual([
      ["<b>ok</b> &lt;oups", "HTML"],
      ["ok <oups", undefined],
    ]);
    expect(r.fallback_plain).toBe(true);
  });

  it("long-text fallback after the image keeps the image sent once", async () => {
    textReply = (c) => (c.parseMode === "HTML" ? Promise.reject(parseError()) : Promise.resolve({ message_id: 9 }));
    const r = await channel().post({ text: `<b>${"z".repeat(1100)}</b>`, idempotency_key: "f3", format: "html", image_path: "affiche.png" });
    expect(files).toHaveLength(1);
    expect(texts.map((t) => t.parseMode)).toEqual(["HTML", undefined]);
    expect(r).toMatchObject({ message_id: 7, fallback_plain: true });
  });

  it("only one retry: a second refusal is returned and the key is freed (nothing published)", async () => {
    textReply = () => Promise.reject(parseError());
    await expect(channel().post({ text: "<b>x</b>", idempotency_key: "f4", format: "html" })).rejects.toThrow("can't parse entities");
    expect(texts).toHaveLength(2);
    expect(journal()).toEqual([]);
  });

  it("other Telegram errors are not retried as plain", async () => {
    textReply = () => Promise.reject(Object.assign(new Error("Bad Request: chat not found"), { telegramCode: 400 }));
    await expect(channel().post({ text: "<b>x</b>", idempotency_key: "f5", format: "html" })).rejects.toThrow("chat not found");
    expect(texts).toHaveLength(1);
  });

  it("a reused key never republishes, whatever the format", async () => {
    await channel().post({ text: "a", idempotency_key: "k", format: "html" });
    await expect(channel().post({ text: "a", idempotency_key: "k", format: "markdown" })).rejects.toMatchObject({ code: "duplicate_key" });
    expect(texts).toHaveLength(1);
  });

  it("the MCP schema accepts format and rejects unknown values", async () => {
    const server = new McpServer({ name: "telegram-test", version: "1" });
    registerTelegramTools(server, { MIND_WAKE_DATA_DIR: tmp }, send, sendFile);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "telegram_post_channel");
      expect(tool?.description).toMatch(/tg-spoiler/);
      expect(JSON.stringify(tool?.inputSchema)).toContain('"enum":["plain","html","markdown"]');
      const ok = (await client.callTool({ name: "telegram_post_channel", arguments: { text: "**a**", idempotency_key: "s1", format: "markdown" } })) as { isError?: boolean };
      expect(ok.isError).not.toBe(true);
      expect(texts.at(-1)).toEqual({ chat: "@mindprotocol_ai", text: "<b>a</b>", parseMode: "HTML" });
      const bad = (await client.callTool({ name: "telegram_post_channel", arguments: { text: "a", idempotency_key: "s2", format: "MarkdownV2" } })) as { isError?: boolean };
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("real senders (fake HTTP)", () => {
  beforeEach(() => fs.writeFileSync(path.join(tmp, "telegram.json"), JSON.stringify({ enabled: true, botToken: "123:fake_token" })));

  it("sendMessage carries parse_mode only when asked", async () => {
    const bodies: Record<string, unknown>[] = [];
    const http = ((_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    }) as unknown as typeof fetch;
    const s = telegramBotSender(tmp, http);
    await s("@c", "a");
    await s("@c", "<b>a</b>", { parseMode: "HTML" });
    expect(bodies).toEqual([
      { chat_id: "@c", text: "a" },
      { chat_id: "@c", text: "<b>a</b>", parse_mode: "HTML" },
    ]);
  });

  it("sendPhoto carries parse_mode; a parse error is not retried as document", async () => {
    const seen: { url: string; parse: unknown; caption: unknown }[] = [];
    let fail = false;
    const http = ((url: string, init: { body: FormData }) => {
      seen.push({ url: url.replace(/.*\//, ""), parse: init.body.get("parse_mode"), caption: init.body.get("caption") });
      return Promise.resolve(
        fail
          ? new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: x" }), { status: 400 })
          : new Response(JSON.stringify({ ok: true, result: { message_id: 3 } })),
      );
    }) as unknown as typeof fetch;
    const s = telegramBotFileSender(tmp, http);
    const file = { absolutePath: path.join(ws, "affiche.png"), name: "affiche.png", size: PNG.length };
    await s("@c", file, "<b>a</b>", { parseMode: "HTML" });
    fail = true;
    await expect(s("@c", file, "<b>a</b>", { parseMode: "HTML" })).rejects.toThrow("can't parse entities");
    expect(seen).toEqual([
      { url: "sendPhoto", parse: "HTML", caption: "<b>a</b>" },
      { url: "sendPhoto", parse: "HTML", caption: "<b>a</b>" },
    ]);
  });
});
