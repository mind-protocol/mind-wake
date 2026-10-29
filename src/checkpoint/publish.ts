/**
 * Publication d'un checkpoint (SPEC §7) : validation de forme, cohérence avec la
 * session en cours, vérification des artefacts sur le disque, puis enregistrement du
 * checkpoint, de ses références et de l'événement de journal dans une seule
 * transaction SQLite. `published` n'est renvoyé qu'après validation de cette
 * transaction (WAL, `synchronous = FULL`) : aucune sauvegarde n'est annoncée avant.
 *
 * L'autorisation de publier (`decideAction` avec `publish_checkpoint`) reste à la
 * charge de l'appelant : ce module ne décide pas de la policy et n'en lit aucune.
 */

import { randomUUID } from "node:crypto";
import type {
  Checkpoint,
  CheckpointCandidate,
  CheckpointId,
  CheckpointRejectionReason,
  ProfileId,
  SessionId,
  UnitOfWork,
  UtcTimestamp,
} from "../contracts/index.js";
import { prepareJournalEvent, sanitizeReason } from "../journal/index.js";
import { verifyArtifact } from "./artifacts.js";
import type { ConfinedRoot } from "./paths.js";
import { DEFAULT_CHECKPOINT_LIMITS, validateCandidate, type CheckpointLimits } from "./validate.js";

export interface PublishContext {
  readonly uow: UnitOfWork;
  /** Racine des artefacts, déjà résolue par `openRoot`. */
  readonly root: ConfinedRoot;
  readonly profileId: ProfileId;
  /** Session que le daemon exécute : le candidat ne peut pas en désigner une autre. */
  readonly sessionId: SessionId;
  readonly now: () => UtcTimestamp;
  readonly newId?: () => CheckpointId;
  readonly limits?: CheckpointLimits;
  /** Injection de fautes pour les tests : appelé dans la transaction, avant validation. */
  readonly beforeCommit?: () => void;
}

export type PublishResult =
  | { readonly status: "published"; readonly checkpoint: Checkpoint }
  | {
      readonly status: "rejected";
      readonly reasons: readonly CheckpointRejectionReason[];
      readonly detail: string;
    };

type Rejection = Extract<PublishResult, { status: "rejected" }>;

function rejected(reasons: readonly CheckpointRejectionReason[], detail: string): Rejection {
  return { status: "rejected", reasons: [...new Set(reasons)], detail };
}

/** Cohérence des identifiants du candidat avec la session et l'expérience en cours. */
function checkContext(ctx: PublishContext, candidate: CheckpointCandidate): Rejection | null {
  if (candidate.sessionId !== ctx.sessionId) {
    return rejected(["malformed"], "sessionId : différent de la session en cours");
  }
  const session = ctx.uow.sessions.get(candidate.sessionId);
  if (session?.profileId !== ctx.profileId) {
    return rejected(["malformed"], "sessionId : session inconnue pour ce profil");
  }
  if (session.outcome !== null) {
    return rejected(["malformed"], "sessionId : session déjà terminée");
  }
  if (session.experimentId !== null && session.experimentId !== candidate.experimentId) {
    return rejected(["malformed"], "experimentId : différent de l'expérience de la session");
  }
  const experiment = ctx.uow.experiments.get(candidate.experimentId);
  if (experiment?.profileId !== ctx.profileId) {
    return rejected(["malformed"], "experimentId : expérience inconnue pour ce profil");
  }
  if (experiment.status !== "active") {
    return rejected(["malformed"], "experimentId : expérience non active");
  }
  return null;
}

function checkArtifacts(
  ctx: PublishContext,
  candidate: CheckpointCandidate,
  limits: CheckpointLimits,
): Rejection | null {
  const reasons: CheckpointRejectionReason[] = [];
  const details: string[] = [];
  candidate.artifacts.forEach((ref, i) => {
    const check = verifyArtifact(ctx.root, ref, limits.maxArtifactBytes);
    if (!check.ok) {
      reasons.push(check.reason);
      details.push(`artifacts[${String(i)}] : ${check.detail}`);
    }
  });
  return reasons.length === 0 ? null : rejected(reasons, details.join(" ; "));
}

function journalRejection(ctx: PublishContext, candidate: unknown, rejection: Rejection): void {
  const ids = candidate as { experimentId?: unknown } | null;
  ctx.uow.journal.append(
    prepareJournalEvent({
      type: "checkpoint_rejected",
      at: ctx.now(),
      profileId: ctx.profileId,
      sessionId: ctx.sessionId,
      reason: `checkpoint refusé : ${rejection.reasons.join(", ")}`,
      metadata: {
        reasons: rejection.reasons,
        detail: sanitizeReason(rejection.detail),
        // L'identifiant d'expérience proposé n'est repris que s'il est connu du daemon.
        ...(typeof ids?.experimentId === "string" &&
          ctx.uow.experiments.get(ids.experimentId as Checkpoint["experimentId"]) !== null && {
            experimentId: ids.experimentId,
          }),
      },
    }),
  );
}

/**
 * Valide puis publie `input` comme checkpoint courant de son expérience. Un refus est
 * journalisé et renvoyé ; une erreur de stockage est propagée sans rien publier.
 */
export function publishCheckpoint(ctx: PublishContext, input: unknown): PublishResult {
  const limits = ctx.limits ?? DEFAULT_CHECKPOINT_LIMITS;
  const validation = validateCandidate(input, limits);
  if (!validation.valid) {
    const rejection = rejected(validation.reasons, validation.detail);
    journalRejection(ctx, input, rejection);
    return rejection;
  }
  const candidate = validation.candidate;
  const early = checkContext(ctx, candidate) ?? checkArtifacts(ctx, candidate, limits);
  if (early !== null) {
    journalRejection(ctx, candidate, early);
    return early;
  }
  const checkpoint = ctx.uow.transaction((uow): Checkpoint | Rejection => {
    // Recontrôle sous verrou d'écriture : la session a pu se terminer entre-temps.
    const late = checkContext({ ...ctx, uow }, candidate);
    if (late !== null) return late;
    const sequence = (uow.checkpoints.latest(candidate.experimentId)?.sequence ?? 0) + 1;
    const published: Checkpoint = {
      ...candidate,
      id: ctx.newId?.() ?? (`cp-${randomUUID()}` as CheckpointId),
      sequence,
      createdAt: ctx.now(),
    };
    uow.checkpoints.publish(published);
    uow.journal.append(
      prepareJournalEvent({
        type: "checkpoint_published",
        at: published.createdAt,
        profileId: ctx.profileId,
        sessionId: published.sessionId,
        experimentId: published.experimentId,
        reason: `checkpoint ${String(sequence)} publié`,
        metadata: {
          checkpointId: published.id,
          sequence,
          artifacts: published.artifacts.map((a) => ({ id: a.id, bytes: a.bytes })),
        },
      }),
    );
    ctx.beforeCommit?.();
    return published;
  });
  if ("status" in checkpoint) {
    journalRejection(ctx, candidate, checkpoint);
    return checkpoint;
  }
  return { status: "published", checkpoint };
}
