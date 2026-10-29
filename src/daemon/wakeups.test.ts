/** Réveils demandés par l'agent : validation, confinement, archivage, échéances. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROFILE } from "../../test/fixtures/store-ledger/setup.js";
import type { AgentId, ProviderQuotaSnapshot, UtcTimestamp } from "../contracts/index.js";
import { openStore, type Store } from "../store/index.js";
import { loadWakeTemplates } from "./wake-prompt.js";
import { AgentWakeups, MAX_WAKEUP_BYTES } from "./wakeups.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-29T09:00:00.000Z");

let dir: string;
let workspace: string;
let store: Store;
let wakeups: AgentWakeups;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mind-wake-wakeups-"));
  workspace = path.join(dir, "workspace");
  store = openStore(path.join(dir, "control.sqlite"));
  store.uow.profiles.create({
    id: PROFILE,
    agentId: "agent-1" as AgentId,
    state: "disabled",
    activePolicyRevisionId: null,
    nextWakeAt: null,
    emergencyStopLocked: false,
    stateReason: "banc",
    updatedAt: new Date(T0).toISOString() as UtcTimestamp,
  });
  wakeups = new AgentWakeups({
    uow: store.uow,
    db: store.db,
    profileId: PROFILE,
    workspaceDir: workspace,
    schemaText: loadWakeTemplates().wakeupSchema,
  });
  wakeups.prepare();
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function put(name: string, content: unknown): string {
  const file = path.join(wakeups.dir, name);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

function request(id: string, when: unknown, extra: Record<string, unknown> = {}): unknown {
  return { version: 1, id, when, prompt: `note ${id}`, ...extra };
}

function denied(): { reason: string; metadata: unknown }[] {
  return store.uow.journal
    .list(PROFILE)
    .filter((e) => e.type === "action_denied")
    .map((e) => ({ reason: e.reason, metadata: e.metadata }));
}

function archived(): string[] {
  return fs.readdirSync(path.join(wakeups.dir, "archive"));
}

describe("demandes valides", () => {
  it("dépose le schéma pour l'agent et lit une demande `afterHours`", async () => {
    expect(fs.existsSync(wakeups.schemaPath)).toBe(true);
    put("later.json", request("later", { afterHours: 6 }));
    expect(await wakeups.nextDue(T0)).toBe(T0 + 6 * HOUR);
    // Première vue persistée : l'échéance ne glisse pas d'un tour à l'autre.
    expect(await wakeups.nextDue(T0 + HOUR)).toBe(T0 + 6 * HOUR);
    expect(await wakeups.takeDue(T0 + HOUR)).toBeNull();
    expect(await wakeups.takeDue(T0 + 6 * HOUR)).toEqual({ id: "later", prompt: "note later" });
    // Servie sans `repeat` : archivée.
    expect(fs.existsSync(path.join(wakeups.dir, "later.json"))).toBe(false);
    expect(archived().some((f) => f.endsWith("-served-later.json"))).toBe(true);
    expect(await wakeups.nextDue(T0 + 7 * HOUR)).toBeNull();
  });

  it("`repeat` : reste en place, prochaine échéance depuis le dernier service", async () => {
    put("loop.json", request("loop", { afterHours: 2 }, { repeat: true }));
    await wakeups.nextDue(T0);
    expect(await wakeups.takeDue(T0 + 2 * HOUR)).not.toBeNull();
    expect(fs.existsSync(path.join(wakeups.dir, "loop.json"))).toBe(true);
    expect(await wakeups.nextDue(T0 + 2 * HOUR)).toBe(T0 + 4 * HOUR);
  });

  it("demande expirée : archivée et journalisée, jamais servie", async () => {
    put("old.json", request("old", { afterHours: 1 }, { expires: "2026-10-29T08:00:00Z" }));
    expect(await wakeups.takeDue(T0)).toBeNull();
    expect(archived().some((f) => f.endsWith("-expired-old.json"))).toBe(true);
    expect(store.uow.journal.list(PROFILE).map((e) => e.reason)).toContain(
      "wakeups.expired_archived",
    );
  });

  it("`quotaResetWithinHours` avec horloge simulée : due seulement près de la remise à zéro", async () => {
    put("quota.json", request("quota", { quotaResetWithinHours: 2 }));
    const resetsAt = T0 + 5 * HOUR;
    const gauge = (): Promise<readonly ProviderQuotaSnapshot[]> =>
      Promise.resolve([
        {
          windowKey: "primary",
          windowDurationMs: 5 * HOUR,
          usedBasisPoints: 3_000,
          resetsAt: new Date(resetsAt).toISOString() as UtcTimestamp,
          observedAt: new Date(T0).toISOString() as UtcTimestamp,
          provenance: "measured",
        },
      ]);
    expect(await wakeups.nextDue(T0, gauge)).toBe(resetsAt - 2 * HOUR);
    expect(await wakeups.takeDue(T0 + 2 * HOUR, gauge)).toBeNull();
    expect(await wakeups.takeDue(T0 + 3 * HOUR, gauge)).toMatchObject({ id: "quota" });
    // Sans lecture de jauge, la condition n'est jamais remplie.
    put("quota2.json", request("quota2", { quotaResetWithinHours: 2 }));
    expect(await wakeups.nextDue(T0 + 3 * HOUR)).toBeNull();
  });

  it("`fileChanged` : due quand le fichier confiné change après la première vue", async () => {
    fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
    const watched = path.join(workspace, "notes", "data.csv");
    fs.writeFileSync(watched, "a\n");
    fs.utimesSync(watched, new Date(T0 - HOUR), new Date(T0 - HOUR));
    put("watch.json", request("watch", { fileChanged: "notes/data.csv" }));
    expect(await wakeups.nextDue(T0)).toBeNull();
    fs.utimesSync(watched, new Date(T0 + HOUR), new Date(T0 + HOUR));
    expect(await wakeups.nextDue(T0 + 2 * HOUR)).toBe(T0 + 2 * HOUR);
  });
});

describe("demandes invalides ou hostiles : ignorées, journalisées, archivées", () => {
  const cases: readonly [string, string, unknown][] = [
    ["champ inconnu", "extra.json", request("extra", { afterHours: 1 }, { grant: "network" })],
    ["condition inconnue", "cond.json", request("cond", { whenever: true })],
    ["deux conditions", "two.json", request("two", { afterHours: 1, at: "2026-10-30T00:00:00Z" })],
    ["délai hors bornes", "far.json", request("far", { afterHours: 10_000 })],
    ["identifiant invalide", "id.json", request("../../policy", { afterHours: 1 })],
    [
      "texte trop long",
      "long.json",
      { ...(request("long", { afterHours: 1 }) as object), prompt: "x".repeat(1_001) },
    ],
    ["chemin hors de l'espace", "path.json", request("path", { fileChanged: "../control.sqlite" })],
    ["chemin absolu", "abs.json", request("abs", { fileChanged: "C:/Windows/win.ini" })],
    [
      "version inconnue",
      "v2.json",
      { ...(request("v2", { afterHours: 1 }) as object), version: 2 },
    ],
    ["JSON invalide", "broken.json", "{ not json"],
    ["fichier trop gros", "big.json", " ".repeat(MAX_WAKEUP_BYTES + 1)],
  ];

  it.each(cases)("%s", async (_name, file, content) => {
    put(file, content);
    expect(await wakeups.nextDue(T0)).toBeNull();
    expect(await wakeups.takeDue(T0 + 200 * HOUR)).toBeNull();
    expect(denied()).toHaveLength(1);
    expect(denied()[0]).toMatchObject({ reason: "wakeups.invalid_ignored" });
    expect(fs.existsSync(path.join(wakeups.dir, file))).toBe(false);
    expect(archived().some((f) => f.endsWith(`-rejected-${file}`))).toBe(true);
  });

  it("refuse un lien physique vers un fichier hors de l'espace", async () => {
    const outside = path.join(dir, "secret.json");
    fs.writeFileSync(outside, JSON.stringify(request("hard", { afterHours: 1 })));
    fs.linkSync(outside, path.join(wakeups.dir, "hard.json"));
    expect(await wakeups.nextDue(T0)).toBeNull();
    expect(denied()[0]?.metadata).toMatchObject({ reason: "hardlink_refused" });
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("refuse un dossier de réveils remplacé par une jonction vers l'extérieur", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "x.json"), JSON.stringify(request("x", { afterHours: 1 })));
    fs.rmSync(wakeups.dir, { recursive: true, force: true });
    fs.symlinkSync(outside, wakeups.dir, "junction");
    expect(await wakeups.nextDue(T0)).toBeNull();
    expect(store.uow.journal.list(PROFILE).map((e) => e.reason)).toContain("wakeups.dir_unsafe");
    expect(fs.existsSync(path.join(outside, "x.json"))).toBe(true);
  });

  it("refuse `fileChanged` à travers une jonction", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "f.txt"), "x");
    fs.symlinkSync(outside, path.join(workspace, "door"), "junction");
    put("door.json", request("door", { fileChanged: "door/f.txt" }));
    fs.utimesSync(path.join(outside, "f.txt"), new Date(T0 + HOUR), new Date(T0 + HOUR));
    expect(await wakeups.nextDue(T0 + 2 * HOUR)).toBeNull();
  });

  it("identifiant en double : la seconde demande est rejetée", async () => {
    put("a.json", request("same", { afterHours: 1 }));
    put("b.json", request("same", { afterHours: 2 }));
    expect(await wakeups.nextDue(T0)).toBe(T0 + HOUR);
    expect(denied()[0]?.metadata).toMatchObject({ reason: "duplicate_id" });
  });
});
