/**
 * Désinstallation (AGENTS §6.8, SPEC §8.3). Ce build n'installe ni daemon, ni tâche
 * planifiée, ni clé de démarrage, ni service : il n'y a rien à arrêter ni à retirer, et
 * le plan le dit. Le seul effet possible est la suppression du dossier de données,
 * après un choix explicite de l'humain.
 *
 * Confinement : rien n'est jamais touché hors du dossier de données. Les liens et
 * jonctions qu'il contient sont retirés comme liens, sans jamais parcourir ni modifier
 * leur cible.
 */

import fs from "node:fs";
import path from "node:path";

export type DataChoice = "keep" | "delete";

export type UninstallEffectKind =
  "stop_daemon" | "remove_launch_mechanism" | "keep_data" | "delete_data" | "remove_package";

export interface UninstallEffect {
  readonly kind: UninstallEffectKind;
  /** `true` si l'effet modifie quelque chose quand il est appliqué. */
  readonly changes: boolean;
  readonly detail: string;
}

export interface UninstallPlan {
  readonly dataDir: string;
  readonly dataDirExists: boolean;
  readonly choice: DataChoice;
  readonly effects: readonly UninstallEffect[];
  /** Motif de refus de la suppression, ou `null` si elle est possible. */
  readonly refusal: string | null;
  readonly entries: number;
}

/** Fichiers qu'un dossier de données MIND Wake contient forcément s'il est utilisé. */
export const DATA_DIR_MARKERS: readonly string[] = ["control.sqlite"];

export const NO_DAEMON = "aucun daemon n'existe dans ce build : aucun processus à arrêter";
export const NO_LAUNCH_MECHANISM =
  "aucun mécanisme de lancement (tâche planifiée, clé Run, service) n'est installé par ce build : rien à retirer";
export const PACKAGE_NOTE =
  "la CLI elle-même n'est pas retirée par cette commande ; aucun installateur n'existe encore";
export const DELETE_NOTE =
  "suppression logique des fichiers : aucun effacement physique sécurisé du disque n'est promis";

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  return norm(a) === norm(b);
}

function isAncestorOrSame(ancestor: string, child: string): boolean {
  const norm = (p: string): string =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  const relative = path.relative(norm(ancestor), norm(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Refuse de supprimer un dossier qui ne ressemble pas à un dossier de données : racine
 * de volume, dossier personnel ou un de ses parents, dossier courant ou un de ses
 * parents, lien, ou dossier non vide sans base de contrôle.
 */
export interface UninstallEnvironment {
  readonly cwd: string;
  readonly homeDir: string;
}

export function deletionRefusal(dataDir: string, env: UninstallEnvironment): string | null {
  const resolved = path.resolve(dataDir);
  const stats = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (stats.isSymbolicLink()) return "le dossier de données est un lien : suppression refusée";
  if (!stats.isDirectory()) return "le chemin n'est pas un dossier : suppression refusée";
  if (path.parse(resolved).root === resolved || samePath(resolved, path.parse(resolved).root)) {
    return "racine d'un volume : suppression refusée";
  }
  if (isAncestorOrSame(resolved, env.homeDir)) {
    return "dossier personnel ou parent : suppression refusée";
  }
  if (isAncestorOrSame(resolved, env.cwd)) {
    return "dossier courant ou parent : suppression refusée";
  }
  const entries = fs.readdirSync(resolved);
  if (entries.length > 0 && !DATA_DIR_MARKERS.some((marker) => entries.includes(marker))) {
    return "dossier non vide sans base de contrôle MIND Wake : suppression refusée pour ne rien toucher d'autre";
  }
  return null;
}

function countEntries(dir: string): number {
  let count = 0;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      count += 1;
      const full = path.join(current, entry.name);
      const stats = fs.lstatSync(full, { throwIfNoEntry: false });
      if (stats?.isDirectory() === true && !stats.isSymbolicLink()) walk(full);
    }
  };
  walk(dir);
  return count;
}

export function planUninstall(
  dataDir: string,
  choice: DataChoice,
  env: UninstallEnvironment,
): UninstallPlan {
  const resolved = path.resolve(dataDir);
  const exists = fs.lstatSync(resolved, { throwIfNoEntry: false })?.isDirectory() === true;
  const refusal = choice === "delete" ? deletionRefusal(resolved, env) : null;
  const entries = exists && refusal === null ? countEntries(resolved) : 0;
  const dataEffect: UninstallEffect =
    choice === "keep"
      ? {
          kind: "keep_data",
          changes: false,
          detail: exists
            ? "données conservées en place ; aucun fichier n'est modifié"
            : "aucun dossier de données à conserver",
        }
      : {
          kind: "delete_data",
          changes: exists && refusal === null,
          detail: !exists
            ? "aucun dossier de données : rien à supprimer"
            : refusal !== null
              ? refusal
              : `suppression du dossier de données et de ses ${String(entries)} entrée(s), liens retirés sans toucher leur cible ; ${DELETE_NOTE}`,
        };
  return {
    dataDir: resolved,
    dataDirExists: exists,
    choice,
    refusal,
    entries,
    effects: [
      { kind: "stop_daemon", changes: false, detail: NO_DAEMON },
      { kind: "remove_launch_mechanism", changes: false, detail: NO_LAUNCH_MECHANISM },
      dataEffect,
      { kind: "remove_package", changes: false, detail: PACKAGE_NOTE },
    ],
  };
}

export interface DeletionResult {
  readonly removed: number;
  /** Entrées qui n'ont pas pu être retirées (fichier verrouillé, droits). */
  readonly failed: readonly { readonly path: string; readonly detail: string }[];
  readonly dataDirRemoved: boolean;
}

/** Retire un lien (symbolique ou jonction) sans jamais toucher sa cible. */
function removeLink(full: string): void {
  try {
    fs.unlinkSync(full);
  } catch (error) {
    // Jonction ou lien de dossier sous Windows : rmdir retire le lien lui-même.
    if (process.platform === "win32") fs.rmdirSync(full);
    else throw error;
  }
}

/**
 * Supprime le contenu puis le dossier de données, en profondeur, sans suivre aucun lien.
 * Continue après un échec pour donner un résultat complet et explicite.
 */
export function deleteDataDir(dataDir: string): DeletionResult {
  const root = path.resolve(dataDir);
  let removed = 0;
  const failed: { path: string; detail: string }[] = [];
  const attempt = (full: string, action: () => void): void => {
    try {
      action();
      removed += 1;
    } catch (error) {
      failed.push({
        path: path.relative(root, full) || ".",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stats = fs.lstatSync(full, { throwIfNoEntry: false });
      if (stats === undefined) continue;
      if (stats.isSymbolicLink()) {
        attempt(full, () => {
          removeLink(full);
        });
      } else if (stats.isDirectory()) {
        walk(full);
        attempt(full, () => {
          fs.rmdirSync(full);
        });
      } else {
        attempt(full, () => {
          fs.unlinkSync(full);
        });
      }
    }
  };
  if (fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return { removed: 0, failed: [], dataDirRemoved: false };
  }
  walk(root);
  let dataDirRemoved = false;
  if (failed.length === 0) {
    try {
      fs.rmdirSync(root);
      dataDirRemoved = true;
    } catch (error) {
      failed.push({ path: ".", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, failed, dataDirRemoved };
}
