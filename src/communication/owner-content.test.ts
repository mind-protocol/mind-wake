import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ownerContent } from "./owner-content.js";
import {
  claimOwnerMessages,
  confirmOwnerClaim,
  enqueueOwnerMessage,
  readOwnerReceipts,
  releaseOwnerClaims,
  takeOwnerMessages,
} from "./owner-inbox.js";
import type { WakeImage } from "../contracts/wake-image.js";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quick-image-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const image: WakeImage = {
  mediaType: "image/jpeg",
  base64: "/9j/2Q==",
  capturedAt: "2026-01-01T00:00:00.000Z",
  width: 10,
  height: 10,
  surface: "primary",
};
it("keeps a queued screenshot through restart and does not let text hooks consume it", () => {
  enqueueOwnerMessage(dir, {
    id: "photo",
    at: image.capturedAt,
    text: "Explique cet écran",
    image,
  });
  expect(takeOwnerMessages(dir, "hook")).toEqual([]);
  const first = claimOwnerMessages(dir, "crashed", "one");
  expect(first[0]?.image).toEqual(image);
  releaseOwnerClaims(dir);
  const next = claimOwnerMessages(dir, "resumed", "two");
  expect(next).toEqual(first);
  for (const runtime of ["codex", "claude"] as const) {
    const content = ownerContent(next, runtime);
    expect(content.filter((c) => c["type"] === "image")).toHaveLength(1);
    expect(JSON.stringify(content.filter((c) => c["type"] === "text"))).not.toContain(image.base64);
    expect(JSON.stringify(content)).toContain(image.capturedAt);
  }
  expect(readOwnerReceipts(dir)).toEqual({});
  confirmOwnerClaim(dir, "resumed", "two");
  expect(readOwnerReceipts(dir)["photo"]).toBeTruthy();
  const db = new Database(path.join(dir, "owner-inbox.sqlite"));
  expect(db.prepare("SELECT image_json FROM inbox WHERE id='photo'").get()).toEqual({
    image_json: null,
  });
  db.close();
  expect(claimOwnerMessages(dir, "again", "three")).toEqual([]);
});
it("migrates an existing inbox without losing pending text", () => {
  const db = new Database(path.join(dir, "owner-inbox.sqlite"));
  db.exec(
    "CREATE TABLE inbox(id TEXT PRIMARY KEY,at TEXT,text TEXT,emitted_session TEXT,emitted_at TEXT); INSERT INTO inbox VALUES('old','today','bonjour',NULL,NULL)",
  );
  db.close();
  enqueueOwnerMessage(dir, { id: "new", at: image.capturedAt, text: "image", image });
  expect(claimOwnerMessages(dir, "session", "claim").map((m) => m.id)).toEqual(["old", "new"]);
});
it("rejects malformed image bytes before queueing", () => {
  expect(() => {
    enqueueOwnerMessage(dir, {
      id: "bad",
      at: image.capturedAt,
      text: "x",
      image: { ...image, base64: "abcd" },
    });
  }).toThrow("Invalid owner image");
});
