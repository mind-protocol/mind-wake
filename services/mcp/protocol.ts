/**
 * Protocole filaire local entre l'adaptateur MCP (un processus stdio par client) et le
 * hub MIND (autorité unique). JSON délimité par des sauts de ligne sur un pipe nommé ou
 * une socket locale (`../advice/conversation/framing.ts`) : aucun port TCP.
 *
 * Opérations nommées seulement : messages, demandes d'aide, mise en relation, séance.
 * Aucune opération de permission, de policy, de paiement, de fichier ou d'exécution :
 * un message reçu ne peut donc rien déclencher d'autre qu'un message.
 */

import * as z from "zod";
import { AUTHORSHIPS, LIMITS as CHANNEL_LIMITS } from "../advice/conversation/protocol.js";

export const HUB_PROTOCOL_VERSION = 1;
/** Version des sorties d'outils ; incrémentée à tout changement incompatible. */
export const OUTPUT_SCHEMA_VERSION = 1;

/** Bornes de taille, appliquées par le hub (pas par un prompt). */
export const LIMITS = {
  maxMessageChars: CHANNEL_LIMITS.maxTextChars,
  maxTopicChars: 200,
  maxContextChars: 2000,
  maxInboxBatch: 50,
  maxExchanges: 10,
  maxWaitSeconds: CHANNEL_LIMITS.maxWaitMs / 1000,
  maxListBatch: 50,
} as const;

const opaqueId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,64}$`), `identifiant ${prefix}_ attendu`);

/** Référence pseudonyme d'annuaire : jamais l'identifiant privé configuré. */
export const partyRefSchema = z.string().regex(/^(agent|human)-[a-z2-9]{10}$/);
export const messageIdSchema = opaqueId("msg");
export const threadIdSchema = opaqueId("thr");
export const requestIdSchema = opaqueId("req");
export const invitationIdSchema = opaqueId("inv");
export const sessionIdSchema = opaqueId("ses");
export const channelMessageIdSchema = opaqueId("msg");
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
export const checkpointRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{3,100}$/);
export const languageSchema = z.string().regex(/^[a-z]{2}$/);

export const HELP_STATUSES = ["open", "taken", "closed"] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];

export const SESSION_CLOSE_REASONS = ["completed", "stopped"] as const;

const base = { id: z.int().min(0) };

export const hubRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({
    ...base,
    op: z.literal("hello"),
    version: z.literal(HUB_PROTOCOL_VERSION),
    key: z.string().min(16).max(256),
  }),
  z.strictObject({ ...base, op: z.literal("whoami") }),
  z.strictObject({ ...base, op: z.literal("directory") }),
  z.strictObject({
    ...base,
    op: z.literal("send_message"),
    to: partyRefSchema,
    text: z.string().max(LIMITS.maxMessageChars),
    subject: z.string().min(1).max(LIMITS.maxTopicChars).optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    ...base,
    op: z.literal("reply"),
    threadId: threadIdSchema,
    text: z.string().max(LIMITS.maxMessageChars),
    inReplyTo: messageIdSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    ...base,
    op: z.literal("read_inbox"),
    after: z.int().min(0),
    limit: z.int().min(1).max(LIMITS.maxInboxBatch),
    threadId: threadIdSchema.optional(),
  }),
  z.strictObject({
    ...base,
    op: z.literal("publish_help"),
    topic: z.string().max(LIMITS.maxTopicChars),
    context: z.string().max(LIMITS.maxContextChars),
    language: languageSchema,
    maxExchanges: z.int().min(1).max(LIMITS.maxExchanges),
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    ...base,
    op: z.literal("list_help"),
    status: z.enum(HELP_STATUSES).optional(),
    mine: z.boolean(),
  }),
  z.strictObject({ ...base, op: z.literal("close_help"), requestId: requestIdSchema }),
  z.strictObject({ ...base, op: z.literal("propose_matches"), requestId: requestIdSchema }),
  z.strictObject({
    ...base,
    op: z.literal("invite"),
    requestId: requestIdSchema,
    guide: partyRefSchema,
  }),
  z.strictObject({ ...base, op: z.literal("list_invitations") }),
  z.strictObject({
    ...base,
    op: z.literal("respond_invitation"),
    invitationId: invitationIdSchema,
    decision: z.enum(["accept", "decline"]),
  }),
  z.strictObject({
    ...base,
    op: z.literal("session_send"),
    sessionId: sessionIdSchema,
    text: z.string().max(LIMITS.maxMessageChars),
    idempotencyKey: idempotencyKeySchema,
    inReplyTo: channelMessageIdSchema.optional(),
    authorship: z.enum(AUTHORSHIPS).optional(),
  }),
  z.strictObject({
    ...base,
    op: z.literal("session_receive"),
    sessionId: sessionIdSchema,
    after: z.int().min(0),
    waitSeconds: z.int().min(0).max(LIMITS.maxWaitSeconds),
  }),
  z.strictObject({
    ...base,
    op: z.literal("session_checkpoint"),
    sessionId: sessionIdSchema,
    inReplyTo: channelMessageIdSchema,
    checkpointRef: checkpointRefSchema,
  }),
  z.strictObject({
    ...base,
    op: z.literal("session_close"),
    sessionId: sessionIdSchema,
    reason: z.enum(SESSION_CLOSE_REASONS),
  }),
  z.strictObject({ ...base, op: z.literal("session_status"), sessionId: sessionIdSchema }),
]);
export type HubRequest = z.infer<typeof hubRequestSchema>;
export type HubOp = HubRequest["op"];

/** Opérations qui écrivent : comptées dans la limite de débit d'écriture. */
export const WRITE_OPS: readonly HubOp[] = [
  "send_message",
  "reply",
  "publish_help",
  "close_help",
  "invite",
  "respond_invitation",
  "session_send",
  "session_checkpoint",
  "session_close",
];

export const HUB_ERROR_CODES = [
  "bad_request",
  "not_authenticated",
  "permission_denied",
  "unknown_reference",
  "invalid_state",
  "idempotency_conflict",
  "sensitive_content_refused",
  "private_identifier_refused",
  "empty_message",
  "rate_limited",
  "limit_reached",
  "session_unavailable",
  "internal",
] as const;
export type HubErrorCode = (typeof HUB_ERROR_CODES)[number];

export interface HubWireError {
  readonly code: HubErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type HubResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: HubWireError };

export class HubError extends Error {
  readonly code: HubErrorCode;
  readonly retryable: boolean;

  constructor(code: HubErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "HubError";
    this.code = code;
    this.retryable = retryable;
  }

  toWire(): HubWireError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
