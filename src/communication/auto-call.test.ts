/** Appel automatique (page Appel) : minuteur du moteur, sans passerelle ni téléphone réels. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  AUTO_CALL_STATE,
  autoCallPurpose,
  autoCallTick,
  findCommitment,
  readAutoCallState,
  readAutoCallTrace,
  ringOwner,
  inviteStatus,
  setAutoCallEnabled,
  type AutoCallDeps,
} from "./auto-call.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-call-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
function deps(over: Partial<AutoCallDeps> & { at: number }): AutoCallDeps & { rings: number; notices: string[] } {
  const out = {
    dataDir: dir,
    now: () => over.at,
    blocker: () => null,
    busy: () => null,
    status: () => "pending" as const,
    messages: () => [],
    rings: 0,
    notices: [] as string[],
    ...over,
  } as AutoCallDeps & { rings: number; notices: string[] };
  const self = out as { rings: number; notices: string[] };
  return {
    ...out,
    ring: over.ring ?? (() => { self.rings++; return { id: `inv-${String(self.rings)}`, expiresAt: new Date(over.at + 45_000).toISOString() }; }),
    notify: over.notify ?? ((_k, text) => { self.notices.push(text); }),
    get rings() { return self.rings; },
    get notices() { return self.notices; },
  };
}

it("enabling persists nextAt, rings once, then re-arms 10 minutes later (survives a re-read)", () => {
  setAutoCallEnabled(dir, true, T0);
  expect(readAutoCallState(dir).nextAt).toBe(new Date(T0).toISOString());
  const d = deps({ at: T0 + 1000 });
  const line = autoCallTick(d);
  expect(line?.outcome).toBe("lancé");
  expect(d.rings).toBe(1);
  // Relu depuis le disque, comme après un redémarrage du daemon.
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, AUTO_CALL_STATE), "utf8"));
  expect(persisted.nextAt).toBe(new Date(T0 + 1000 + 600_000).toISOString());
  expect(persisted.enabled).toBe(true);
  expect(persisted.lastOutcome).toBe("lancé");
  // Pas encore dû : rien.
  expect(autoCallTick(deps({ at: T0 + 60_000 }))).toBeNull();
});

it("skips when a call is already active, without ringing", () => {
  setAutoCallEnabled(dir, true, T0);
  const d = deps({ at: T0, busy: () => "appel en cours" });
  const line = autoCallTick(d);
  expect(line).toMatchObject({ outcome: "sauté", reason: "appel en cours" });
  expect(d.rings).toBe(0);
  expect(d.notices).toHaveLength(0);
  expect(readAutoCallState(dir).lastOutcome).toBe("sauté (appel en cours)");
});

it("skips while paused or forced off, and still re-arms", () => {
  setAutoCallEnabled(dir, true, T0);
  const d = deps({ at: T0, blocker: () => "Pause" });
  expect(autoCallTick(d)).toMatchObject({ outcome: "sauté", reason: "Pause" });
  expect(d.rings).toBe(0);
  expect(readAutoCallState(dir).nextAt).toBe(new Date(T0 + 600_000).toISOString());
  const f = deps({ at: T0 + 600_000, blocker: () => "Force-off" });
  expect(autoCallTick(f)).toMatchObject({ outcome: "sauté", reason: "Force-off" });
  expect(f.rings).toBe(0);
  expect(readAutoCallTrace(dir).map((l) => l.reason)).toEqual(["Pause", "Force-off"]);
});

it("does nothing when disabled", () => {
  setAutoCallEnabled(dir, true, T0);
  setAutoCallEnabled(dir, false, T0);
  const d = deps({ at: T0 + 3_600_000 });
  expect(autoCallTick(d)).toBeNull();
  expect(d.rings).toBe(0);
  expect(readAutoCallState(dir).nextAt).toBeNull();
});

it("records « décroché » only when the call system says accept; expiry is « sans réponse »", () => {
  setAutoCallEnabled(dir, true, T0);
  autoCallTick(deps({ at: T0 }));
  expect(autoCallTick(deps({ at: T0 + 15_000, status: () => "accept" }))).toMatchObject({ outcome: "décroché", inviteId: "inv-1" });
  expect(readAutoCallState(dir).pendingInvite).toBeNull();
  const next = deps({ at: T0 + 600_000 });
  autoCallTick(next);
  expect(autoCallTick(deps({ at: T0 + 660_000, status: () => "expired" }))).toMatchObject({ outcome: "sans réponse" });
});

it("passes the previous call timestamp and the last commitment to the agent", () => {
  setAutoCallEnabled(dir, true, T0);
  autoCallTick(deps({ at: T0 }));
  const later = deps({
    at: T0 + 600_000,
    status: () => "expired",
    messages: () => [{ text: "Depuis 13:00 : …\nd'ici le prochain appel, je tente d'envoyer l'offre Soda", createdAt: new Date(T0 + 30_000).toISOString() }],
  });
  autoCallTick(later);
  const notice = later.notices[0] ?? "";
  expect(notice).toContain(new Date(T0).toISOString());
  expect(notice).toContain("Depuis 13:00");
  expect(notice).toContain("je tente d'envoyer l'offre Soda");
  expect(readAutoCallState(dir).lastCommitment?.text).toBe("d'envoyer l'offre Soda");
});

it("purpose names sources and the opening form", () => {
  const text = autoCallPurpose("2026-11-20T12:10:00.000Z", "2026-11-20T12:00:00.000Z");
  expect(text).toContain("REPRISE-SOUS-SESSIONS.md");
  expect(text).toContain("« Depuis 13:00 : »");
  expect(text).toContain("list_owner_messages");
  expect(findCommitment([{ text: "rien", createdAt: "2026-11-20T12:01:00Z" }], null)).toBeNull();
});

it("rings through the same invitations table as call_human and reads the decision back", () => {
  const db = new Database(path.join(dir, "mobile-calls.sqlite"));
  db.exec("CREATE TABLE invitations(id TEXT PRIMARY KEY, human TEXT NOT NULL, caller TEXT NOT NULL, label TEXT NOT NULL, until INTEGER NOT NULL, decision TEXT, invite_humans INTEGER NOT NULL DEFAULT 0, call_id TEXT)");
  db.close();
  const invite = ringOwner(dir, T0);
  expect(inviteStatus(dir, invite.id, T0 + 1000)).toBe("pending");
  const rw = new Database(path.join(dir, "mobile-calls.sqlite"));
  expect(rw.prepare("SELECT human, caller, label FROM invitations").get()).toEqual({ human: "nlr", caller: "mind", label: "Marco" });
  rw.prepare("UPDATE invitations SET decision='accept'").run();
  rw.close();
  expect(inviteStatus(dir, invite.id, T0 + 2000)).toBe("accept");
  expect(inviteStatus(dir, "missing", T0)).toBe("unknown");
});
