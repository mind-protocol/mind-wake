/**
 * Protocole filaire local entre la passerelle de conversation et ses clients (adaptateur
 * MCP côté guide, agent guest, opérateur). JSON délimité par des sauts de ligne sur un
 * pipe nommé ou une socket locale : aucun port TCP, aucun accès réseau (SPEC §15.1).
 *
 * Le protocole n'expose que des opérations de conversation nommées. Il n'existe aucune
 * opération de lecture de fichier, d'exécution, de délégation d'outil, de sampling ou de
 * paiement : un message ne peut donc rien déclencher d'autre qu'un message.
 */

import * as z from "zod";

export const PROTOCOL_VERSION = 1;

/** Bornes de taille et de débit, appliquées par la passerelle (pas par un prompt). */
export const LIMITS = {
  maxTextChars: 4000,
  maxArtifacts: 5,
  maxMessagesPerEncounter: 200,
  maxReceiveBatch: 50,
  maxWaitMs: 10_000,
  /** Une ligne du protocole au-delà de cette taille ferme la connexion. */
  maxLineBytes: 64 * 1024,
} as const;

/** Seules opérations exposées au guide par l'adaptateur MCP. */
export const GUIDE_TOOL_NAMES = [
  "open_encounter",
  "send_contribution",
  "receive_messages",
  "request_close",
  "get_status",
] as const;

export const PROVENANCES = ["human", "agent", "technical"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Comment la contribution humaine a été rédigée (SPEC §17.3 : l'apport de l'assistant est affiché). */
export const AUTHORSHIPS = ["human_verbatim", "human_approved_draft"] as const;
export type Authorship = (typeof AUTHORSHIPS)[number];

export const CLOSE_REASONS = [
  "completed",
  "guide_stopped",
  "agent_stopped",
  "switch_agent",
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export const ENCOUNTER_STATES = ["invited", "open", "closed", "revoked", "expired"] as const;
export type EncounterState = (typeof ENCOUNTER_STATES)[number];

export const TERMINAL_STATES: readonly EncounterState[] = ["closed", "revoked", "expired"];

/** Types d'artefacts dont une référence peut circuler ; le contenu ne circule jamais. */
export const ARTIFACT_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json",
  "image/png",
] as const;

const opaqueId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,64}$`), `identifiant ${prefix}_ attendu`);

export const encounterIdSchema = opaqueId("enc");
export const messageIdSchema = opaqueId("msg");
export const invitationSchema = opaqueId("inv");
export const capabilitySchema = opaqueId("cap");
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);

export const artifactRefSchema = z.strictObject({
  ref: opaqueId("art"),
  title: z.string().min(1).max(120),
  mediaType: z.enum(ARTIFACT_MEDIA_TYPES),
  sizeBytes: z.int().min(0).max(10_000_000),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

const scoped = {
  encounterId: encounterIdSchema,
  capability: capabilitySchema,
};

export const requestSchema = z.discriminatedUnion("op", [
  z.strictObject({
    id: z.int().min(0),
    op: z.literal("hello"),
    version: z.literal(PROTOCOL_VERSION),
    role: z.enum(["guide", "guest", "operator"]),
    key: z.string().min(16).max(256),
    invitation: invitationSchema.optional(),
  }),
  z.strictObject({
    id: z.int().min(0),
    op: z.literal("open_encounter"),
    invitation: invitationSchema,
    requestId: idempotencyKeySchema,
  }),
  z.strictObject({
    id: z.int().min(0),
    op: z.literal("send"),
    ...scoped,
    idempotencyKey: idempotencyKeySchema,
    text: z.string().max(LIMITS.maxTextChars),
    inReplyTo: messageIdSchema.optional(),
    authorship: z.enum(AUTHORSHIPS).optional(),
    artifacts: z.array(artifactRefSchema).max(LIMITS.maxArtifacts).optional(),
  }),
  z.strictObject({
    id: z.int().min(0),
    op: z.literal("receive"),
    ...scoped,
    after: z.int().min(0),
    waitMs: z.int().min(0).max(LIMITS.maxWaitMs),
    limit: z.int().min(1).max(LIMITS.maxReceiveBatch),
  }),
  z.strictObject({
    id: z.int().min(0),
    op: z.literal("close"),
    ...scoped,
    idempotencyKey: idempotencyKeySchema,
    reason: z.enum(CLOSE_REASONS),
  }),
  z.strictObject({ id: z.int().min(0), op: z.literal("status"), ...scoped }),
  z.strictObject({
    id: z.int().min(0),
    op: z.literal("revoke"),
    encounterId: encounterIdSchema,
  }),
  z.strictObject({
    id: z.int().min(0),
    op: z.literal("audit"),
    encounterId: encounterIdSchema,
  }),
]);
export type Request = z.infer<typeof requestSchema>;
export type RequestOp = Request["op"];

export const ERROR_CODES = [
  "bad_request",
  "not_authenticated",
  "access_denied",
  "wrong_role",
  "invitation_unavailable",
  "encounter_not_open",
  "encounter_closed",
  "capability_expired",
  "idempotency_conflict",
  "unknown_reference",
  "sensitive_content_refused",
  "private_identifier_refused",
  "empty_message",
  "limit_reached",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface WireError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** État terminal d'une rencontre, pour `encounter_closed`. */
  readonly state?: EncounterState;
}

export type Response =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WireError };

/** Message tel que livré à un participant : jamais d'identité privée, jamais de capacité. */
export interface DeliveredMessage {
  readonly messageId: string;
  readonly sequence: number;
  readonly provenance: Provenance;
  /** Pseudonyme de rencontre, ou `service` pour un message technique. */
  readonly author: string;
  readonly fromSelf: boolean;
  readonly text: string;
  readonly at: string;
  readonly inReplyTo?: string;
  readonly authorship?: Authorship;
  readonly artifacts?: readonly ArtifactRef[];
}

export interface SendResult {
  readonly messageId: string;
  readonly sequence: number;
  readonly duplicate: boolean;
}

export interface ReceiveResult {
  readonly messages: readonly DeliveredMessage[];
  readonly next: number;
  readonly state: EncounterState;
}

export interface StatusResult {
  readonly encounterId: string;
  readonly state: EncounterState;
  readonly selfPseudonym: string;
  readonly counterpartPseudonym: string;
  readonly guestConnected: boolean;
  readonly messages: { readonly human: number; readonly agent: number; readonly technical: number };
  readonly expiresAt: string | null;
}

export interface OpenResult {
  readonly encounterId: string;
  readonly capability: string;
  readonly selfPseudonym: string;
  readonly counterpartPseudonym: string;
  readonly topic: string;
  readonly expiresAt: string;
  readonly reopened: boolean;
}

export interface GuestHelloResult {
  readonly encounterId: string;
  readonly capability: string;
  readonly selfPseudonym: string;
  readonly counterpartPseudonym: string;
  readonly state: EncounterState;
}

export interface AuditEntry {
  readonly messageId: string;
  readonly sequence: number;
  readonly provenance: Provenance;
  readonly bodyRetained: boolean;
}

export interface AuditResult {
  readonly state: EncounterState;
  readonly sessionRef: string;
  readonly entries: readonly AuditEntry[];
}
