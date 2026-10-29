/**
 * Pilotage par l'agent de ses propres réglages (ADR-009) : `artifacts/pilote.json`, écrit par
 * l'agent dans son espace, lu par le daemon comme une donnée — jamais exécuté. L'agent y
 * règle son auto-compaction ; l'humain garde pause, arrêt d'urgence et garde de quota.
 *
 *   { "version": 1, "compactAboveTokens": 1500000, "compactRequest": "2026-10-29T20:30" }
 *
 * - `compactAboveTokens` : seuil d'auto-compaction (tokens mesurés au réveil précédent) ;
 *   0 la désactive. Absent : le défaut du daemon.
 * - `compactRequest` : identifiant libre ; chaque nouvelle valeur demande une compaction au
 *   réveil suivant (une seule fois par valeur).
 *
 * Fichier absent, illisible, démesuré ou hors schéma : ignoré en entier (défauts du daemon).
 */

import fs from "node:fs";
import path from "node:path";

export const AGENT_PILOT_FILE = "pilote.json";
const MAX_FILE_BYTES = 4_096;
const MAX_COMPACT_ABOVE_TOKENS = 1_000_000_000;

export interface AgentPilot {
  readonly compactAboveTokens?: number;
  readonly compactRequest?: string;
}

export function readAgentPilot(artifactsDir: string): AgentPilot | null {
  const file = path.join(artifactsDir, AGENT_PILOT_FILE);
  let parsed: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw["version"] !== 1) return null;
  const threshold = raw["compactAboveTokens"];
  const request = raw["compactRequest"];
  if (
    threshold !== undefined &&
    (!Number.isSafeInteger(threshold) ||
      (threshold as number) < 0 ||
      (threshold as number) > MAX_COMPACT_ABOVE_TOKENS)
  ) {
    return null;
  }
  if (
    request !== undefined &&
    (typeof request !== "string" || request.length < 1 || request.length > 128)
  ) {
    return null;
  }
  return {
    ...(threshold === undefined ? {} : { compactAboveTokens: threshold as number }),
    ...(request === undefined ? {} : { compactRequest: request }),
  };
}
