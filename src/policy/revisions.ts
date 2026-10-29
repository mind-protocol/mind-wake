/**
 * Cycle de vie des révisions : proposition (par la skill ou la CLI), consentement humain
 * par le canal de confiance, révocation, et résolution de la révision en vigueur.
 *
 * Fonctions synchrones à appeler dans `UnitOfWork.transaction` : elles composent plusieurs
 * écritures (révision, consentement, journal) qui doivent être atomiques.
 */

import { createHash } from "node:crypto";
import { POLICY_SCHEMA_VERSION } from "../contracts/policy.js";
import type {
  ConsentId,
  PolicyRevisionId,
  ProfileId,
  Sha256Hex,
  UtcTimestamp,
} from "../contracts/common.js";
import type { PermissionRevocation, PolicyConsent, PolicyRevision } from "../contracts/policy.js";
import type { JournalRepository, PolicyRepository } from "../contracts/repositories.js";
import { canonicalJson, classifyChange, type ChangeSummary } from "./change.js";
import { deepFreeze, validateDraft, type ValidationIssue } from "./validate.js";

/** Sous-ensemble de `UnitOfWork` utilisé par le policy engine. */
export interface PolicyStore {
  readonly policies: PolicyRepository;
  readonly journal: JournalRepository;
}

declare const trustedChannelBrand: unique symbol;

/**
 * Jeton du canal utilisateur de confiance. Seule `openTrustedUserChannel` en produit ;
 * un objet de même forme issu d'un JSON, d'un checkpoint ou d'une sortie du modèle n'est
 * jamais reconnu. Seul le point d'entrée humain (CLI locale) doit l'ouvrir.
 */
export interface TrustedUserChannel {
  readonly channel: "local_cli";
  readonly [trustedChannelBrand]: true;
}

const issuedChannels = new WeakSet<object>();

export function openTrustedUserChannel(): TrustedUserChannel {
  const token = Object.freeze({ channel: "local_cli" as const });
  issuedChannels.add(token);
  return token as TrustedUserChannel;
}

export function isTrustedUserChannel(value: unknown): value is TrustedUserChannel {
  return typeof value === "object" && value !== null && issuedChannels.has(value);
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isUtcTimestamp(value: unknown): value is UtcTimestamp {
  return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));
}

/** Empreinte du contenu exact présenté à l'humain ; le consentement doit la reprendre. */
export function revisionDigest(revision: PolicyRevision): Sha256Hex {
  return createHash("sha256").update(canonicalJson(revision)).digest("hex") as Sha256Hex;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function isValidProof(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1000 &&
    !CONTROL_CHARS.test(value)
  );
}

function isValidConsent(consent: PolicyConsent | null, revision: PolicyRevision): boolean {
  return (
    consent !== null &&
    consent.revisionId === revision.id &&
    (consent.channel as string) === "local_cli" &&
    isValidProof(consent.proof) &&
    isUtcTimestamp(consent.grantedAt) &&
    Date.parse(consent.grantedAt) >= Date.parse(revision.createdAt)
  );
}

/** Révision en vigueur pour un profil, ou motif de son absence. */
export type PolicyResolution =
  | {
      readonly status: "active";
      readonly revision: PolicyRevision;
      readonly consent: PolicyConsent;
    }
  | { readonly status: "none"; readonly detail: string }
  | {
      readonly status: "revoked";
      readonly revision: PolicyRevision;
      readonly revocations: readonly PermissionRevocation[];
    }
  | {
      readonly status: "invalid";
      readonly revisionId: PolicyRevisionId | null;
      readonly detail: string;
    };

/**
 * La révision en vigueur est la plus récente révision consentie. Les propositions plus
 * récentes sans consentement restent inactives. Une révision révoquée ne cède jamais la
 * place à une révision antérieure, qui pourrait être plus large : tout est alors refusé.
 */
export function resolvePolicy(policies: PolicyRepository, profileId: ProfileId): PolicyResolution {
  const revisions = policies.listRevisions(profileId);
  const seen = new Set<string>();
  for (const revision of revisions) {
    if (
      revision.profileId !== profileId ||
      revision.schemaVersion !== POLICY_SCHEMA_VERSION ||
      seen.has(revision.id) ||
      (revision.previousRevisionId !== null && !seen.has(revision.previousRevisionId))
    ) {
      return {
        status: "invalid",
        revisionId: revision.id,
        detail: "policy.chain_integrity",
      };
    }
    seen.add(revision.id);
  }

  for (let i = revisions.length - 1; i >= 0; i--) {
    const revision = revisions[i];
    if (revision === undefined) continue;
    const consent = policies.getConsent(revision.id);
    if (!isValidConsent(consent, revision) || consent === null) continue;

    const check = validateDraft(revision.groups, profileId);
    if (!check.ok) {
      return {
        status: "invalid",
        revisionId: revision.id,
        detail: `policy.invalid_revision: ${check.issues.map((x) => x.field).join(", ")}`,
      };
    }
    const revocations = policies.listRevocations(revision.id);
    if (revocations.length > 0) return { status: "revoked", revision, revocations };
    return { status: "active", revision, consent };
  }
  return { status: "none", detail: "policy.no_consented_revision" };
}

function currentBase(resolution: PolicyResolution): PolicyRevision | null {
  return resolution.status === "active" || resolution.status === "revoked"
    ? resolution.revision
    : null;
}

export interface ProposeInput {
  readonly revisionId: PolicyRevisionId;
  readonly profileId: ProfileId;
  readonly at: UtcTimestamp;
  /** Brouillon non fiable : il peut venir de la skill, donc du modèle. */
  readonly draft: unknown;
}

export type ProposeResult =
  | {
      readonly status: "proposed";
      readonly revision: PolicyRevision;
      readonly change: ChangeSummary;
      readonly digest: Sha256Hex;
    }
  | { readonly status: "rejected"; readonly issues: readonly ValidationIssue[] };

/**
 * Crée une révision immuable non encore applicable. Une proposition n'a aucun effet sur
 * les décisions tant qu'aucun consentement humain ne l'a validée.
 */
export function proposeRevision(store: PolicyStore, input: ProposeInput): ProposeResult {
  const reject = (field: string, detail: string): ProposeResult => ({
    status: "rejected",
    issues: [{ field, code: "invalid", detail }],
  });
  if (!isUtcTimestamp(input.at)) return reject("at", "horodatage UTC attendu");
  if (store.policies.getRevision(input.revisionId) !== null) {
    return reject("revisionId", "identifiant de révision déjà utilisé");
  }
  const resolution = resolvePolicy(store.policies, input.profileId);
  if (resolution.status === "invalid") return reject("policy", resolution.detail);

  const check = validateDraft(input.draft, input.profileId);
  if (!check.ok) return { status: "rejected", issues: check.issues };

  const base = currentBase(resolution);
  const revision: PolicyRevision = deepFreeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    id: input.revisionId,
    profileId: input.profileId,
    previousRevisionId: base?.id ?? null,
    createdAt: input.at,
    groups: check.groups,
  });
  const change = classifyChange(base?.groups ?? null, revision.groups);
  const digest = revisionDigest(revision);
  store.policies.appendRevision(revision);
  store.journal.append({
    type: "policy_revision_created",
    at: input.at,
    profileId: input.profileId,
    policyRevisionId: revision.id,
    reason: "révision proposée ; consentement humain requis avant application",
    metadata: {
      changeKind: change.kind,
      widened: [...change.widened],
      restricted: [...change.restricted],
      digest,
    },
  });
  return { status: "proposed", revision, change, digest };
}

export interface ConsentInput {
  readonly consentId: ConsentId;
  readonly revisionId: PolicyRevisionId;
  readonly profileId: ProfileId;
  readonly at: UtcTimestamp;
  /** Empreinte affichée à l'humain lors de la confirmation. */
  readonly confirmedDigest: string;
  /** Référence de preuve locale (saisie de confirmation journalisée). */
  readonly proof: string;
}

export const CONSENT_REFUSALS = [
  "untrusted_channel",
  "unknown_revision",
  "profile_mismatch",
  "digest_mismatch",
  "already_consented",
  "stale_proposal",
  "invalid_proof",
  "invalid_timestamp",
  "policy_invalid",
] as const;

export type ConsentRefusal = (typeof CONSENT_REFUSALS)[number];

export type ConsentResult =
  | {
      readonly status: "consented";
      readonly consent: PolicyConsent;
      readonly change: ChangeSummary;
    }
  | { readonly status: "refused"; readonly reason: ConsentRefusal };

/**
 * Enregistre le consentement humain d'une révision proposée, qui devient alors la
 * révision en vigueur. Exige le jeton du canal de confiance, l'empreinte exacte du contenu
 * confirmé et une proposition construite sur la révision actuellement en vigueur.
 */
export function grantConsent(
  store: PolicyStore,
  channel: unknown,
  input: ConsentInput,
): ConsentResult {
  const refuse = (reason: ConsentRefusal): ConsentResult => {
    if (isUtcTimestamp(input.at)) {
      store.journal.append({
        type: "action_denied",
        at: input.at,
        profileId: input.profileId,
        reason: "consentement refusé",
        metadata: { action: "grant_consent", refusal: reason },
      });
    }
    return { status: "refused", reason };
  };

  if (!isTrustedUserChannel(channel)) return refuse("untrusted_channel");
  if (!isUtcTimestamp(input.at)) return refuse("invalid_timestamp");
  const revision = store.policies.getRevision(input.revisionId);
  if (revision === null) return refuse("unknown_revision");
  if (revision.profileId !== input.profileId) return refuse("profile_mismatch");
  if (input.confirmedDigest !== revisionDigest(revision)) return refuse("digest_mismatch");
  if (store.policies.getConsent(revision.id) !== null) return refuse("already_consented");
  if (!isValidProof(input.proof)) return refuse("invalid_proof");
  if (Date.parse(input.at) < Date.parse(revision.createdAt)) return refuse("invalid_timestamp");

  const resolution = resolvePolicy(store.policies, input.profileId);
  if (resolution.status === "invalid") return refuse("policy_invalid");
  const base = currentBase(resolution);
  if (revision.previousRevisionId !== (base?.id ?? null)) return refuse("stale_proposal");

  const consent: PolicyConsent = deepFreeze({
    id: input.consentId,
    revisionId: revision.id,
    grantedAt: input.at,
    channel: "local_cli",
    proof: input.proof,
  });
  const change = classifyChange(base?.groups ?? null, revision.groups);
  store.policies.recordConsent(consent);
  store.journal.append({
    type: "consent_granted",
    at: input.at,
    profileId: input.profileId,
    policyRevisionId: revision.id,
    reason: "consentement humain par le canal local",
    metadata: {
      consentId: consent.id,
      changeKind: change.kind,
      widened: [...change.widened],
      restricted: [...change.restricted],
    },
  });
  return { status: "consented", consent, change };
}

export interface RevokeInput {
  readonly profileId: ProfileId;
  readonly at: UtcTimestamp;
  readonly reason: string;
}

export type RevokeResult =
  | { readonly status: "revoked"; readonly revocation: PermissionRevocation }
  | { readonly status: "nothing_to_revoke"; readonly detail: string };

/**
 * Révoque toutes les permissions de la révision en vigueur, avec effet immédiat sur les
 * sessions actives. Restreindre est toujours sûr ; réactiver exige une nouvelle révision
 * et un nouveau consentement. Une révocation partielle s'exprime par une révision
 * restrictive.
 */
export function revokePermissions(store: PolicyStore, input: RevokeInput): RevokeResult {
  if (!isUtcTimestamp(input.at)) {
    return { status: "nothing_to_revoke", detail: "horodatage UTC attendu" };
  }
  const resolution = resolvePolicy(store.policies, input.profileId);
  if (resolution.status !== "active") {
    return { status: "nothing_to_revoke", detail: `policy.${resolution.status}` };
  }
  const revocation: PermissionRevocation = deepFreeze({
    revisionId: resolution.revision.id,
    revokedAt: input.at,
    reason: input.reason,
  });
  store.policies.recordRevocation(revocation);
  store.journal.append({
    type: "permission_revoked",
    at: input.at,
    profileId: input.profileId,
    policyRevisionId: resolution.revision.id,
    reason: input.reason,
    metadata: {},
  });
  return { status: "revoked", revocation };
}
