/**
 * Verrou d'instance par profil : un seul scheduler actif (AGENTS §5 « Daemon »).
 *
 * Le verrou est un fichier SQLite ouvert en `locking_mode = EXCLUSIVE` après une
 * écriture : la connexion garde le verrou exclusif du système de fichiers jusqu'à sa
 * fermeture. Le système le libère à la mort du processus, y compris après un crash ou
 * un arrêt forcé : aucun verrou périmé à nettoyer, aucun PID à interpréter.
 *
 * Le détenteur doit garder une référence à l'objet retourné tant qu'il veut le verrou :
 * une connexion collectée par le ramasse-miettes est fermée, ce qui le relâche.
 *
 * Ce verrou n'est pas la seule barrière contre un double lancement : la réservation
 * transactionnelle du ledger et l'index `sessions_one_open` la complètent.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ProfileId } from "../contracts/index.js";

export class InstanceLockError extends Error {
  override readonly name = "InstanceLockError";
  readonly code: "held" | "lost";

  constructor(code: "held" | "lost", message: string) {
    super(message);
    this.code = code;
  }
}

export interface InstanceLock {
  readonly path: string;
  isHeld(): boolean;
  /** Lève `InstanceLockError("lost")` si le verrou a été relâché. */
  assertHeld(): void;
  release(): void;
}

/** Chemin du verrou d'un profil dans le répertoire de données. */
export function instanceLockPath(dataDir: string, profileId: ProfileId): string {
  const digest = createHash("sha256").update(profileId).digest("hex").slice(0, 16);
  return join(dataDir, `scheduler-${digest}.lock`);
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
}

/**
 * Prend le verrou sans attendre. Lève `InstanceLockError("held")` si une autre instance,
 * dans ce processus ou un autre, le détient.
 */
export function acquireInstanceLock(path: string): InstanceLock {
  const db = new Database(path, { timeout: 0 });
  try {
    db.pragma("busy_timeout = 0");
    db.pragma("locking_mode = EXCLUSIVE");
    db.pragma("journal_mode = DELETE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec(
      "CREATE TABLE IF NOT EXISTS lock_owner (pid INTEGER NOT NULL, acquired_at TEXT NOT NULL)",
    );
    db.exec("DELETE FROM lock_owner");
    db.prepare("INSERT INTO lock_owner (pid, acquired_at) VALUES (?, ?)").run(
      process.pid,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.close();
    if (isBusy(error)) {
      throw new InstanceLockError("held", `verrou d'instance déjà détenu : ${path}`);
    }
    throw error;
  }
  return {
    path,
    isHeld: () => db.open,
    assertHeld: () => {
      if (!db.open) throw new InstanceLockError("lost", `verrou d'instance relâché : ${path}`);
    },
    release: () => {
      if (db.open) db.close();
    },
  };
}
