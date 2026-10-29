/**
 * Dépose les squelettes de `prompts/agent-space/` dans l'espace d'exploration de l'agent,
 * sans jamais écraser un fichier existant : l'espace appartient à l'agent, qui peut
 * remodeler, renommer ou supprimer ces fichiers. Un fichier supprimé par l'agent n'est
 * pas recréé : le dépôt n'a lieu qu'une fois, marqué par `.mind-wake-seeded`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SPACE_TEMPLATES_DIR = fileURLToPath(
  new URL("../../prompts/agent-space/", import.meta.url),
);

export const SEED_MARKER = ".mind-wake-seeded";

export interface SeedResult {
  readonly seeded: boolean;
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

function listTemplates(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listTemplates(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Copie les squelettes absents. Refuse de suivre un lien symbolique ou une jonction :
 * un dossier de destination qui n'est pas un vrai dossier sous `workspaceDir` est ignoré.
 */
export function seedAgentSpace(
  workspaceDir: string,
  templatesDir: string = DEFAULT_SPACE_TEMPLATES_DIR,
): SeedResult {
  const root = path.resolve(workspaceDir);
  const marker = path.join(root, SEED_MARKER);
  if (fs.existsSync(marker)) return { seeded: false, created: [], skipped: [] };
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);

  const created: string[] = [];
  const skipped: string[] = [];
  for (const rel of listTemplates(templatesDir)) {
    const target = path.join(root, ...rel.split("/"));
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    const realParent = fs.realpathSync(parent);
    const inside = realParent === realRoot || realParent.startsWith(realRoot + path.sep);
    if (!inside || fs.lstatSync(parent).isSymbolicLink() || fs.existsSync(target)) {
      skipped.push(rel);
      continue;
    }
    fs.copyFileSync(path.join(templatesDir, ...rel.split("/")), target, fs.constants.COPYFILE_EXCL);
    created.push(rel);
  }
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return { seeded: true, created, skipped };
}
