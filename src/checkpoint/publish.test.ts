/**
 * Publication transactionnelle, refus journalisés, crash entre écriture et
 * enregistrement (en processus réel), réconciliation au redémarrage.
 */

import { spawn } from "node:child_process";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CrashArgs } from "../../test/fixtures/checkpoint/crash-child.js";
import {
  EXPERIMENT,
  NOW,
  SESSION,
  candidate,
  seed,
  workspace,
  type Workspace,
} from "../../test/fixtures/checkpoint/setup.js";
import { SECRET_TRAPS } from "../../test/fixtures/secrets.js";
import { PROFILE } from "../../test/fixtures/store-ledger/setup.js";
import type {
  ArtifactId,
  CheckpointId,
  ConfinedRelativePath,
  SessionId,
  Sha256Hex,
} from "../contracts/index.js";
import { openStore, type Store } from "../store/index.js";
import {
  openRoot,
  publishCheckpoint,
  reconcileArtifacts,
  writeArtifactAtomic,
  type ConfinedRoot,
  type PublishContext,
} from "./index.js";

let ws: Workspace;
let store: Store;
let root: ConfinedRoot;

beforeEach(() => {
  ws = workspace();
  store = openStore(ws.dbPath);
  seed(store.uow);
  root = openRoot(ws.artifacts);
});

afterEach(() => {
  store.close();
  ws.remove();
});

function context(overrides: Partial<PublishContext> = {}): PublishContext {
  let n = 0;
  return {
    uow: store.uow,
    root,
    profileId: PROFILE,
    sessionId: SESSION,
    now: () => NOW,
    newId: () => `cp-${String(++n)}-${String(Date.now())}` as CheckpointId,
    ...overrides,
  };
}

function journalTypes(): readonly string[] {
  return store.uow.journal.list(PROFILE).map((e) => e.type);
}

describe("publication", () => {
  it("publie après vérification des artefacts, à séquence croissante, avec journal", () => {
    const ref = writeArtifactAtomic(root, "runs/r1.txt", "résultat 1", { id: "r1" as ArtifactId });
    const first = publishCheckpoint(context(), candidate({ artifacts: [ref] }));
    expect(first.status).toBe("published");
    if (first.status !== "published") return;
    expect(first.checkpoint.sequence).toBe(1);
    expect(store.uow.checkpoints.latest(EXPERIMENT)).toEqual(first.checkpoint);
    expect(store.uow.experiments.get(EXPERIMENT)?.currentCheckpointId).toBe(first.checkpoint.id);

    const second = publishCheckpoint(context(), candidate({ summary: "Suite." }));
    expect(second.status === "published" && second.checkpoint.sequence).toBe(2);
    expect(journalTypes().filter((t) => t === "checkpoint_published")).toHaveLength(2);
  });

  it("refuse un checkpoint invalide, le journalise et ne publie rien", () => {
    const result = publishCheckpoint(context(), { ...candidate(), schemaVersion: 9 });
    expect(result).toMatchObject({ status: "rejected", reasons: ["unsupported_schema_version"] });
    expect(store.uow.checkpoints.latest(EXPERIMENT)).toBeNull();
    expect(journalTypes()).toContain("checkpoint_rejected");
  });

  it("refuse un candidat qui désigne une autre session ou une autre expérience", () => {
    expect(
      publishCheckpoint(context(), candidate({ sessionId: "session-x" as SessionId })),
    ).toMatchObject({ status: "rejected", reasons: ["malformed"] });
    expect(
      publishCheckpoint(context(), candidate({ experimentId: "exp-x" as typeof EXPERIMENT })),
    ).toMatchObject({ status: "rejected", reasons: ["malformed"] });
    expect(store.uow.checkpoints.latest(EXPERIMENT)).toBeNull();
  });

  it("refuse après la fin de la session", () => {
    store.uow.sessions.close(SESSION, "interrupted", "kill switch", NOW);
    expect(publishCheckpoint(context(), candidate())).toMatchObject({ status: "rejected" });
  });

  it("refuse un artefact absent, altéré ou atteint par une jonction", () => {
    const ref = writeArtifactAtomic(root, "runs/r1.txt", "contenu", { id: "r1" as ArtifactId });
    const missing = {
      ...ref,
      id: "m" as ArtifactId,
      path: "runs/absent.txt" as ConfinedRelativePath,
    };
    const altered = { ...ref, sha256: "f".repeat(64) as Sha256Hex };
    writeFileSync(join(ws.outside, "x.txt"), "contenu");
    symlinkSync(ws.outside, join(ws.artifacts, "j"), "junction");
    const escaped = { ...ref, id: "j" as ArtifactId, path: "j/x.txt" as ConfinedRelativePath };
    expect(publishCheckpoint(context(), candidate({ artifacts: [missing] }))).toMatchObject({
      reasons: ["missing_artifact"],
    });
    expect(publishCheckpoint(context(), candidate({ artifacts: [altered] }))).toMatchObject({
      reasons: ["integrity_mismatch"],
    });
    expect(publishCheckpoint(context(), candidate({ artifacts: [escaped] }))).toMatchObject({
      reasons: ["path_escape"],
    });
    expect(store.uow.checkpoints.latest(EXPERIMENT)).toBeNull();
  });

  it("ne recopie aucun secret dans le journal de refus", () => {
    for (const trap of SECRET_TRAPS) {
      publishCheckpoint(context(), candidate({ failures: [trap.text] }));
    }
    const journal = JSON.stringify(store.uow.journal.list(PROFILE));
    for (const trap of SECRET_TRAPS) expect(journal).not.toContain(trap.secret);
  });

  it("annule tout si la transaction échoue : ni checkpoint, ni journal, ni courant", () => {
    const ref = writeArtifactAtomic(root, "runs/r1.txt", "contenu", { id: "r1" as ArtifactId });
    expect(() =>
      publishCheckpoint(
        context({
          beforeCommit: () => {
            throw new Error("panne simulée avant validation");
          },
        }),
        candidate({ artifacts: [ref] }),
      ),
    ).toThrow(/panne simulée/);
    expect(store.uow.checkpoints.latest(EXPERIMENT)).toBeNull();
    expect(store.uow.experiments.get(EXPERIMENT)?.currentCheckpointId).toBeNull();
    expect(journalTypes()).not.toContain("checkpoint_published");
    // L'artefact écrit reste sur le disque, sans référence : la réconciliation le signale.
    expect(reconcileArtifacts(store.db, root, PROFILE).anomalies).toEqual([
      { kind: "unreferenced", path: "runs/r1.txt" },
    ]);
  });
});

describe("réconciliation au redémarrage", () => {
  it("ne signale rien quand fichiers et références concordent", () => {
    const ref = writeArtifactAtomic(root, "runs/r1.txt", "contenu", { id: "r1" as ArtifactId });
    publishCheckpoint(context(), candidate({ artifacts: [ref] }));
    expect(reconcileArtifacts(store.db, root, PROFILE)).toEqual({
      referenced: 1,
      scannedFiles: 1,
      truncated: false,
      anomalies: [],
    });
  });

  it("détecte référence manquante, altération, lien, fichier orphelin et temporaire", () => {
    const a = writeArtifactAtomic(root, "runs/a.txt", "a", { id: "a" as ArtifactId });
    const b = writeArtifactAtomic(root, "runs/b.txt", "b", { id: "b" as ArtifactId });
    publishCheckpoint(context(), candidate({ artifacts: [a, b] }));
    rmSync(join(ws.artifacts, "runs", "a.txt"));
    writeFileSync(join(ws.artifacts, "runs", "b.txt"), "modifié hors daemon");
    writeFileSync(join(ws.artifacts, "orphan.txt"), "jamais référencé");
    writeFileSync(join(ws.artifacts, ".mw-tmp-0000"), "écriture interrompue");
    symlinkSync(ws.outside, join(ws.artifacts, "j"), "junction");
    const report = reconcileArtifacts(store.db, root, PROFILE);
    expect(report.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "missing", path: "runs/a.txt", sequence: 1 }),
        expect.objectContaining({ kind: "integrity_mismatch", path: "runs/b.txt" }),
        { kind: "unreferenced", path: "orphan.txt" },
        { kind: "interrupted_write", path: ".mw-tmp-0000" },
        { kind: "link", path: "j" },
      ]),
    );
    expect(report.anomalies).toHaveLength(5);
  });

  it("ne supprime rien", () => {
    writeFileSync(join(ws.artifacts, "orphan.txt"), "x");
    reconcileArtifacts(store.db, root, PROFILE);
    expect(reconcileArtifacts(store.db, root, PROFILE).anomalies).toEqual([
      { kind: "unreferenced", path: "orphan.txt" },
    ]);
  });
});

describe("crash réel en processus enfant", () => {
  const FIXTURES = fileURLToPath(new URL("../../test/fixtures/", import.meta.url));
  const HOOKS = pathToFileURL(join(FIXTURES, "store-ledger", "ts-hooks.ts")).href;
  const CHILD = join(FIXTURES, "checkpoint", "crash-child.ts");

  function runChild(mode: CrashArgs["mode"]): Promise<number | null> {
    const args: CrashArgs = { mode, dbPath: ws.dbPath, artifacts: ws.artifacts };
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-transform-types",
        "--import",
        HOOKS,
        CHILD,
        JSON.stringify(args),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    return new Promise((resolve) => {
      child.on("exit", (code) => {
        if (code !== 42) console.error(stderr);
        resolve(code);
      });
    });
  }

  it("crash dans la transaction, après écriture de l'artefact : rien de publié, orphelin détecté", async () => {
    store.close();
    expect(await runChild("before-commit")).toBe(42);
    store = openStore(ws.dbPath);
    expect(store.uow.checkpoints.latest(EXPERIMENT)).toBeNull();
    expect(store.uow.journal.list(PROFILE).map((e) => e.type)).not.toContain(
      "checkpoint_published",
    );
    expect(reconcileArtifacts(store.db, root, PROFILE).anomalies).toEqual([
      { kind: "unreferenced", path: "runs/crash.txt" },
    ]);
  }, 30_000);

  it("crash pendant l'écriture atomique : seul un temporaire subsiste, signalé", async () => {
    store.close();
    expect(await runChild("before-rename")).toBe(42);
    store = openStore(ws.dbPath);
    const report = reconcileArtifacts(store.db, root, PROFILE);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({ kind: "interrupted_write" });
    expect(report.anomalies[0]?.path).toMatch(/^runs\/\.mw-tmp-/);
    expect(store.uow.checkpoints.latest(EXPERIMENT)).toBeNull();
  }, 30_000);

  it("le dernier checkpoint valide survit à un crash pendant le suivant", async () => {
    const published = publishCheckpoint(context(), candidate({ summary: "État A valide." }));
    expect(published.status).toBe("published");
    store.close();
    expect(await runChild("before-commit")).toBe(42);
    store = openStore(ws.dbPath);
    expect(store.uow.checkpoints.latest(EXPERIMENT)).toMatchObject({
      sequence: 1,
      summary: "État A valide.",
    });
  }, 30_000);
});
