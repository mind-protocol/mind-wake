/**
 * Dépôt de journal en mémoire, pour les tests et en attendant l'implémentation SQLite
 * de S3. Non persistant ; même contrat que `JournalRepository`.
 */

import {
  JOURNAL_SCHEMA_VERSION,
  type JournalEvent,
  type JournalEventInput,
  type JournalRepository,
  type ProfileId,
} from "../contracts/index.js";

export class MemoryJournalRepository implements JournalRepository {
  private readonly events = new Map<ProfileId, JournalEvent[]>();

  append(event: JournalEventInput): JournalEvent {
    const list = this.events.get(event.profileId) ?? [];
    const last = list.at(-1);
    const stored: JournalEvent = {
      ...structuredClone(event),
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      sequence: (last?.sequence ?? 0) + 1,
    };
    list.push(stored);
    this.events.set(event.profileId, list);
    return structuredClone(stored);
  }

  list(
    profileId: ProfileId,
    options?: { readonly afterSequence?: number; readonly limit?: number },
  ): readonly JournalEvent[] {
    const after = options?.afterSequence ?? 0;
    const selected = (this.events.get(profileId) ?? []).filter((e) => e.sequence > after);
    const limited = options?.limit === undefined ? selected : selected.slice(0, options.limit);
    return structuredClone(limited);
  }

  /** Copie indépendante, utilisée pour annuler une transaction en mémoire. */
  snapshot(): MemoryJournalRepository {
    const copy = new MemoryJournalRepository();
    for (const [profileId, list] of this.events) copy.events.set(profileId, structuredClone(list));
    return copy;
  }
}
