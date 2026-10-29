/**
 * Export, plafond de stockage et purge sur une vraie base SQLite : cohérence pendant une
 * écriture concurrente, absence de secrets témoins, compteurs de budget préservés,
 * saturation sans perte du dernier checkpoint.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterId,
  ArtifactId,
  Checkpoint,
  CheckpointId,
  ConfinedRelativePath,
  ExperimentId,
  ExperimentRecord,
  PolicyRevisionId,
  ReservationId,
  SessionId,
  Sha256Hex,
  UtcTimestamp,
} from "../contracts/index.js";
import { openStore, type Store } from "../store/index.js";
import { ALL_SECRETS, SECRET_TRAPS, SENSITIVE_KEY_TRAPS } from "../../test/fixtures/secrets.js";
import {
  authorize,
  createProfile,
  DAY_PARIS,
  LIMITS,
  PROFILE,
  tempDir,
  ts,
  type TempDir,
} from "../../test/fixtures/store-ledger/setup.js";
import {
  assessStorage,
  ExportError,
  exportData,
  handleStorageSaturation,
  MANIFEST_FILE,
  measureDataDir,
  planPurge,
  applyPurge,
  STATE_FILE,
  type ExportManifest,
} from "./index.js";

const NOW = ts("2026-10-29T12:00:00Z");

let dir: TempDir;
let store: Store;
let workspace: string;
let outside: string;

beforeEach(() => {
  dir = tempDir();
  store = openStore(dir.dbPath);
  createProfile(store.uow);
  workspace = path.join(dir.path, "workspace");
  fs.mkdirSync(workspace);
  outside = fs.mkdtempSync(path.join(path.dirname(dir.path), "mind-wake-outside-"));
});

afterEach(() => {
  store.close();
  dir.remove();
  fs.rmSync(outside, { recursive: true, force: true });
});

function sha(content: string): Sha256Hex {
  return createHash("sha256").update(content).digest("hex") as Sha256Hex;
}

function append(n: number, at: UtcTimestamp = NOW, sessionId?: SessionId): void {
  for (let i = 0; i < n; i++) {
    store.uow.journal.append({
      type: "action_allowed",
      at,
      profileId: PROFILE,
      ...(sessionId === undefined ? {} : { sessionId }),
      reason: `événement ${String(i)}`,
      metadata: {},
    });
  }
}

const EXPERIMENT: ExperimentRecord = {
  id: "exp-1" as ExperimentId,
  profileId: PROFILE,
  title: "petits systèmes émergents",
  question: "un automate simple produit-il des motifs stables ?",
  status: "active",
  statusReason: "choisie",
  currentCheckpointId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** Session close, réservation rapprochée : 1 200 tokens et 1 session imputés. */
function closedSession(id: string): SessionId {
  if (store.uow.policies.getRevision("rev-1" as PolicyRevisionId) === null) {
    authorize(store.uow, "rev-1");
  }
  const periodId = store.uow.ledger.ensurePeriod(PROFILE, DAY_PARIS, NOW, LIMITS).id;
  const reservationId = `res-${id}` as ReservationId;
  store.uow.ledger.reserve({
    id: reservationId,
    sessionId: id as SessionId,
    profileId: PROFILE,
    periodIds: [periodId],
    maxima: [
      { unit: "tokens", amount: 3_000 },
      { unit: "sessions", amount: 1 },
    ],
    at: NOW,
  });
  store.uow.sessions.create({
    id: id as SessionId,
    profileId: PROFILE,
    experimentId: EXPERIMENT.id,
    adapterId: "fake" as AdapterId,
    policyRevisionId: "rev-1" as PolicyRevisionId,
    reservationId,
    startedAt: NOW,
    endedAt: null,
    outcome: null,
    outcomeReason: null,
  });
  store.uow.ledger.reconcile(
    reservationId,
    [
      {
        reservationId,
        quantity: { unit: "tokens", amount: 1_200 },
        provenance: "simulated",
        recordedAt: NOW,
      },
      {
        reservationId,
        quantity: { unit: "sessions", amount: 1 },
        provenance: "simulated",
        recordedAt: NOW,
      },
    ],
    NOW,
  );
  store.uow.sessions.close(id as SessionId, "completed", "terminée", NOW);
  return id as SessionId;
}

function checkpoint(
  id: string,
  sequence: number,
  session: SessionId,
  artifacts: Checkpoint["artifacts"] = [],
  summary = "résumé",
): Checkpoint {
  return {
    schemaVersion: 1,
    id: id as CheckpointId,
    experimentId: EXPERIMENT.id,
    sessionId: session,
    sequence,
    createdAt: NOW,
    summary,
    observations: [{ text: "motif stable observé", confidence: "observed" }],
    failures: [],
    artifacts,
    incompleteWork: [],
    nextAction: "varier la règle",
    hibernationReason: "budget de session atteint",
  };
}

function artifact(id: string, relative: string, content: string): Checkpoint["artifacts"][number] {
  const full = path.join(workspace, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return {
    id: id as ArtifactId,
    path: relative as ConfinedRelativePath,
    sha256: sha(content),
    bytes: Buffer.byteLength(content),
  };
}

function runExport(target: string, onSnapshotOpen?: () => void): ExportManifest {
  return exportData({
    dbPath: dir.dbPath,
    dataDir: dir.path,
    target,
    artifactsRoot: workspace,
    now: new Date(NOW),
    ...(onSnapshotOpen === undefined ? {} : { onSnapshotOpen }),
  }).manifest;
}

type StateFile = { tables: Record<string, Record<string, unknown>[]> };

function readState(target: string): StateFile {
  return JSON.parse(fs.readFileSync(path.join(target, STATE_FILE), "utf8")) as StateFile;
}

function allText(root: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else parts.push(fs.readFileSync(full, "latin1"));
    }
  };
  walk(root);
  return parts.join("\n");
}

describe("export cohérent", () => {
  it("ignore une écriture concurrente validée pendant la lecture", () => {
    append(5);
    const target = path.join(outside, "export-1");
    let concurrentSequence = 0;
    const manifest = runExport(target, () => {
      // Deuxième connexion : écrit et valide pendant que l'instantané est ouvert.
      const writer = openStore(dir.dbPath);
      try {
        for (let i = 0; i < 20; i++) {
          concurrentSequence = writer.uow.journal.append({
            type: "error",
            at: NOW,
            profileId: PROFILE,
            reason: "écriture concurrente",
            metadata: {},
          }).sequence;
        }
        writer.uow.profiles.transition(PROFILE, {
          from: "disabled",
          to: "ready",
          reason: "concurrent",
          at: NOW,
        });
      } finally {
        writer.close();
      }
    });

    const state = readState(target);
    const events = state.tables["journal_events"] ?? [];
    const sequences = state.tables["journal_sequences"] ?? [];
    expect(events).toHaveLength(5);
    // Séquence et événements issus du même instantané.
    expect(sequences).toEqual([{ profile_id: PROFILE, last_sequence: 5 }]);
    expect(state.tables["profiles"]?.[0]).toMatchObject({ state: "disabled" });
    expect(manifest.source.tables["journal_events"]).toBe(5);
    expect(manifest.consistency).toBe("sqlite_read_transaction");
    // L'écriture concurrente a bien été validée dans la base.
    expect(concurrentSequence).toBe(25);
    expect(store.uow.journal.list(PROFILE)).toHaveLength(25);
  });

  it("produit un manifeste versionné dont les empreintes correspondent aux fichiers", () => {
    store.uow.experiments.upsert(EXPERIMENT);
    const session = closedSession("s1");
    store.uow.checkpoints.publish(
      checkpoint("cp-1", 1, session, [artifact("a1", "notes/a.md", "observation\n")]),
    );
    const target = path.join(outside, "export-2");
    const manifest = runExport(target);
    expect(manifest).toMatchObject({
      schema: "mind-wake.export",
      schemaVersion: 1,
      artifacts: { copied: 1, excluded: [] },
    });
    for (const file of manifest.files) {
      const content = fs.readFileSync(path.join(target, ...file.path.split("/")));
      expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256);
      expect(content.length).toBe(file.bytes);
    }
    expect(fs.existsSync(path.join(target, MANIFEST_FILE))).toBe(true);
    // Aucun dossier temporaire laissé à côté de la cible.
    expect(fs.readdirSync(outside)).toEqual(["export-2"]);
  });

  it("ne remet aucun compteur de budget à zéro", () => {
    store.uow.experiments.upsert(EXPERIMENT);
    closedSession("s1");
    const periodId = store.uow.ledger.ensurePeriod(PROFILE, DAY_PARIS, NOW, LIMITS).id;
    const before = store.uow.ledger.availability(periodId, "tokens");
    const target = path.join(outside, "export-3");
    const manifest = runExport(target);

    expect(store.uow.ledger.availability(periodId, "tokens")).toEqual(before);
    expect(before.reconciled).toBe(1_200);
    expect(manifest.budget.reservations).toEqual({ reconciled: 1 });
    expect(manifest.budget.charges).toEqual(
      expect.arrayContaining([
        { unit: "tokens", qualifier: "", amount: 1_200 },
        { unit: "sessions", qualifier: "", amount: 1 },
      ]),
    );
    const state = readState(target);
    expect(state.tables["reservation_charges"]).toHaveLength(2);
    expect(state.tables["reservations"]?.[0]).toMatchObject({ status: "reconciled" });
  });

  it("refuse une cible existante ou située dans le dossier de données", () => {
    fs.mkdirSync(path.join(outside, "existe"));
    expect(() => runExport(path.join(outside, "existe"))).toThrow(ExportError);
    expect(() => runExport(path.join(dir.path, "export"))).toThrow(/dossier de données/);
    expect(fs.existsSync(path.join(dir.path, "export"))).toBe(false);
  });
});

describe("export expurgé", () => {
  const WITNESS_ENV = "MIND_WAKE_EXPORT_TEMOIN";
  const WITNESS_VALUE = "temoin-env-3f9c2a71b8";

  afterEach(() => {
    Reflect.deleteProperty(process.env, WITNESS_ENV);
  });

  it("n'exporte aucun secret témoin ni variable d'environnement", () => {
    process.env[WITNESS_ENV] = WITNESS_VALUE;
    store.uow.experiments.upsert(EXPERIMENT);
    const session = closedSession("s1");
    const secretText = SECRET_TRAPS.map((trap) => trap.text).join("\n");

    // Secrets écrits sans passer par l'expurgation du JournalWriter.
    store.db
      .prepare(
        `INSERT INTO journal_sequences (profile_id, last_sequence) VALUES (?, 1)
         ON CONFLICT (profile_id) DO UPDATE SET last_sequence = last_sequence + 1`,
      )
      .run(PROFILE);
    const sequence = (
      store.db
        .prepare("SELECT last_sequence FROM journal_sequences WHERE profile_id = ?")
        .get(PROFILE) as { last_sequence: number }
    ).last_sequence;
    store.db
      .prepare(
        `INSERT INTO journal_events (profile_id, sequence, schema_version, type, at, reason, metadata_json)
         VALUES (?, ?, 1, 'error', ?, ?, ?)`,
      )
      .run(PROFILE, sequence, NOW, secretText, JSON.stringify(SENSITIVE_KEY_TRAPS));

    store.uow.checkpoints.publish(
      checkpoint(
        "cp-1",
        1,
        session,
        [
          artifact("ok", "notes/propre.md", "rien de sensible ici\n"),
          artifact("leak", "notes/fuite.md", `config\n${secretText}\n`),
        ],
        `mémoire : ${secretText}`,
      ),
    );

    const target = path.join(outside, "export-secrets");
    const manifest = runExport(target);
    const text = allText(target);
    for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain(WITNESS_VALUE);
    expect(text).not.toContain(WITNESS_ENV);
    expect(manifest.redaction).toEqual({
      secrets: "heuristic",
      environment: "excluded",
      credentials: "never_stored",
    });
    expect(manifest.artifacts).toEqual({
      copied: 1,
      excluded: [{ path: "notes/fuite.md", reason: "contains_secret" }],
    });
    // La base d'origine n'est pas modifiée par l'expurgation.
    expect(
      (
        store.db.prepare("SELECT reason FROM journal_events WHERE sequence = ?").get(sequence) as {
          reason: string;
        }
      ).reason,
    ).toBe(secretText);
  });

  it("exclut un artefact altéré, absent, ou atteint par un lien hors de l'espace", () => {
    store.uow.experiments.upsert(EXPERIMENT);
    const session = closedSession("s1");
    const altered = artifact("alt", "alt.md", "version validée");
    fs.writeFileSync(path.join(workspace, "alt.md"), "version modifiée après checkpoint");
    const missing = artifact("gone", "gone.md", "x");
    fs.rmSync(path.join(workspace, "gone.md"));
    fs.writeFileSync(path.join(outside, "hors.md"), "hors de l'espace");
    fs.symlinkSync(outside, path.join(workspace, "lien"), "junction");
    const linked: Checkpoint["artifacts"][number] = {
      id: "link" as ArtifactId,
      path: "lien/hors.md" as ConfinedRelativePath,
      sha256: sha("hors de l'espace"),
      bytes: 16,
    };
    store.uow.checkpoints.publish(checkpoint("cp-1", 1, session, [altered, missing, linked]));

    const manifest = runExport(path.join(outside, "export-art"));
    expect(manifest.artifacts.copied).toBe(0);
    expect(manifest.artifacts.excluded).toEqual(
      expect.arrayContaining([
        { path: "alt.md", reason: "integrity_mismatch" },
        { path: "gone.md", reason: "missing" },
        { path: "lien/hors.md", reason: "link_refused" },
      ]),
    );
  });
});

describe("plafond de stockage", () => {
  function readyProfileWithCheckpoint(): void {
    store.uow.experiments.upsert(EXPERIMENT);
    const session = closedSession("s1");
    store.uow.checkpoints.publish(
      checkpoint("cp-1", 1, session, [artifact("a1", "notes/a.md", "x".repeat(4_096))]),
    );
    store.uow.checkpoints.publish(checkpoint("cp-2", 2, session));
    store.uow.profiles.transition(PROFILE, {
      from: "disabled",
      to: "ready",
      reason: "test",
      at: NOW,
    });
  }

  it("bloque à saturation sans supprimer la mémoire ni le dernier checkpoint", () => {
    readyProfileWithCheckpoint();
    const usage = measureDataDir(dir.path);
    const files = fs.readdirSync(workspace, { recursive: true });
    const assessment = assessStorage(usage, 1_000);
    expect(assessment.status).toBe("saturated");

    const outcome = handleStorageSaturation(store.uow, PROFILE, assessment, NOW);
    expect(outcome).toMatchObject({ action: "blocked" });
    const profile = store.uow.profiles.get(PROFILE);
    expect(profile?.state).toBe("blocked");
    expect(profile?.stateReason).toMatch(/stockage local saturé.*aucune donnée supprimée/);
    expect(store.uow.checkpoints.latest(EXPERIMENT.id)?.id).toBe("cp-2");
    expect(store.uow.checkpoints.get("cp-1" as CheckpointId)).not.toBeNull();
    expect(store.uow.experiments.get(EXPERIMENT.id)?.currentCheckpointId).toBe("cp-2");
    expect(fs.readdirSync(workspace, { recursive: true })).toEqual(files);
    expect(measureDataDir(dir.path).files).toBeGreaterThanOrEqual(usage.files);
    expect(store.uow.journal.list(PROFILE).at(-1)).toMatchObject({
      type: "profile_state_changed",
      metadata: { cause: "storage_cap", from: "ready", to: "blocked" },
    });
  });

  it("laisse le runner terminer son checkpoint pendant une session", () => {
    readyProfileWithCheckpoint();
    store.uow.profiles.transition(PROFILE, {
      from: "ready",
      to: "running",
      reason: "test",
      at: NOW,
    });
    const outcome = handleStorageSaturation(
      store.uow,
      PROFILE,
      assessStorage(measureDataDir(dir.path), 1),
      NOW,
    );
    expect(outcome.action).toBe("checkpoint_then_block");
    expect(store.uow.profiles.get(PROFILE)?.state).toBe("running");
  });

  it("traite un plafond absent comme inconnu, jamais comme de la place libre", () => {
    expect(assessStorage(measureDataDir(dir.path), null).status).toBe("no_cap");
    expect(assessStorage(measureDataDir(dir.path), 0).status).toBe("no_cap");
  });

  it("ne suit pas les jonctions pour mesurer l'usage", () => {
    fs.writeFileSync(path.join(outside, "gros.bin"), Buffer.alloc(200_000));
    const before = measureDataDir(dir.path);
    fs.symlinkSync(outside, path.join(dir.path, "jonction"), "junction");
    const after = measureDataDir(dir.path);
    expect(after.bytes).toBe(before.bytes);
    expect(after.links).toBe(before.links + 1);
  });
});

describe("purge du journal", () => {
  it("supprime le préfixe expiré, protège les sessions ouvertes et garde les checkpoints", () => {
    store.uow.experiments.upsert(EXPERIMENT);
    const closed = closedSession("s1");
    store.uow.checkpoints.publish(checkpoint("cp-1", 1, closed));
    const old = ts("2026-01-10T00:00:00Z");
    append(4, old);
    append(2, NOW);
    const all = store.uow.journal.list(PROFILE);
    const rule = { retentionDays: 30, automatic: false };
    const plan = planPurge(store.db, all, PROFILE, rule, new Date(NOW));
    expect(plan.purgeCount).toBe(4);

    const outcome = applyPurge(store.db, store.uow, PROFILE, plan, "option", NOW);
    expect(outcome.deletedEvents).toBe(4);
    const remaining = store.uow.journal.list(PROFILE);
    expect(remaining.map((e) => e.sequence)).toEqual([5, 6, 7]);
    expect(remaining.at(-1)).toMatchObject({
      type: "data_purged",
      metadata: { deletedEvents: 4, throughSequence: 4 },
    });
    expect(store.uow.checkpoints.latest(EXPERIMENT.id)?.id).toBe("cp-1");
    // La séquence ne recule jamais après une purge.
    expect(
      store.uow.journal.append({
        type: "error",
        at: NOW,
        profileId: PROFILE,
        reason: "suite",
        metadata: {},
      }).sequence,
    ).toBe(8);
  });

  it("s'arrête au premier événement d'une session ouverte", () => {
    authorize(store.uow, "rev-1");
    const periodId = store.uow.ledger.ensurePeriod(PROFILE, DAY_PARIS, NOW, LIMITS).id;
    store.uow.ledger.reserve({
      id: "res-open" as ReservationId,
      sessionId: "open" as SessionId,
      profileId: PROFILE,
      periodIds: [periodId],
      maxima: [{ unit: "sessions", amount: 1 }],
      at: NOW,
    });
    store.uow.sessions.create({
      id: "open" as SessionId,
      profileId: PROFILE,
      experimentId: null,
      adapterId: "fake" as AdapterId,
      policyRevisionId: "rev-1" as PolicyRevisionId,
      reservationId: "res-open" as ReservationId,
      startedAt: NOW,
      endedAt: null,
      outcome: null,
      outcomeReason: null,
    });
    const old = ts("2026-01-10T00:00:00Z");
    append(2, old);
    append(1, old, "open" as SessionId);
    append(2, old);
    const plan = planPurge(
      store.db,
      store.uow.journal.list(PROFILE),
      PROFILE,
      { retentionDays: 30, automatic: false },
      new Date(NOW),
    );
    expect(plan).toMatchObject({ purgeCount: 2, stoppedBy: { kind: "protected_session" } });
  });
});
