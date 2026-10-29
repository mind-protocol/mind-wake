/**
 * Transition d'état du profil journalisée dans la même transaction (AGENTS §5
 * « Cycle de vie »). La table autorisée reste celle de `src/contracts/lifecycle.ts` ;
 * le dépôt refuse toute autre transition. Réutilisable par le runner (S7).
 */

import type {
  JsonObject,
  ProfileId,
  ProfileRecord,
  ProfileState,
  SessionId,
  UnitOfWork,
  UtcTimestamp,
} from "../contracts/index.js";
import { prepareJournalEvent } from "../journal/index.js";

export interface TransitionRequest {
  readonly profileId: ProfileId;
  readonly from: ProfileState;
  readonly to: ProfileState;
  readonly reason: string;
  readonly at: UtcTimestamp;
  readonly sessionId?: SessionId;
  readonly metadata?: JsonObject;
}

export function transitionProfile(uow: UnitOfWork, request: TransitionRequest): ProfileRecord {
  return uow.transaction((tx) => {
    const record = tx.profiles.transition(request.profileId, {
      from: request.from,
      to: request.to,
      reason: request.reason,
      at: request.at,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    });
    tx.journal.append(
      prepareJournalEvent({
        type: "profile_state_changed",
        at: request.at,
        profileId: request.profileId,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        reason: request.reason,
        metadata: { ...request.metadata, from: request.from, to: request.to },
      }),
    );
    return record;
  });
}
