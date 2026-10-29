/**
 * `enable` : active une révision proposée par `policy configure`, seulement après
 * confirmation humaine sur le canal de confiance — saisie du code de confirmation dans
 * un terminal interactif, ou option `--confirm CODE` réservée à l'humain. Jamais par la
 * skill ni par l'espace d'exploration.
 *
 * Refus, profil laissé `disabled` avec un motif journalisé :
 * - aucune révision en attente, ou révision incomplète (limite obligatoire absente) ;
 * - stockage local déjà saturé au regard du plafond de la révision ;
 * - composants absents : isolation et adapter runtime ne sont pas livrés dans ce build ;
 * - confirmation absente ou erronée.
 *
 * Limite : la CLI ne peut pas distinguer un humain d'un agent qui dispose d'un shell.
 * La garantie structurelle vient de l'isolation (l'exploration n'atteint pas la CLI
 * d'administration, S10) et du jeton de canal de `src/policy/`, interne au processus.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ConsentId, PolicyRevision, ProfileId, UnitOfWork } from "../../contracts/index.js";
import { REQUIRED_LIMIT_FIELDS } from "../../contracts/index.js";
import { assessStorage, measureDataDir } from "../../export/index.js";
import { JournalWriter, toUtcTimestamp } from "../../journal/index.js";
import {
  classifyChange,
  decideActivation,
  grantConsent,
  openTrustedUserChannel,
  resolvePolicy,
  revisionDigest,
  validateDraft,
} from "../../policy/index.js";
import { BUILD_COMPONENTS, REAL_ADAPTERS } from "../capabilities.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { confirmationCode } from "./policy-configure.js";
import { NO_PROFILE_HINT } from "./read.js";

export interface EnableOptions {
  readonly revisionId: string | null;
  /** Code saisi par l'humain via `--confirm`. */
  readonly confirm: string | null;
  /** `--json` : jamais de saisie interactive. */
  readonly interactive: boolean;
}

/** Composants requis avant toute activation ; injectables pour les tests. */
export interface EnableComponents {
  readonly isolation: boolean;
  readonly runtimeAdapter: boolean;
  /**
   * Adapters réels enregistrés dans ce build : celui que désigne la policy doit en faire
   * partie (un adapter réel enregistré n'en rend pas un autre activable). Absent : non vérifié.
   */
  readonly realAdapters?: readonly string[];
}

export const ENABLE_REFUSALS = [
  "no_profile",
  "no_pending_revision",
  "unknown_revision",
  "already_consented",
  "missing_limit",
  "invalid_state",
  "emergency_stop_locked",
  "storage_saturated",
  "components_missing",
  "confirmation_required",
  "confirmation_mismatch",
  "consent_refused",
  "activation_denied",
] as const;

export type EnableRefusal = (typeof ENABLE_REFUSALS)[number];

export interface EnableData {
  readonly enabled: boolean;
  readonly profileId: string | null;
  readonly revisionId: string | null;
  readonly state: string | null;
  readonly refusal: { readonly code: EnableRefusal; readonly detail: string } | null;
  readonly confirmationChannel: "interactive_terminal" | "confirm_option" | null;
}

class Refusal extends Error {
  constructor(
    readonly code: EnableRefusal,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * Composants manquants. Avec le consentement au mode non isolé (ADR-006), l'isolation
 * n'est plus exigée ; un adapter réel enregistré l'est toujours.
 */
function missingComponents(
  components: EnableComponents,
  revision: PolicyRevision,
): readonly string[] {
  const missing: string[] = [];
  const hostUnsandboxed = revision.groups.runtime.hostUnsandboxedAcknowledged === true;
  if (!components.isolation && !hostUnsandboxed) missing.push("isolation non livrée dans ce build");
  if (!components.runtimeAdapter) {
    missing.push("adapter runtime non livré dans ce build");
  } else if (
    components.realAdapters !== undefined &&
    !components.realAdapters.includes(revision.groups.runtime.adapterId)
  ) {
    missing.push(
      `adapter runtime non livré dans ce build pour « ${revision.groups.runtime.adapterId} » (enregistrés : ${components.realAdapters.join(", ") || "aucun"})`,
    );
  }
  return missing;
}

/** Révision demandée, ou la dernière révision proposée sans consentement. */
function pendingRevision(
  uow: UnitOfWork,
  profileId: ProfileId,
  revisionId: string | null,
): PolicyRevision {
  const revisions = uow.policies.listRevisions(profileId);
  const revision =
    revisionId === null
      ? revisions.filter((r) => uow.policies.getConsent(r.id) === null).at(-1)
      : revisions.find((r) => r.id === revisionId);
  if (revision === undefined) {
    throw revisionId === null
      ? new Refusal(
          "no_pending_revision",
          "aucune révision en attente : préparer un brouillon avec `mind-wake policy configure <fichier.json>`",
        )
      : new Refusal("unknown_revision", `révision ${revisionId} inconnue pour ce profil`);
  }
  if (uow.policies.getConsent(revision.id) !== null) {
    throw new Refusal("already_consented", `révision ${revision.id} déjà confirmée`);
  }
  return revision;
}

function checkLimits(revision: PolicyRevision, profileId: ProfileId): void {
  const groups = revision.groups as unknown as Record<string, Record<string, unknown> | undefined>;
  const absent = REQUIRED_LIMIT_FIELDS.filter((field) => {
    const [group = "", name = ""] = field.split(".");
    return groups[group]?.[name] === undefined;
  });
  const check = validateDraft(revision.groups, profileId);
  const invalid = check.ok ? [] : check.issues.map((issue) => issue.field);
  const fields = [...new Set([...absent, ...invalid])];
  if (fields.length > 0) {
    throw new Refusal(
      "missing_limit",
      `limite obligatoire absente ou invalide : ${fields.join(", ")}`,
    );
  }
}

/** Exposé du risque affiché avant de confirmer le mode non isolé (ADR-006). */
export const HOST_UNSANDBOXED_WARNING =
  "ATTENTION — MODE NON ISOLÉ (ADR-006) : le runtime tournera sur ce poste avec ses options sans approbation et TOUS les droits de votre compte Windows (fichiers, secrets, réseau, comptes ouverts). Un contenu lu peut l'amener à supprimer, envoyer ou modifier sans contrôle. Seuls l'arrêt d'urgence, la pause, la priorité humaine, la garde de quota et le journal restent imposés. Un compte Windows dédié est recommandé.";

async function confirm(
  ctx: CliContext,
  options: EnableOptions,
  revision: PolicyRevision,
  digest: string,
  change: ReturnType<typeof classifyChange>,
): Promise<EnableData["confirmationChannel"]> {
  const code = confirmationCode(digest);
  if (options.confirm !== null) {
    const given = options.confirm.trim().toLowerCase();
    if (given !== code && given !== digest) {
      throw new Refusal(
        "confirmation_mismatch",
        "code de confirmation erroné : rien n'a été activé",
      );
    }
    return "confirm_option";
  }
  if (!options.interactive || ctx.prompt === undefined) {
    throw new Refusal(
      "confirmation_required",
      "confirmation humaine requise : lancer `mind-wake enable` dans un terminal interactif, ou passer --confirm CODE (option réservée à l'humain)",
    );
  }
  ctx.stdout(
    [
      `Révision ${revision.id} — empreinte ${digest}`,
      `Nature : ${change.kind} ; élargit : ${change.widened.join(", ") || "rien"}`,
      `Plafonds : ${String(revision.groups.budget.tokensPerSession)} tokens/session, ${String(revision.groups.budget.tokensPerPeriod)} tokens et ${String(revision.groups.budget.sessionsPerPeriod)} sessions par ${revision.groups.budget.period.kind}`,
      ...(revision.groups.runtime.hostUnsandboxedAcknowledged === true
        ? ["", HOST_UNSANDBOXED_WARNING]
        : []),
      "",
    ].join("\n"),
  );
  const answer = await ctx.prompt(`Pour activer, taper le code ${code} : `);
  if (answer?.trim().toLowerCase() !== code) {
    throw new Refusal("confirmation_mismatch", "confirmation non saisie : rien n'a été activé");
  }
  return "interactive_terminal";
}

export async function enable(
  ctx: CliContext,
  dataDir: DataDir,
  options: EnableOptions,
  components: EnableComponents = {
    isolation: BUILD_COMPONENTS.isolation,
    runtimeAdapter: BUILD_COMPONENTS.runtimeAdapter,
    realAdapters: REAL_ADAPTERS,
  },
): Promise<CommandResult<EnableData>> {
  const refused = (
    code: EnableRefusal,
    detail: string,
    rest: Partial<EnableData> = {},
  ): CommandResult<EnableData> => ({
    exitCode: EXIT_FAILURE,
    data: {
      enabled: false,
      profileId: null,
      revisionId: null,
      state: null,
      confirmationChannel: null,
      ...rest,
      refusal: { code, detail },
    },
    human: formatEnable,
  });
  if (!fs.existsSync(dataDir.path)) return refused("no_profile", NO_PROFILE_HINT);

  const store = ctx.openStore(dataDir.path, "write");
  try {
    const { uow } = store;
    const profile = uow.profiles.get(DEFAULT_PROFILE_ID);
    if (profile === null) return refused("no_profile", NO_PROFILE_HINT);
    let revisionId: string | null = options.revisionId;
    try {
      const revision = pendingRevision(uow, profile.id, options.revisionId);
      revisionId = revision.id;
      checkLimits(revision, profile.id);
      if (profile.emergencyStopLocked) {
        throw new Refusal(
          "emergency_stop_locked",
          "arrêt d'urgence verrouillé : la reprise passe par une action explicite dédiée",
        );
      }
      if (profile.state !== "disabled") {
        throw new Refusal(
          "invalid_state",
          `enable active un profil désactivé ; profil en état ${profile.state}`,
        );
      }
      const storage = assessStorage(
        measureDataDir(dataDir.path),
        revision.groups.data.localStorageCapBytes,
      );
      if (storage.status === "saturated") throw new Refusal("storage_saturated", storage.detail);
      const missing = missingComponents(components, revision);
      if (missing.length > 0) {
        throw new Refusal(
          "components_missing",
          `activation impossible, profil laissé disabled : ${missing.join(" ; ")}`,
        );
      }

      const resolution = resolvePolicy(uow.policies, profile.id);
      const base =
        resolution.status === "active" || resolution.status === "revoked"
          ? resolution.revision.groups
          : null;
      const digest = revisionDigest(revision);
      const channel = await confirm(
        ctx,
        options,
        revision,
        digest,
        classifyChange(base, revision.groups),
      );
      const code = confirmationCode(digest);

      const at = toUtcTimestamp(ctx.now());
      const state = uow.transaction((tx) => {
        const consent = grantConsent(tx, openTrustedUserChannel(), {
          consentId: `consent-${randomUUID()}` as ConsentId,
          revisionId: revision.id,
          profileId: profile.id,
          at,
          confirmedDigest: digest,
          proof: `enable:${channel ?? "inconnu"}:${code}`,
        });
        if (consent.status === "refused") {
          throw new Refusal("consent_refused", `consentement refusé : ${consent.reason}`);
        }
        const decision = decideActivation(tx.policies, profile.id);
        if (decision.verdict === "deny") {
          // Annule aussi le consentement : pas de révision consentie sans activation.
          throw new Refusal("activation_denied", `${decision.reason} : ${decision.detail}`);
        }
        const reason = `activé par l'humain (révision ${revision.id})`;
        tx.profiles.transition(profile.id, { from: "disabled", to: "ready", reason, at });
        tx.profiles.setActivePolicyRevision(profile.id, revision.id);
        new JournalWriter(tx.journal).record({
          type: "profile_state_changed",
          at,
          profileId: profile.id,
          policyRevisionId: revision.id,
          reason,
          metadata: { from: "disabled", to: "ready", command: "enable", channel },
        });
        return "ready";
      });
      return {
        exitCode: EXIT_OK,
        data: {
          enabled: true,
          profileId: profile.id,
          revisionId: revision.id,
          state,
          refusal: null,
          confirmationChannel: channel,
        },
        human: formatEnable,
      };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      recordRefusal(uow, profile.id, revisionId, error, ctx);
      return refused(error.code, error.detail, {
        profileId: profile.id,
        revisionId,
        state: uow.profiles.get(profile.id)?.state ?? profile.state,
      });
    }
  } finally {
    store.close();
  }
}

function recordRefusal(
  uow: UnitOfWork,
  profileId: ProfileId,
  revisionId: string | null,
  refusal: Refusal,
  ctx: CliContext,
): void {
  uow.transaction((tx) => {
    new JournalWriter(tx.journal).record({
      type: "action_denied",
      at: toUtcTimestamp(ctx.now()),
      profileId,
      reason: `activation refusée : ${refusal.detail}`,
      metadata: { action: "enable", refusal: refusal.code, revisionId },
    });
  });
}

function formatEnable(data: EnableData): string {
  if (data.enabled) {
    return [
      `Profil « ${data.profileId ?? "—"} » activé (état ${data.state ?? "—"}) avec la révision ${data.revisionId ?? "—"}.`,
      "Aucune session n'est lancée par cette commande.",
    ].join("\n");
  }
  return [
    `Activation refusée [${data.refusal?.code ?? "—"}] : ${data.refusal?.detail ?? "—"}`,
    data.state === null ? "" : `Profil laissé en état ${data.state}.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
