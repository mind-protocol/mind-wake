/**
 * Projet courant déclaré par l'agent, pour décider du bilan Étapes. Autorité : le champ
 * `current` de `artifacts/projets-compteur.json` (écrit par l'outil de l'agent
 * `artifacts/tools/projet.js use <id>`), seulement s'il désigne une entrée du registre
 * `projects`. Ni titre, ni document affiché, ni menu, ni expression régulière sur du
 * texte : un identifiant déclaré ou rien.
 *
 * Lecture locale, bornée et confinée à l'espace de travail ; aucun script n'est exécuté
 * et aucun appel modèle n'est fait pour décider d'un changement. Toute lecture absente,
 * invalide, trop grande, hors espace ou par lien donne `null` (inconnu).
 */
import fs from "node:fs";
import path from "node:path";

export const PROJECT_COUNTER_FILE = "projets-compteur.json";
/** Le fichier réel faisait ~5,5 Kio le 30 octobre 2026 ; borne large, mais bornée. */
export const PROJECT_COUNTER_MAX_BYTES = 262_144;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Contenu JSON du registre, lu borné et confiné ; `null` si illisible. */
export function readCounter(workspaceDir: string): Record<string, unknown> | null {
  const file = path.join(workspaceDir, "artifacts", PROJECT_COUNTER_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const real = fs.realpathSync(file);
    const relative = path.relative(fs.realpathSync(workspaceDir), real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return null;
    const fd = fs.openSync(real, "r");
    let bytes: Buffer;
    try {
      if (fs.fstatSync(fd).size > PROJECT_COUNTER_MAX_BYTES) return null;
      bytes = Buffer.alloc(PROJECT_COUNTER_MAX_BYTES + 1);
      const n = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (n > PROJECT_COUNTER_MAX_BYTES) return null;
      bytes = bytes.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Identifiant de projet courant déclaré et enregistré, sinon `null`. */
export function readCurrentProject(workspaceDir: string): string | null {
  const counter = readCounter(workspaceDir);
  const current = counter?.["current"];
  if (typeof current !== "string" || !PROJECT_ID.test(current)) return null;
  return registered(counter?.["projects"], current) ? current : null;
}

function registered(projects: unknown, id: string): boolean {
  if (Array.isArray(projects)) return false;
  if (typeof projects !== "object" || projects === null) return false;
  if (!Object.hasOwn(projects, id)) return false;
  const entry = (projects as Record<string, unknown>)[id];
  return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

/** Champs bornés d'une entrée du registre, joints au bilan comme données. */
export interface ProjectSummary {
  /** `estimate` : budget total prévu, pas le travail restant. */
  readonly budgetTotalWakes: number | null;
  /** `spent` : wakes déjà comptés pour ce projet. */
  readonly wakesComptes: number | null;
  readonly statut: string | null;
  readonly suite: string | null;
}

/**
 * Extraits du registre pour les identifiants demandés : nombres et textes courts
 * seulement (pas de journal), pour que le bilan sans outil voie budget total et wakes
 * comptés sans les confondre. Lecture inconnue → objet vide.
 */
export function projectSummaries(
  workspaceDir: string,
  ids: readonly string[],
): Record<string, ProjectSummary> {
  const projects = readRegistry(workspaceDir);
  const out: Record<string, ProjectSummary> = {};
  if (projects === null) return out;
  for (const id of ids) {
    const entry = Object.hasOwn(projects, id) ? projects[id] : undefined;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    out[id] = {
      budgetTotalWakes: count(e["estimate"]),
      wakesComptes: count(e["spent"]),
      statut: short(e["status"], 80),
      suite: short(e["next"], 400),
    };
  }
  return out;
}

function readRegistry(workspaceDir: string): Record<string, unknown> | null {
  const projects = readCounter(workspaceDir)?.["projects"];
  return typeof projects === "object" && projects !== null && !Array.isArray(projects)
    ? (projects as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function short(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : null;
}

export interface ProjectChange {
  readonly from: string;
  readonly to: string;
}

/**
 * Changement de projet pendant UNE réponse : deux identifiants connus et différents.
 * Début ou fin inconnus → `null` (pas de bilan). A→B→A pendant la réponse → `null`.
 */
export function projectChange(start: string | null, end: string | null): ProjectChange | null {
  return start !== null && end !== null && start !== end ? { from: start, to: end } : null;
}
