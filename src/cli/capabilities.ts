/**
 * Disponibilité réelle des composants, affichée par `doctor` et `status`. Chaque
 * composant est présent, simulé, expérimental, bloqué ou non implémenté ; rien n'est
 * présenté comme opérationnel sur la foi d'un contrat, d'un mock ou d'un consentement.
 */

import type { PolicyRevision, SubscriptionQuotaGuard } from "../contracts/index.js";
import { defaultRegistry } from "../daemon/registry.js";
import type { Persistence } from "./store/index.js";

/** Adapters réels enregistrés dans ce build (Codex, Claude, Gemini à leur fusion). */
const REAL_ADAPTERS = defaultRegistry().realIds();

export const AVAILABILITIES = [
  "present",
  "simulated",
  "experimental",
  "blocked",
  "not_implemented",
] as const;

export type Availability = (typeof AVAILABILITIES)[number];

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  present: "présent",
  simulated: "simulé",
  experimental: "expérimental",
  blocked: "bloqué",
  not_implemented: "non implémenté",
};

export type CapabilityId =
  | "journal"
  | "persistence"
  | "ledger"
  | "policy_engine"
  | "scheduler"
  | "daemon"
  | "isolation"
  | "simulated_adapter"
  | "runtime_adapter"
  | "api_key_path"
  | "subscription_path";

export interface Capability {
  readonly id: CapabilityId;
  readonly availability: Availability;
  readonly detail: string;
  /** Motifs de blocage, vides sauf pour `blocked`. */
  readonly blockers: readonly string[];
}

/** Composants livrés dans ce build. À mettre à jour à chaque câblage réel. */
export const BUILD_COMPONENTS: Readonly<
  Record<
    | "ledger"
    | "policyEngine"
    | "scheduler"
    | "daemon"
    | "simulatedAdapter"
    | "isolation"
    | "runtimeAdapter",
    boolean
  >
> = {
  ledger: true,
  policyEngine: true,
  scheduler: true,
  /** Daemon au premier plan (`daemon run`), sans service ni démarrage automatique. */
  daemon: true,
  /** Adapter factice : sessions SIMULÉES, jamais une preuve d'intégration réelle. */
  simulatedAdapter: true,
  /**
   * Sandbox AppContainer + Job Object (S10) câblée au runner : tout adapter réel y est
   * lancé, seulement après un autotest de refus réussi. « Présente » sur un poste
   * seulement quand cet autotest a réussi (`doctor`, ou daemon en mode réel).
   */
  isolation: true,
  /** Adapter réel enregistré dans le registre du daemon (Codex, Claude, Gemini). */
  runtimeAdapter: REAL_ADAPTERS.length > 0,
};

/**
 * Voie abonnement (AGENTS §5, ADR-004) : au mieux « expérimentale », jamais autorisée.
 * Bloquée tant qu'une condition manque. Les seuils sont des points de base d'une jauge
 * fournisseur, jamais convertis en tokens.
 */
export function subscriptionPath(
  guard: SubscriptionQuotaGuard | undefined,
  available: { readonly adapter: boolean; readonly isolation: boolean },
): Capability {
  const blockers: string[] = [];
  if (guard?.enabled !== true) {
    blockers.push("désactivée par défaut : aucun consentement distinct au risque de compte");
  } else if (guard.overshootBoundBasisPoints === null) {
    blockers.push("dépassement après le seuil d'arrêt non mesuré : aucune borne démontrée");
  } else if (
    guard.stopAtBasisPoints + guard.overshootBoundBasisPoints >
    10_000 - guard.userReserveBasisPoints
  ) {
    blockers.push("seuil d'arrêt + dépassement mesuré empiète sur la réserve humaine");
  }
  if (!available.adapter) blockers.push("aucun adapter réel enregistré dans ce build");
  if (!available.isolation)
    blockers.push("isolation non vérifiée sur ce poste (autotest de refus)");
  const base =
    "voie expérimentale, non autorisée explicitement par le fournisseur ; jauge en pourcentage, sans conversion en tokens";
  return blockers.length === 0
    ? { id: "subscription_path", availability: "experimental", detail: base, blockers }
    : { id: "subscription_path", availability: "blocked", detail: base, blockers };
}

/**
 * Résultat de l'autotest de refus de la couche d'isolation (`src/sandbox`), exécuté par
 * `doctor` sur le poste. Sans autotest, l'isolation reste « non implémentée » : le code
 * livré ne vaut rien tant que le système n'a pas refusé réellement chaque sortie.
 */
export interface IsolationAssessment {
  readonly passed: boolean;
  readonly detail: string;
  readonly blockers: readonly string[];
}

export function isolationCapability(
  assessment: IsolationAssessment | undefined,
  built: boolean = BUILD_COMPONENTS.isolation,
): Capability {
  if (assessment === undefined) {
    return built
      ? {
          id: "isolation",
          availability: "blocked",
          detail:
            "sandbox AppContainer + Job Object câblée au runner, non vérifiée sur ce poste : exécution autonome impossible",
          blockers: [
            "aucun autotest de refus réussi connu : `mind-wake doctor` ou `daemon run` l'exécutent",
          ],
        }
      : {
          id: "isolation",
          availability: "not_implemented",
          detail: "aucune sandbox vérifiée sur ce poste : exécution autonome impossible",
          blockers: [],
        };
  }
  return assessment.passed
    ? { id: "isolation", availability: "present", detail: assessment.detail, blockers: [] }
    : {
        id: "isolation",
        availability: "blocked",
        detail: assessment.detail,
        blockers: assessment.blockers,
      };
}

/** Mode NON ISOLÉ consenti (ADR-006) : affiché tel quel, jamais comme une isolation. */
function unsandboxedCapability(isolation: IsolationAssessment | undefined): Capability {
  const sandbox =
    isolation === undefined
      ? "sandbox non vérifiée"
      : isolation.passed
        ? "sandbox vérifiée mais non utilisée"
        : "sandbox en échec";
  return {
    id: "isolation",
    availability: "experimental",
    detail: `NON ISOLÉ (ADR-006, consentement distinct) : runtimes réels sur le poste hôte avec leurs options sans approbation, accès complet au compte Windows ; arrêt d'urgence (Job Object), pause, priorité humaine et garde de quota restent imposés (${sandbox})`,
    blockers: [],
  };
}

export function capabilities(
  persistence: Persistence | null,
  activePolicy: PolicyRevision | null,
  isolation?: IsolationAssessment,
): readonly Capability[] {
  const hostUnsandboxed = activePolicy?.groups.runtime.hostUnsandboxedAcknowledged === true;
  const notImplemented = (id: CapabilityId, detail: string): Capability => ({
    id,
    availability: "not_implemented",
    detail,
    blockers: [],
  });
  return [
    {
      id: "journal",
      availability: "present",
      detail:
        "journal séquencé, expurgation heuristique (formats connus, clés sensibles) : ne garantit pas l'absence de toute fuite",
      blockers: [],
    },
    persistence === "sqlite"
      ? { id: "persistence", availability: "present", detail: "SQLite", blockers: [] }
      : notImplemented(
          "persistence",
          "stockage SQLite non câblé : état en mémoire, perdu à la fin de la commande",
        ),
    persistence === "sqlite" && BUILD_COMPONENTS.ledger
      ? {
          id: "ledger",
          availability: "present",
          detail:
            "réservations atomiques et rapprochement idempotent (SQLite) ; sollicité par le daemon, en sessions simulées seulement",
          blockers: [],
        }
      : notImplemented("ledger", "réservations et disponibilité budgétaire non câblées"),
    persistence === "sqlite" && BUILD_COMPONENTS.policyEngine
      ? {
          id: "policy_engine",
          availability: "present",
          detail:
            "décisions de lancement et d'action rendues avant chaque session et chaque action contrôlée",
          blockers: [],
        }
      : notImplemented("policy_engine", "aucune décision d'autorisation n'est rendue"),
    persistence === "sqlite" && BUILD_COMPONENTS.scheduler
      ? {
          id: "scheduler",
          availability: "present",
          detail:
            "réveils, fenêtres, backoff et réservation atomique ; exécuté seulement par `daemon run`",
          blockers: [],
        }
      : notImplemented("scheduler", "aucun réveil planifié"),
    persistence === "sqlite" && BUILD_COMPONENTS.daemon
      ? {
          id: "daemon",
          availability: "simulated",
          detail:
            REAL_ADAPTERS.length === 0
              ? "`daemon run --simulated` au premier plan, adapter factice seulement (mode réel câblé, aucun adapter réel enregistré) ; aucun service, tâche planifiée ni démarrage automatique"
              : "`daemon run` au premier plan, adapter de la policy, sessions réelles confinées dans la sandbox ; aucun service, tâche planifiée ni démarrage automatique",
          blockers: [],
        }
      : notImplemented("daemon", "aucun daemon"),
    hostUnsandboxed ? unsandboxedCapability(isolation) : isolationCapability(isolation),
    BUILD_COMPONENTS.simulatedAdapter
      ? {
          id: "simulated_adapter",
          availability: "simulated",
          detail:
            "adapter factice : agent scripté, aucun appel modèle, consommation SIMULÉE ; jamais une preuve d'intégration",
          blockers: [],
        }
      : notImplemented("simulated_adapter", "aucun adapter factice"),
    REAL_ADAPTERS.length === 0
      ? notImplemented(
          "runtime_adapter",
          "aucun adapter réel enregistré (codex, claude, gemini) : aucune session réelle possible",
        )
      : {
          id: "runtime_adapter",
          availability: "experimental",
          detail: `adapters réels enregistrés : ${REAL_ADAPTERS.join(", ")} ; lancés dans la sandbox, ou sur le poste hôte NON ISOLÉ si la policy le consent (ADR-006) ; sans repli d'un runtime vers un autre`,
          blockers: [],
        },
    notImplemented("api_key_path", "voie clé API (ADR-002) non implémentée"),
    subscriptionPath(activePolicy?.groups.budget.subscriptionQuota, {
      adapter: BUILD_COMPONENTS.runtimeAdapter,
      isolation: isolation?.passed === true || hostUnsandboxed,
    }),
  ];
}

/** Points de base d'une jauge fournisseur → pourcentage lisible (pas une quantité de tokens). */
export function basisPointsToPercent(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")} %`;
}

export function formatCapability(c: Capability): string {
  const blockers = c.blockers.length === 0 ? "" : ` — motifs : ${c.blockers.join(" ; ")}`;
  return `  [${AVAILABILITY_LABEL[c.availability].toUpperCase()}] ${c.id} : ${c.detail}${blockers}`;
}
