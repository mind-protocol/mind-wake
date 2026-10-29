/**
 * Plafond de stockage local (`data.localStorageCapBytes`, SPEC §4 et §9). À saturation,
 * le profil se bloque ou reste en hibernation avec un motif ; rien n'est supprimé : ni
 * la mémoire courante, ni le dernier checkpoint, ni le journal. Libérer de la place
 * reste une décision humaine (`purge`, plafond relevé par une nouvelle révision).
 */

import fs from "node:fs";
import path from "node:path";
import type { ProfileId, ProfileState, UnitOfWork, UtcTimestamp } from "../contracts/index.js";
import { JournalWriter } from "../journal/index.js";

export interface StorageUsage {
  /** Octets des fichiers ordinaires du dossier de données (liens non suivis). */
  readonly bytes: number;
  readonly files: number;
  /** Liens symboliques et jonctions rencontrés : comptés mais jamais suivis. */
  readonly links: number;
}

/**
 * Mesure le dossier de données sans suivre les liens : une jonction vers un autre
 * disque ne gonfle pas l'usage et n'est pas parcourue. Dossier absent : usage nul.
 */
export function measureDataDir(dataDir: string): StorageUsage {
  let bytes = 0;
  let files = 0;
  let links = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stats = fs.lstatSync(full, { throwIfNoEntry: false });
      if (stats === undefined) continue;
      if (stats.isSymbolicLink()) links += 1;
      else if (stats.isDirectory()) walk(full);
      else if (stats.isFile()) {
        bytes += stats.size;
        files += 1;
      }
    }
  };
  if (fs.lstatSync(dataDir, { throwIfNoEntry: false })?.isDirectory() === true) walk(dataDir);
  return { bytes, files, links };
}

/** Au-delà de cette part du plafond, l'état est signalé comme proche de la saturation. */
export const STORAGE_WARNING_RATIO = 0.9;

export type StorageAssessment =
  | { readonly status: "no_cap"; readonly usage: StorageUsage; readonly detail: string }
  | {
      readonly status: "ok" | "near_cap" | "saturated";
      readonly usage: StorageUsage;
      readonly capBytes: number;
      readonly detail: string;
    };

/** Plafond absent ou invalide : inconnu, donc jamais traité comme de la place libre. */
export function assessStorage(usage: StorageUsage, capBytes: number | null): StorageAssessment {
  if (capBytes === null || !Number.isSafeInteger(capBytes) || capBytes < 1) {
    return {
      status: "no_cap",
      usage,
      detail: "aucun plafond de stockage consenti : place disponible inconnue",
    };
  }
  const used = `${String(usage.bytes)} octets sur ${String(capBytes)}`;
  if (usage.bytes >= capBytes) {
    return { status: "saturated", usage, capBytes, detail: `stockage local saturé : ${used}` };
  }
  if (usage.bytes >= capBytes * STORAGE_WARNING_RATIO) {
    return { status: "near_cap", usage, capBytes, detail: `stockage proche du plafond : ${used}` };
  }
  return { status: "ok", usage, capBytes, detail: `stockage : ${used}` };
}

/**
 * Réponse à une saturation selon l'état du profil :
 * - `blocked` : `ready` → `blocked`, avec motif ;
 * - `checkpoint_then_block` : session en cours ; le runner termine son checkpoint dans
 *   l'enveloppe réservée, puis bloque. Interrompre ici ferait perdre ce checkpoint ;
 * - `kept` : profil déjà inactif (hibernation, pause, arrêt, désactivé, bloqué), qui
 *   ne repartira pas tant que les contrôles revérifient le stockage ;
 * - `none` : pas de saturation.
 */
export type SaturationOutcome =
  | { readonly action: "none" }
  | { readonly action: "blocked"; readonly reason: string }
  | { readonly action: "checkpoint_then_block"; readonly reason: string }
  | { readonly action: "kept"; readonly state: ProfileState; readonly reason: string };

const SATURATION_HINT =
  "aucune donnée supprimée ; libérer de la place (`mind-wake purge`) ou relever le plafond par une nouvelle révision";

/**
 * Applique la réponse à une saturation dans une transaction. Ne supprime jamais rien :
 * la mémoire courante et le dernier checkpoint restent intacts.
 */
export function handleStorageSaturation(
  uow: UnitOfWork,
  profileId: ProfileId,
  assessment: StorageAssessment,
  at: UtcTimestamp,
): SaturationOutcome {
  if (assessment.status !== "saturated") return { action: "none" };
  const reason = `${assessment.detail} ; ${SATURATION_HINT}`;
  return uow.transaction((tx) => {
    const profile = tx.profiles.get(profileId);
    if (profile === null) return { action: "none" } as const;
    const journal = new JournalWriter(tx.journal);
    const metadata = {
      cause: "storage_cap",
      usedBytes: assessment.usage.bytes,
      capBytes: assessment.capBytes,
    };
    switch (profile.state) {
      case "ready":
        tx.profiles.transition(profileId, { from: "ready", to: "blocked", reason, at });
        journal.record({
          type: "profile_state_changed",
          at,
          profileId,
          reason,
          metadata: { ...metadata, from: "ready", to: "blocked" },
        });
        return { action: "blocked", reason } as const;
      case "running":
      case "checkpointing":
        journal.record({
          type: "action_denied",
          at,
          profileId,
          reason: `${reason} ; checkpoint puis blocage`,
          metadata: { ...metadata, action: "continue_session", state: profile.state },
        });
        return { action: "checkpoint_then_block", reason } as const;
      default:
        journal.record({
          type: "action_denied",
          at,
          profileId,
          reason,
          metadata: { ...metadata, action: "wake", state: profile.state },
        });
        return { action: "kept", state: profile.state, reason } as const;
    }
  });
}
