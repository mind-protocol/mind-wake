/**
 * Écriture d'événements séquencés. Seul point d'entrée prévu vers
 * `JournalRepository.append` : tout événement y est expurgé et borné avant d'atteindre
 * le stockage. La séquence est attribuée par le dépôt et contrôlée ici.
 */

import {
  JOURNAL_EVENT_TYPES,
  type JournalEvent,
  type JournalEventInput,
  type JournalEventType,
  type JournalRepository,
  type ProfileId,
  type UtcTimestamp,
} from "../contracts/index.js";
import {
  DEFAULT_METADATA_LIMITS,
  type MetadataLimits,
  sanitizeMetadata,
  sanitizeReason,
} from "./sanitize.js";

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function isUtcTimestamp(value: string): value is UtcTimestamp {
  return UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export function toUtcTimestamp(date: Date): UtcTimestamp {
  return date.toISOString() as UtcTimestamp;
}

export function isJournalEventType(value: string): value is JournalEventType {
  return (JOURNAL_EVENT_TYPES as readonly string[]).includes(value);
}

export class JournalError extends Error {
  override readonly name = "JournalError";
}

/** Événement proposé par un module ; les métadonnées peuvent contenir n'importe quoi. */
export interface JournalRecordRequest extends Omit<JournalEventInput, "metadata"> {
  readonly metadata?: unknown;
}

/** Prépare un événement pour le dépôt : validation, expurgation, bornage. */
export function prepareJournalEvent(
  request: JournalRecordRequest,
  limits: MetadataLimits = DEFAULT_METADATA_LIMITS,
): JournalEventInput {
  if (!isJournalEventType(request.type)) {
    throw new JournalError(`type d'événement inconnu : ${sanitizeReason(String(request.type))}`);
  }
  if (!isUtcTimestamp(request.at)) {
    throw new JournalError("horodatage invalide : ISO 8601 UTC avec suffixe Z attendu");
  }
  return {
    type: request.type,
    at: request.at,
    profileId: request.profileId,
    ...(request.sessionId !== undefined && { sessionId: request.sessionId }),
    ...(request.experimentId !== undefined && { experimentId: request.experimentId }),
    ...(request.policyRevisionId !== undefined && { policyRevisionId: request.policyRevisionId }),
    reason: sanitizeReason(request.reason),
    metadata: sanitizeMetadata(request.metadata, limits),
  };
}

export class JournalWriter {
  private readonly lastSequence = new Map<ProfileId, number>();

  constructor(
    private readonly repository: JournalRepository,
    private readonly limits: MetadataLimits = DEFAULT_METADATA_LIMITS,
  ) {}

  record(request: JournalRecordRequest): JournalEvent {
    const event = this.repository.append(prepareJournalEvent(request, this.limits));
    const previous = this.lastSequence.get(event.profileId);
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      throw new JournalError(`séquence invalide renvoyée par le dépôt : ${String(event.sequence)}`);
    }
    if (previous !== undefined && event.sequence <= previous) {
      throw new JournalError(
        `séquence non croissante : ${String(event.sequence)} après ${String(previous)}`,
      );
    }
    this.lastSequence.set(event.profileId, event.sequence);
    return event;
  }
}
