/**
 * Validation structurelle d'un checkpoint candidat (SPEC §7), sans accès disque.
 *
 * Le candidat vient de l'agent : il est traité comme une donnée hostile. Le schéma est
 * fermé (toute clé inconnue est refusée) : aucun champ ne peut porter une policy, une
 * permission ou un budget, et le daemon n'interprète jamais le texte libre. Un texte
 * qui « demande » plus de droits reste donc une donnée sans effet ; le refus porte sur
 * la forme, pas sur une détection heuristique d'instructions, qui serait contournable.
 *
 * Aucun secret : chaque chaîne passe par l'expurgation du journal ; une chaîne qu'elle
 * modifierait fait refuser le checkpoint, plutôt que d'enregistrer une version
 * expurgée que l'agent n'a pas écrite.
 */

import type {
  CheckpointCandidate,
  CheckpointRejectionReason,
  CheckpointValidation,
  ObservationConfidence,
} from "../contracts/index.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../contracts/index.js";
import { redactString } from "../journal/index.js";
import { checkRelativePath } from "./paths.js";
import { MAX_ARTIFACT_BYTES } from "./artifacts.js";

export interface CheckpointLimits {
  /** Taille du JSON sérialisé du candidat, en octets UTF-8. */
  readonly maxTotalBytes: number;
  readonly maxSummaryLength: number;
  readonly maxItemLength: number;
  readonly maxItems: number;
  readonly maxArtifacts: number;
  readonly maxArtifactBytes: number;
}

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxTotalBytes: 64 * 1024,
  maxSummaryLength: 4_000,
  maxItemLength: 2_000,
  maxItems: 64,
  maxArtifacts: 64,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
};

const CANDIDATE_KEYS = [
  "schemaVersion",
  "experimentId",
  "sessionId",
  "summary",
  "observations",
  "failures",
  "artifacts",
  "incompleteWork",
  "nextAction",
  "hibernationReason",
] as const;
const OBSERVATION_KEYS = ["text", "confidence"] as const;
const ARTIFACT_KEYS = ["id", "path", "sha256", "bytes"] as const;

const CONFIDENCES: readonly ObservationConfidence[] = ["observed", "inferred", "hypothesis"];

/** Identifiant local : lettres, chiffres, `.`, `_`, `-` ; pas de séparateur de chemin. */
export const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Contrôles C0 hors tabulation et sauts de ligne, DEL, et surcharges bidirectionnelles
// qui feraient lire à l'humain un texte différent de celui stocké.
// eslint-disable-next-line no-control-regex -- les caractères de contrôle sont précisément refusés
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

class Collector {
  readonly reasons = new Set<CheckpointRejectionReason>();
  readonly details: string[] = [];

  add(reason: CheckpointRejectionReason, field: string, problem: string): void {
    this.reasons.add(reason);
    // Le détail nomme le champ, jamais la valeur : elle peut contenir un secret.
    if (this.details.length < 16) this.details.push(`${field} : ${problem}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
  out: Collector,
): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) out.add("malformed", field, "clé non prévue par le schéma");
  }
  for (const key of expected) {
    if (!(key in value)) out.add("malformed", `${field}.${key}`, "absent");
  }
}

function checkText(
  value: unknown,
  field: string,
  maxLength: number,
  out: Collector,
  options: { readonly allowEmpty?: boolean } = {},
): void {
  if (typeof value !== "string") {
    out.add("malformed", field, "texte attendu");
    return;
  }
  if (options.allowEmpty !== true && value.trim() === "") out.add("malformed", field, "vide");
  if (value.length > maxLength) out.add("too_large", field, "texte trop long");
  if (FORBIDDEN_TEXT.test(value)) out.add("malformed", field, "caractère de contrôle interdit");
  if (redactString(value) !== value) out.add("contains_secret", field, "secret reconnu");
}

function checkTextList(
  value: unknown,
  field: string,
  limits: CheckpointLimits,
  out: Collector,
): void {
  if (!Array.isArray(value)) {
    out.add("malformed", field, "liste attendue");
    return;
  }
  if (value.length > limits.maxItems) out.add("too_large", field, "trop d'éléments");
  value.slice(0, limits.maxItems).forEach((item: unknown, i) => {
    checkText(item, `${field}[${String(i)}]`, limits.maxItemLength, out);
  });
}

function checkId(value: unknown, field: string, out: Collector): void {
  if (typeof value !== "string" || !LOCAL_ID.test(value)) {
    out.add("malformed", field, "identifiant local invalide");
  }
}

function checkObservations(value: unknown, limits: CheckpointLimits, out: Collector): void {
  if (!Array.isArray(value)) {
    out.add("malformed", "observations", "liste attendue");
    return;
  }
  if (value.length > limits.maxItems) out.add("too_large", "observations", "trop d'éléments");
  value.slice(0, limits.maxItems).forEach((item: unknown, i) => {
    const field = `observations[${String(i)}]`;
    if (!isRecord(item)) {
      out.add("malformed", field, "objet attendu");
      return;
    }
    checkKeys(item, OBSERVATION_KEYS, field, out);
    checkText(item["text"], `${field}.text`, limits.maxItemLength, out);
    if (!CONFIDENCES.includes(item["confidence"] as ObservationConfidence)) {
      out.add("malformed", `${field}.confidence`, "statut de confiance inconnu");
    }
  });
}

function checkArtifacts(value: unknown, limits: CheckpointLimits, out: Collector): void {
  if (!Array.isArray(value)) {
    out.add("malformed", "artifacts", "liste attendue");
    return;
  }
  if (value.length > limits.maxArtifacts) out.add("too_large", "artifacts", "trop d'artefacts");
  const ids = new Set<string>();
  const paths = new Set<string>();
  value.slice(0, limits.maxArtifacts).forEach((item: unknown, i) => {
    const field = `artifacts[${String(i)}]`;
    if (!isRecord(item)) {
      out.add("malformed", field, "objet attendu");
      return;
    }
    checkKeys(item, ARTIFACT_KEYS, field, out);
    checkId(item["id"], `${field}.id`, out);
    const id = item["id"];
    if (typeof id === "string") {
      if (ids.has(id)) out.add("malformed", `${field}.id`, "identifiant en double");
      ids.add(id);
    }
    const path = checkRelativePath(item["path"]);
    if (!path.ok) {
      out.add(path.reason, `${field}.path`, path.detail);
    } else {
      // Un même fichier sous deux casses est un doublon sous Windows.
      const key = path.path.toLowerCase();
      if (paths.has(key)) out.add("malformed", `${field}.path`, "chemin en double");
      paths.add(key);
    }
    const sha = item["sha256"];
    if (typeof sha !== "string" || !SHA256.test(sha)) {
      out.add("malformed", `${field}.sha256`, "SHA-256 hexadécimal minuscule attendu");
    }
    const bytes = item["bytes"];
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      out.add("malformed", `${field}.bytes`, "entier positif ou nul attendu");
    } else if (bytes > limits.maxArtifactBytes) {
      out.add("too_large", `${field}.bytes`, "artefact trop volumineux");
    }
  });
}

/** Copie JSON indépendante : les contrôles portent sur une valeur figée, sans accesseur. */
function snapshot(value: unknown): { readonly copy: unknown; readonly bytes: number } | null {
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json === undefined
      ? null
      : { copy: JSON.parse(json) as unknown, bytes: Buffer.byteLength(json, "utf8") };
  } catch {
    return null;
  }
}

export type CandidateValidation =
  | { readonly valid: true; readonly candidate: CheckpointCandidate }
  | Extract<CheckpointValidation, { readonly valid: false }>;

/**
 * Valide la forme d'un candidat. Ne vérifie ni les fichiers (voir `verifyArtifact`), ni
 * la cohérence avec la session en cours (voir `publishCheckpoint`).
 */
export function validateCandidate(
  input: unknown,
  limits: CheckpointLimits = DEFAULT_CHECKPOINT_LIMITS,
): CandidateValidation {
  const out = new Collector();
  const frozen = snapshot(input);
  const value = frozen?.copy;
  if (frozen === null) {
    out.add("malformed", "checkpoint", "non sérialisable en JSON");
  } else if (frozen.bytes > limits.maxTotalBytes) {
    // Trop gros : refusé sans parcours détaillé.
    out.add("too_large", "checkpoint", "taille sérialisée au-delà de la limite");
  } else if (!isRecord(value)) {
    out.add("malformed", "checkpoint", "objet attendu");
  } else {
    checkKeys(value, CANDIDATE_KEYS, "checkpoint", out);
    if (value["schemaVersion"] !== CHECKPOINT_SCHEMA_VERSION) {
      out.add("unsupported_schema_version", "schemaVersion", "version non prise en charge");
    }
    checkId(value["experimentId"], "experimentId", out);
    checkId(value["sessionId"], "sessionId", out);
    checkText(value["summary"], "summary", limits.maxSummaryLength, out);
    checkObservations(value["observations"], limits, out);
    checkTextList(value["failures"], "failures", limits, out);
    checkArtifacts(value["artifacts"], limits, out);
    checkTextList(value["incompleteWork"], "incompleteWork", limits, out);
    checkText(value["nextAction"], "nextAction", limits.maxItemLength, out);
    checkText(value["hibernationReason"], "hibernationReason", limits.maxItemLength, out);
  }
  if (out.reasons.size === 0) {
    return { valid: true, candidate: value as CheckpointCandidate };
  }
  return { valid: false, reasons: [...out.reasons], detail: out.details.join(" ; ") };
}
