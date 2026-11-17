/**
 * telegram_post_channel avec image_path (mandat NLR du 16 nov. 2026, 17:35) : mêmes règles que
 * telegram_send_owner. API Telegram simulée : rien n'est publié sur le vrai canal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { TelegramSendFile } from "../services/mcp/media-tools.js";
import { TelegramChannel, registerTelegramTools, type TelegramSend } from "../services/mcp/telegram-tools.js";
import { workspaceDirFor } from "../src/daemon/paths.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082", "hex");

let tmp: string;
let ws: string;
let texts: { chat: string; text: string }[];
let files: { chat: string; name: string; caption: string }[];
let fileReply: () => Promise<{ message_id?: number; method: "sendPhoto" | "sendDocument" }>;
let textReply: () => Promise<{ message_id?: number }>;

const send: TelegramSend = (chat, text) => (texts.push({ chat, text }), textReply());
const sendFile: TelegramSendFile = (chat, file, caption) => (files.push({ chat, name: file.name, caption }), fileReply());
const channel = () => new TelegramChannel(tmp, send, {}, sendFile, () => ws);
const journal = () => {
  const db = new Database(path.join(tmp, "telegram.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT key,channel,status,message_id FROM channel_outgoing ORDER BY key").all();
  } finally {
    db.close();
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-channel-image-"));
  ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "affiche.png"), PNG);
  fs.writeFileSync(path.join(ws, "notes.pdf"), "%PDF-1.4");
  texts = [];
  files = [];
  fileReply = () => Promise.resolve({ message_id: 7, method: "sendPhoto" });
  textReply = () => Promise.resolve({ message_id: 8 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("telegram_post_channel image_path", () => {
  it("publishes the image on the channel with the text as caption", async () => {
    const r = await channel().post({ text: "Nouvelle affiche", idempotency_key: "c1", image_path: "affiche.png" });
    expect(files).toEqual([{ chat: "@mindprotocol_ai", name: "affiche.png", caption: "Nouvelle affiche" }]);
    expect(texts).toEqual([]);
    expect(r).toEqual({
      channel: "@mindprotocol_ai",
      message_id: 7,
      idempotency_key: "c1",
      format: "plain",
      file: { path: fs.realpathSync(path.join(ws, "affiche.png")), method: "sendPhoto", size: PNG.length },
    });
    expect(journal()).toEqual([{ key: "c1", channel: "@mindprotocol_ai", status: "sent", message_id: "7" }]);
  });

  it("an absolute path inside the workspace works; the method comes from the sender (document)", async () => {
    fileReply = () => Promise.resolve({ message_id: 9, method: "sendDocument" });
    const r = await channel().post({ text: "Le PDF", idempotency_key: "c2", image_path: path.join(ws, "notes.pdf") });
    expect(r.file?.method).toBe("sendDocument");
    expect(files[0]?.name).toBe("notes.pdf");
  });

  it("beyond 1024 characters the file goes without caption and the text follows separately", async () => {
    const long = "x".repeat(1500);
    const r = await channel().post({ text: long, idempotency_key: "c3", image_path: "affiche.png" });
    expect(files).toEqual([{ chat: "@mindprotocol_ai", name: "affiche.png", caption: "" }]);
    expect(texts).toEqual([{ chat: "@mindprotocol_ai", text: long }]);
    expect(r.message_id).toBe(7);
  });

  it("a reused key never republishes, with or without image", async () => {
    await channel().post({ text: "a", idempotency_key: "c4", image_path: "affiche.png" });
    await expect(channel().post({ text: "a", idempotency_key: "c4", image_path: "affiche.png" })).rejects.toMatchObject({ code: "duplicate_key" });
    await expect(channel().post({ text: "a", idempotency_key: "c4" })).rejects.toMatchObject({ code: "duplicate_key" });
    expect(files).toHaveLength(1);
    expect(texts).toHaveLength(0);
  });

  it("refuses paths outside the workspace or missing files, without consuming the key", async () => {
    fs.writeFileSync(path.join(tmp, "secret.png"), PNG);
    await expect(channel().post({ text: "t", idempotency_key: "c5", image_path: "../secret.png" })).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(channel().post({ text: "t", idempotency_key: "c5", image_path: "absent.png" })).rejects.toMatchObject({ code: "not_found" });
    await expect(channel().post({ text: "t", idempotency_key: "c5", image_path: "https://x/y.png" })).rejects.toMatchObject({ code: "invalid_path" });
    expect(files).toHaveLength(0);
    // La clé reste libre : le bon envoi passe ensuite.
    await channel().post({ text: "t", idempotency_key: "c5", image_path: "affiche.png" });
    expect(files).toHaveLength(1);
  });

  it("a clear Telegram refusal of the file frees the key; a failure after the file keeps it (uncertain)", async () => {
    fileReply = () => Promise.reject(Object.assign(new Error("refused"), { telegramCode: 403 }));
    await expect(channel().post({ text: "t", idempotency_key: "c6", image_path: "affiche.png" })).rejects.toThrow("refused");
    expect(journal()).toEqual([]);
    fileReply = () => Promise.resolve({ message_id: 7, method: "sendPhoto" });
    textReply = () => Promise.reject(Object.assign(new Error("text refused"), { telegramCode: 400 }));
    await expect(channel().post({ text: "y".repeat(1100), idempotency_key: "c7", image_path: "affiche.png" })).rejects.toThrow("text refused");
    expect(journal()).toEqual([{ key: "c7", channel: "@mindprotocol_ai", status: "uncertain", message_id: null }]);
  });

  it("without image_path the text-only publication is unchanged", async () => {
    const r = await channel().post({ text: "juste du texte", idempotency_key: "c8" });
    expect(texts).toEqual([{ chat: "@mindprotocol_ai", text: "juste du texte" }]);
    expect(files).toEqual([]);
    expect(r).toEqual({ channel: "@mindprotocol_ai", message_id: 8, idempotency_key: "c8", format: "plain" });
  });

  it("the MCP tool exposes image_path and routes it to the file sender", async () => {
    const workspace = workspaceDirFor(tmp);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "visuel.png"), PNG);
    const server = new McpServer({ name: "telegram-test", version: "1" });
    registerTelegramTools(server, { MIND_WAKE_DATA_DIR: tmp }, send, sendFile);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "telegram_post_channel");
      expect(Object.keys((tool?.inputSchema as { properties: object }).properties)).toEqual(["text", "idempotency_key", "image_path", "format"]);
      expect(tool?.description).toContain("image_path");
      const r = (await client.callTool({
        name: "telegram_post_channel",
        arguments: { text: "Voici", idempotency_key: "m1", image_path: "visuel.png" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).not.toBe(true);
      const data = (JSON.parse(r.content[0]?.text ?? "{}") as { data: { file?: { method: string } } }).data;
      expect(data.file?.method).toBe("sendPhoto");
      expect(files).toEqual([{ chat: "@mindprotocol_ai", name: "visuel.png", caption: "Voici" }]);
      const bad = (await client.callTool({
        name: "telegram_post_channel",
        arguments: { text: "x", idempotency_key: "m2", image_path: "../../hors.png" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
