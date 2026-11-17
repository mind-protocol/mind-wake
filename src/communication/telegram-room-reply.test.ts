import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractReplyFiles, forwardRoomReply, ownerSendPayload, type OwnerTelegramFile } from "./telegram-room-reply.js";

let tmp: string;
let room: string;
let mind: string;
let outside: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "room-reply-")));
  room = path.join(tmp, "room");
  mind = path.join(tmp, "mind");
  outside = path.join(tmp, "ailleurs");
  for (const d of [room, mind, outside]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(room, "a.png"), "a");
  fs.writeFileSync(path.join(room, "b.pdf"), "b");
  fs.writeFileSync(path.join(mind, "c.txt"), "c");
  fs.writeFileSync(path.join(mind, "d.txt"), "d");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("extractReplyFiles", () => {
  it("removes [fichier: …] and [file: …] lines; relative to the room, absolute in MIND", () => {
    const r = extractReplyFiles(`Voici.\n[fichier: a.png]\n  [File: ${path.join(mind, "c.txt")}]  \nFin.`, [room, mind]);
    expect(r.text).toBe("Voici.\nFin.");
    expect(r.files).toEqual([
      { path: path.join(room, "a.png"), root: room },
      { path: path.join(mind, "c.txt"), root: mind },
    ]);
  });

  it("leaves inline mentions untouched", () => {
    const r = extractReplyFiles("Ajoute [fichier: a.png] dans le texte.", [room, mind]);
    expect(r).toEqual({ text: "Ajoute [fichier: a.png] dans le texte.", files: [] });
  });

  it("refuses files outside both workspaces, missing files and traversal, with a short note", () => {
    const r = extractReplyFiles(
      `Texte\n[fichier: ${path.join(outside, "secret.txt")}]\n[fichier: ../ailleurs/secret.txt]\n[fichier: absent.png]`,
      [room, mind],
    );
    expect(r.files).toEqual([]);
    expect(r.text).toBe(
      [
        "Texte",
        `(fichier non envoyé : ${path.join(outside, "secret.txt")} — hors du workspace)`,
        "(fichier non envoyé : ../ailleurs/secret.txt — hors du workspace)",
        "(fichier non envoyé : absent.png — introuvable)",
      ].join("\n"),
    );
  });

  it("sends at most 3 files and notes the rest", () => {
    const r = extractReplyFiles(
      ["T", "[fichier: a.png]", "[fichier: b.pdf]", `[fichier: ${path.join(mind, "c.txt")}]`, `[fichier: \`${path.join(mind, "d.txt")}\`]`].join("\n"),
      [room, mind],
    );
    expect(r.files.map((f) => path.basename(f.path))).toEqual(["a.png", "b.pdf", "c.txt"]);
    expect(r.text).toBe(`T\n(fichier non envoyé : ${path.join(mind, "d.txt")} — 3 au plus par réponse)`);
  });
});

describe("forwardRoomReply with files", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
  };

  it("first file carries the text, others go with an empty caption and -fN keys", async () => {
    const sent: { text: string; key: string; file?: OwnerTelegramFile | undefined }[] = [];
    const ok = await forwardRoomReply({
      store: store(),
      room: 7,
      entryId: 42,
      name: "VOX",
      text: "Les deux images.\n[fichier: a.png]\n[file: b.pdf]",
      send: async (text, key, file) => void sent.push({ text, key, file }),
      workspaces: [room, mind],
    });
    expect(ok).toBe(true);
    expect(sent).toEqual([
      { text: "VOX : Les deux images.", key: "room7-reply-42", file: { path: path.join(room, "a.png"), root: room } },
      { text: "", key: "room7-reply-42-f2", file: { path: path.join(room, "b.pdf"), root: room } },
    ]);
  });

  it("without workspaces, the text is sent as before", async () => {
    const sent: unknown[] = [];
    await forwardRoomReply({ store: store(), room: 7, entryId: 1, name: "VOX", text: "x\n[fichier: a.png]", send: async (...a) => void sent.push(a) });
    expect(sent).toEqual([["VOX : x\n[fichier: a.png]", "room7-reply-1", undefined]]);
  });
});

describe("ownerSendPayload", () => {
  it("passes image_path and its workspace through to owner-send-main", async () => {
    const { parseOwnerSendInput } = await import("../../services/telegram/owner-send-input.js");
    const file = { path: path.join(room, "a.png"), root: room };
    expect(parseOwnerSendInput(ownerSendPayload("légende", "k-f2", file))).toEqual({
      send: { text: "légende", idempotency_key: "k-f2", image_path: file.path },
      workspace: room,
    });
    expect(parseOwnerSendInput(ownerSendPayload("texte", "k"))).toEqual({ send: { text: "texte", idempotency_key: "k" } });
    expect(() => parseOwnerSendInput(JSON.stringify({ text: "t", idempotency_key: "k", image_path: 3 }))).toThrow();
  });
});
