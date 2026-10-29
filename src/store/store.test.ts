import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_PARIS,
  LIMITS,
  PARIS,
  PROFILE,
  createProfile,
  tempDir,
  ts,
  type TempDir,
} from "../../test/fixtures/store-ledger/setup.js";
import type {
  AdapterId,
  AgentId,
  ArtifactId,
  Checkpoint,
  CheckpointId,
  ConfinedRelativePath,
  ConsentId,
  ExperimentId,
  ExperimentRecord,
  PolicyGroups,
  PolicyRevision,
  PolicyRevisionId,
  ReservationId,
  SessionId,
  Sha256Hex,
} from "../contracts/index.js";
import { POLICY_SCHEMA_VERSION, PROFILE_STATES } from "../contracts/index.js";
import { MIGRATIONS, StoreError, migrate, openDatabase, openStore, type Store } from "./index.js";

let dir: TempDir;
let store: Store;

beforeEach(() => {
  dir = tempDir();
  store = openStore(dir.dbPath);
  createProfile(store.uow);
});

afterEach(() => {
  store.close();
  dir.remove();
});

const NOW = ts("2026-10-29T12:00:00Z");

function groups(): PolicyGroups {
  return {
    identity: { profileId: PROFILE, agentId: "agent-1" as AgentId },
    runtime: { adapterId: "fake" as AdapterId, provider: "none", model: "none", authMode: "none" },
    schedule: {
      timeZone: PARIS,
      weeklyWindows: [{ day: 1, start: "09:00", end: "17:00" }],
      minIntervalBetweenSessionsMs: 60_000,
      maxSessionDurationMs: 600_000,
    },
    humanPriority: {
      activitySignal: "idle",
      idleThresholdMs: 60_000,
      maxSignalAgeMs: 10_000,
      maxInterruptLatencyMs: 5_000,
      maxTerminationLatencyMs: 10_000,
    },
    budget: {
      period: DAY_PARIS,
      tokensPerSession: 3_000,
      tokensPerPeriod: 10_000,
      sessionsPerPeriod: 3,
      userReserveTokens: 2_000,
      checkpointTokens: 500,
      paidApi: { authorized: false },
    },
    filesAndTools: {
      readRoots: [],
      writeRoots: [],
      allowedExecutables: [],
      maxProcesses: 4,
      maxStorageBytes: 1_000_000,
    },
    network: { explorationDestinations: [], providerTransportDestinations: [] },
    data: {
      eventRetentionDays: 30,
      localStorageCapBytes: 1_000_000,
      purge: "manual",
      exportPaths: [],
    },
  };
}

function revision(id: string, previous: string | null): PolicyRevision {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    id: id as PolicyRevisionId,
    profileId: PROFILE,
    previousRevisionId: previous as PolicyRevisionId | null,
    createdAt: NOW,
    groups: groups(),
  };
}

/** Réservation + session ouverte, prérequis des sessions et checkpoints. */
function openSession(id: string): SessionId {
  const periodId = store.uow.ledger.ensurePeriod(PROFILE, DAY_PARIS, NOW, LIMITS).id;
  const reserved = store.uow.ledger.reserve({
    id: `res-${id}` as ReservationId,
    sessionId: id as SessionId,
    profileId: PROFILE,
    periodIds: [periodId],
    maxima: [{ unit: "sessions", amount: 1 }],
    at: NOW,
  });
  expect(reserved.status).toBe("reserved");
  if (store.uow.policies.getRevision("rev-1" as PolicyRevisionId) === null) {
    store.uow.policies.appendRevision(revision("rev-1", null));
  }
  store.uow.sessions.create({
    id: id as SessionId,
    profileId: PROFILE,
    experimentId: null,
    adapterId: "fake" as AdapterId,
    policyRevisionId: "rev-1" as PolicyRevisionId,
    reservationId: `res-${id}` as ReservationId,
    startedAt: NOW,
    endedAt: null,
    outcome: null,
    outcomeReason: null,
  });
  return id as SessionId;
}

describe("ouverture et migrations", () => {
  it("active WAL, clés étrangères, synchronisation complète et attente sur verrou", () => {
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(store.db.pragma("synchronous", { simple: true })).toBe(2);
    expect(store.db.pragma("busy_timeout", { simple: true })).toBe(5_000);
  });

  it("applique les migrations une seule fois", () => {
    expect(migrate(store.db)).toEqual([]);
    store.close();
    store = openStore(dir.dbPath);
    const rows = store.db.prepare("SELECT version, name FROM schema_migrations").all();
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
  });

  it("refuse une base plus récente que ce binaire", () => {
    store.db
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(MIGRATIONS.length + 1, "future", NOW);
    store.close();
    expect(() => openDatabase(dir.dbPath)).toThrow(/inconnue de ce binaire/);
    store = openStore(":memory:");
  });

  it("annule une migration qui échoue sans l'enregistrer", () => {
    const db = openDatabase(":memory:");
    try {
      const broken = [
        ...MIGRATIONS,
        { version: 2, name: "broken", sql: "CREATE TABLE x (a); SELEC" },
      ];
      expect(() => migrate(db, broken)).toThrow();
      expect(db.prepare("SELECT max(version) AS v FROM schema_migrations").get()).toEqual({ v: 1 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'x'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("ne prévoit aucune colonne destinée à un secret", () => {
    const columns = store.db
      .prepare(
        "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'",
      )
      .all() as { tbl: string; col: string }[];
    expect(columns.length).toBeGreaterThan(50);
    expect(
      columns.filter((c) => /secret|password|credential|api_?key|bearer/i.test(c.col)),
    ).toEqual([]);
  });

  it("applique les clés étrangères", () => {
    expect(() => {
      store.uow.ledger.ensurePeriod("inconnu" as typeof PROFILE, DAY_PARIS, NOW, LIMITS);
    }).toThrow(/FOREIGN KEY/);
  });
});

describe("unité de travail", () => {
  it("annule tout le travail d'une transaction qui lève", () => {
    expect(() =>
      store.uow.transaction((uow) => {
        uow.journal.append({
          type: "error",
          at: NOW,
          profileId: PROFILE,
          reason: "test",
          metadata: {},
        });
        throw new Error("échec");
      }),
    ).toThrow("échec");
    expect(store.uow.journal.list(PROFILE)).toEqual([]);
  });

  it("refuse une fonction asynchrone et annule son effet", () => {
    expect(() =>
      store.uow.transaction(async (uow) => {
        uow.profiles.setNextWake(PROFILE, NOW);
        await Promise.resolve();
      }),
    ).toThrow(StoreError);
    expect(store.uow.profiles.get(PROFILE)?.nextWakeAt).toBeNull();
  });

  it("imbrique les transactions en savepoints", () => {
    store.uow.transaction((outer) => {
      outer.profiles.setNextWake(PROFILE, NOW);
      expect(() =>
        outer.transaction((inner) => {
          inner.profiles.setNextWake(PROFILE, ts("2026-10-30T00:00:00Z"));
          throw new Error("interne");
        }),
      ).toThrow("interne");
    });
    expect(store.uow.profiles.get(PROFILE)?.nextWakeAt).toBe(NOW);
  });
});

describe("profils", () => {
  it("accepte chaque état du contrat", () => {
    PROFILE_STATES.forEach((state, i) => {
      createProfile(store.uow, `p-${String(i)}` as typeof PROFILE);
      store.db.prepare("UPDATE profiles SET state = ? WHERE id = ?").run(state, `p-${String(i)}`);
    });
    expect(() =>
      store.db.prepare("UPDATE profiles SET state = 'awake' WHERE id = ?").run(PROFILE),
    ).toThrow(/CHECK/);
  });

  it("applique une transition autorisée et refuse les autres", () => {
    const ready = store.uow.profiles.transition(PROFILE, {
      from: "disabled",
      to: "ready",
      reason: "activation",
      at: NOW,
    });
    expect(ready).toMatchObject({ state: "ready", stateReason: "activation", updatedAt: NOW });
    expect(store.uow.profiles.get(PROFILE)).toEqual(ready);
    expect(() =>
      store.uow.profiles.transition(PROFILE, {
        from: "ready",
        to: "checkpointing",
        reason: "x",
        at: NOW,
      }),
    ).toThrow(/interdite/);
    expect(() =>
      store.uow.profiles.transition(PROFILE, {
        from: "disabled",
        to: "ready",
        reason: "x",
        at: NOW,
      }),
    ).toThrow(/en état ready/);
  });
});

describe("policies", () => {
  it("conserve les révisions en ajout seul, en chaîne linéaire", () => {
    store.uow.policies.appendRevision(revision("rev-1", null));
    store.uow.policies.appendRevision(revision("rev-2", "rev-1"));
    expect(store.uow.policies.listRevisions(PROFILE).map((r) => r.id)).toEqual(["rev-1", "rev-2"]);
    expect(store.uow.policies.getRevision("rev-1" as PolicyRevisionId)).toEqual(
      revision("rev-1", null),
    );

    expect(() => {
      store.uow.policies.appendRevision(revision("rev-1", null));
    }).toThrow(/déjà enregistrée/);
    expect(() => {
      store.uow.policies.appendRevision(revision("rev-3", "rev-1"));
    }).toThrow(/doit être rev-2/);
    expect(() =>
      store.db.prepare("UPDATE policy_revisions SET groups_json = '{}' WHERE id = 'rev-1'").run(),
    ).toThrow(/ajout seul/);
    expect(() => store.db.prepare("DELETE FROM policy_revisions").run()).toThrow(/ajout seul/);
  });

  it("enregistre consentement et révocations sans modification possible", () => {
    store.uow.policies.appendRevision(revision("rev-1", null));
    const consent = {
      id: "consent-1" as ConsentId,
      revisionId: "rev-1" as PolicyRevisionId,
      grantedAt: NOW,
      channel: "local_cli" as const,
      proof: "journal#1",
    };
    store.uow.policies.recordConsent(consent);
    store.uow.policies.recordConsent(consent);
    expect(store.uow.policies.getConsent("rev-1" as PolicyRevisionId)).toEqual(consent);
    expect(() => {
      store.uow.policies.recordConsent({ ...consent, proof: "autre" });
    }).toThrow(/déjà enregistré/);
    store.uow.policies.recordRevocation({
      revisionId: "rev-1" as PolicyRevisionId,
      revokedAt: NOW,
      reason: "réseau",
    });
    expect(store.uow.policies.listRevocations("rev-1" as PolicyRevisionId)).toHaveLength(1);
    expect(() => store.db.prepare("UPDATE policy_consents SET proof = 'x'").run()).toThrow(
      /ajout seul/,
    );
  });
});

describe("sessions", () => {
  it("refuse une seconde session ouverte et ferme de façon idempotente", () => {
    const first = openSession("s1");
    expect(store.uow.sessions.listOpen(PROFILE).map((s) => s.id)).toEqual([first]);
    store.uow.ledger.markUncertain("res-s1" as ReservationId, NOW);
    expect(() => openSession("s2")).toThrow(/UNIQUE/);

    store.uow.sessions.close(first, "interrupted", "pause", NOW);
    store.uow.sessions.close(first, "interrupted", "pause", NOW);
    expect(() => {
      store.uow.sessions.close(first, "completed", "fin", NOW);
    }).toThrow(/déjà close/);
    expect(store.uow.sessions.get(first)).toMatchObject({ outcome: "interrupted", endedAt: NOW });
    expect(store.uow.sessions.listOpen(PROFILE)).toEqual([]);
  });

  it("refuse une session sur une réservation émise pour une autre", () => {
    openSession("s1");
    expect(() => {
      store.uow.sessions.create({
        ...(store.uow.sessions.get("s1" as SessionId) as NonNullable<
          ReturnType<typeof store.uow.sessions.get>
        >),
        id: "s-autre" as SessionId,
      });
    }).toThrow(/autre session/);
  });
});

describe("journal", () => {
  it("attribue une séquence croissante, jamais réutilisée après purge", () => {
    const append = (reason: string) =>
      store.uow.journal.append({
        type: "error",
        at: NOW,
        profileId: PROFILE,
        reason,
        metadata: { n: 1 },
      });
    expect(append("a").sequence).toBe(1);
    expect(append("b").sequence).toBe(2);
    store.db.prepare("DELETE FROM journal_events WHERE sequence = 2").run();
    expect(append("c").sequence).toBe(3);
    expect(store.uow.journal.list(PROFILE, { afterSequence: 1 }).map((e) => e.reason)).toEqual([
      "c",
    ]);
    expect(store.uow.journal.list(PROFILE, { limit: 1 })[0]).toMatchObject({
      sequence: 1,
      schemaVersion: 1,
      metadata: { n: 1 },
    });
    expect(() => store.db.prepare("UPDATE journal_events SET reason = 'x'").run()).toThrow(
      /ajout seul/,
    );
  });

  it("refuse un type d'événement inconnu", () => {
    expect(() =>
      store.uow.journal.append({
        type: "invented" as "error",
        at: NOW,
        profileId: PROFILE,
        reason: "x",
        metadata: {},
      }),
    ).toThrow(/inconnu/);
  });
});

describe("expériences et checkpoints", () => {
  const experiment: ExperimentRecord = {
    id: "exp-1" as ExperimentId,
    profileId: PROFILE,
    title: "Titre",
    question: "Question ?",
    status: "active",
    statusReason: "choisie",
    currentCheckpointId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  function checkpoint(id: string, sequence: number, session: SessionId): Checkpoint {
    return {
      schemaVersion: 1,
      id: id as CheckpointId,
      experimentId: experiment.id,
      sessionId: session,
      sequence,
      createdAt: ts("2026-10-29T13:00:00Z"),
      summary: "résumé",
      observations: [{ text: "fait", confidence: "observed" }],
      failures: [],
      artifacts: [
        {
          id: "a1" as ArtifactId,
          path: "notes/a.md" as ConfinedRelativePath,
          sha256: "0".repeat(64) as Sha256Hex,
          bytes: 12,
        },
      ],
      incompleteWork: ["suite"],
      nextAction: "relire",
      hibernationReason: "budget",
    };
  }

  it("garde une seule expérience active par profil", () => {
    store.uow.experiments.upsert(experiment);
    expect(store.uow.experiments.getActive(PROFILE)).toEqual(experiment);
    expect(() => {
      store.uow.experiments.upsert({ ...experiment, id: "exp-2" as ExperimentId });
    }).toThrow(/UNIQUE/);
  });

  it("publie un checkpoint comme courant, à séquence croissante", () => {
    store.uow.experiments.upsert(experiment);
    const session = openSession("s1");
    const first = checkpoint("cp-1", 1, session);
    store.uow.checkpoints.publish(first);
    expect(store.uow.checkpoints.get(first.id)).toEqual(first);
    expect(store.uow.experiments.get(experiment.id)?.currentCheckpointId).toBe("cp-1");
    expect(() => {
      store.uow.checkpoints.publish(checkpoint("cp-0", 1, session));
    }).toThrow(/non croissante/);
    store.uow.checkpoints.publish(checkpoint("cp-2", 2, session));
    expect(store.uow.checkpoints.latest(experiment.id)?.id).toBe("cp-2");
  });
});
