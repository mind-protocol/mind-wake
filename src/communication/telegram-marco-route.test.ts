import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { forkDir } from "../daemon/forks.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import { readOwnerMessages } from "./owner-messages.js";
import { MARCO_ROUTES_PER_HOUR, leadHandles, routeMarcoHandles } from "./telegram-marco-route.js";
import type { HandleTarget } from "./telegram-handle-route.js";

let dataDir: string;
let clock: number;
const now = () => clock;
const table = new Map<string, HandleTarget>([
  ["vox", { handle: "vox", room: 7, agent: null, label: "Room 7 (VOX)" }],
  ["crypto", { handle: "crypto", room: 0, agent: null, holder: "crypto", label: "🪙 Crypto (fil principal)" }],
]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-marco-"));
  fs.mkdirSync(forkDir(dataDir, 7), { recursive: true });
  clock = Date.parse("2026-11-16T17:10:00.000Z");
  routeMarcoHandles(dataDir, { now, table }); // premier passage : point de départ
  clock += 1000;
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function sent(key: string, text: string, status = "sent") {
  const db = new Database(path.join(dataDir, "telegram.sqlite"));
  db.prepare("INSERT INTO channel_outgoing(key,channel,text,at,status) VALUES(?,?,?,?,?)").run(`owner:${key}`, "owner", text, new Date(clock).toISOString(), status);
  db.close();
}
const room7 = () => {
  const s = new SecondThreadStore(forkDir(dataDir, 7));
  try {
    return s.pendingHuman().map((e) => ({ text: e.text, label: e.notice?.label, human: s.isHumanOrigin(e), telegram: s.isTelegramRouted(e.id) }));
  } finally {
    s.close();
  }
};

it("routes Marco's leading @handles once, labelled, as a Telegram-routed one-shot trigger", () => {
  sent("marco-0001", "@vox NLR veut savoir où en est la chanson.");
  expect(routeMarcoHandles(dataDir, { now, table })).toEqual([{ key: "owner:marco-0001", handle: "vox", status: "routed" }]);
  expect(routeMarcoHandles(dataDir, { now, table })).toEqual([]);
  expect(room7()).toEqual([{ text: "@vox NLR veut savoir où en est la chanson.", label: "Marco (Telegram, devant NLR)", human: true, telegram: true }]);
});

it("never triggers on relayed replies, @handles in the middle, @marco, unsent or older messages", () => {
  sent("room7-reply-1580", "@vox VOX : je suis là.");
  sent("holder-crypto-reply-tg-1-2", "@vox 🪙 Crypto : non.");
  sent("marco-0002", "Je demande à @vox.");
  sent("marco-0003", "@marco note pour moi");
  sent("marco-0004", "@vox pas encore parti", "pending");
  expect(routeMarcoHandles(dataDir, { now, table })).toEqual([]);
  expect(room7()).toEqual([]);
  expect(leadHandles("@marco @vox, @crypto salut @viz")).toEqual(["marco", "vox", "crypto"]);
});

it("calls a main-thread holder by posting a marked mention, and caps a room at 10 per hour", () => {
  sent("marco-0005", "@crypto un avis sur le canal ?");
  expect(routeMarcoHandles(dataDir, { now, table })[0]?.status).toBe("main");
  expect(readOwnerMessages(dataDir)?.at(-1)?.text).toBe("[Marco (Telegram, devant NLR)] @crypto un avis sur le canal ?");
  for (let i = 0; i < MARCO_ROUTES_PER_HOUR + 1; i++) sent(`marco-1${String(i).padStart(3, "0")}`, `@vox ${String(i)}`);
  const statuses = routeMarcoHandles(dataDir, { now, table }).map((r) => r.status);
  expect(statuses.filter((s) => s === "routed")).toHaveLength(MARCO_ROUTES_PER_HOUR);
  expect(statuses.at(-1)).toBe("hourly_cap");
});
