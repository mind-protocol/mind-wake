/**
 * Choix d'expérience par l'agent (SPEC §3.2) : la proposition arrive du processus de
 * l'agent, donc non fiable. Le daemon la valide (forme, tailles, aucun secret), vérifie
 * que les ressources demandées restent dans la policy déjà consentie — une permission
 * supplémentaire n'est jamais auto-accordée — puis enregistre l'expérience active et la
 * rattache à la session en cours, dans une seule transaction.
 */

import { randomUUID } from "node:crypto";
import type {
  ExperimentId,
  ExperimentRecord,
  PolicyRevision,
  ProfileId,
  SessionId,
  UnitOfWork,
  UtcTimestamp,
} from "../contracts/index.js";
import { prepareJournalEvent, redactString } from "../journal/index.js";
import type { SqliteDatabase } from "../store/index.js";

export interface ExperimentProposal {
  readonly title: string;
  readonly question: string;
  readonly motivation: string;
  readonly firstAction: string;
  readonly stopCondition: string;
  /** Racines d'écriture nécessaires, relatives à l'espace d'exploration. */
  readonly writeRoots: readonly string[];
}

export type ProposalOutcome =
  | { readonly status: "accepted"; readonly experiment: ExperimentRecord }
  | { readonly status: "refused"; readonly reason: string };

const TEXT_FIELDS = ["title", "question", "motivation", "firstAction", "stopCondition"] as const;
const MAX_TITLE = 120;
const MAX_TEXT = 600;
const MAX_ROOTS = 8;

/** Forme stricte : toute clé inconnue, tout texte vide, trop long ou secret est refusé. */
export function parseProposal(input: unknown): ExperimentProposal | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "proposition : objet attendu";
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set<string>([...TEXT_FIELDS, "writeRoots"]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return `proposition : champ inconnu (${unknown.join(", ")})`;
  for (const field of TEXT_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") return `proposition : ${field} absent`;
    if (value.length > (field === "title" ? MAX_TITLE : MAX_TEXT)) {
      return `proposition : ${field} trop long`;
    }
    if (redactString(value) !== value) return `proposition : ${field} contient un secret`;
  }
  const roots = record["writeRoots"];
  if (
    !Array.isArray(roots) ||
    roots.length > MAX_ROOTS ||
    !roots.every((root): root is string => typeof root === "string" && root !== "")
  ) {
    return "proposition : writeRoots invalide";
  }
  return {
    title: record["title"] as string,
    question: record["question"] as string,
    motivation: record["motivation"] as string,
    firstAction: record["firstAction"] as string,
    stopCondition: record["stopCondition"] as string,
    writeRoots: roots,
  };
}

/** Une racine demandée est couverte si elle est égale ou sous une racine accordée. */
function covered(requested: string, granted: readonly string[]): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(requested);
  return granted.some((g) => r === norm(g) || r.startsWith(`${norm(g)}/`));
}

export interface ProposalContext {
  readonly uow: UnitOfWork;
  readonly db: SqliteDatabase;
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  readonly revision: PolicyRevision;
  readonly now: () => UtcTimestamp;
  readonly simulated: boolean;
  readonly newId?: () => string;
}

export function registerProposal(ctx: ProposalContext, input: unknown): ProposalOutcome {
  const at = ctx.now();
  const refuse = (reason: string): ProposalOutcome => {
    ctx.uow.journal.append(
      prepareJournalEvent({
        type: "action_denied",
        at,
        profileId: ctx.profileId,
        sessionId: ctx.sessionId,
        reason: `proposition d'expérience refusée : ${reason}`,
        metadata: { action: "propose_experiment", simulated: ctx.simulated },
      }),
    );
    return { status: "refused", reason };
  };
  const proposal = parseProposal(input);
  if (typeof proposal === "string") return refuse(proposal);
  const missing = proposal.writeRoots.filter(
    (root) => !covered(root, ctx.revision.groups.filesAndTools.writeRoots),
  );
  if (missing.length > 0) {
    return refuse(
      `permission d'écriture non accordée (${missing.join(", ")}) : en attente humaine`,
    );
  }
  return ctx.uow.transaction((tx): ProposalOutcome => {
    if (tx.experiments.getActive(ctx.profileId) !== null) {
      return refuse("une expérience est déjà active");
    }
    const session = tx.sessions.get(ctx.sessionId);
    if (session?.outcome !== null || session.experimentId !== null) {
      return refuse("session close ou déjà rattachée à une expérience");
    }
    const experiment: ExperimentRecord = {
      id: `exp-${ctx.newId?.() ?? randomUUID()}` as ExperimentId,
      profileId: ctx.profileId,
      title: proposal.title,
      question: proposal.question,
      status: "active",
      statusReason: ctx.simulated ? "choisie par l'agent (SIMULÉ)" : "choisie par l'agent",
      currentCheckpointId: null,
      createdAt: at,
      updatedAt: at,
    };
    tx.experiments.upsert(experiment);
    // `SessionRepository` ne permet pas de rattacher une session après sa création :
    // écriture directe, limitée à une session ouverte encore sans expérience.
    const attached = ctx.db
      .prepare(
        "UPDATE sessions SET experiment_id = ? WHERE id = ? AND experiment_id IS NULL AND outcome IS NULL",
      )
      .run(experiment.id, ctx.sessionId);
    if (attached.changes !== 1) throw new Error("rattachement de la session impossible");
    tx.journal.append(
      prepareJournalEvent({
        type: "experiment_chosen",
        at,
        profileId: ctx.profileId,
        sessionId: ctx.sessionId,
        experimentId: experiment.id,
        policyRevisionId: ctx.revision.id,
        reason: `expérience choisie par l'agent${ctx.simulated ? " (SIMULÉ)" : ""} : ${proposal.title}`,
        metadata: {
          question: proposal.question,
          motivation: proposal.motivation,
          firstAction: proposal.firstAction,
          stopCondition: proposal.stopCondition,
          writeRoots: [...proposal.writeRoots],
          simulated: ctx.simulated,
        },
      }),
    );
    return { status: "accepted", experiment };
  });
}
