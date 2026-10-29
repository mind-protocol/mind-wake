/**
 * Registre des adapters du daemon (ADR-005) : factice, Codex, Claude Code, Gemini CLI.
 * Le runtime est choisi par la policy (`runtime.adapterId`) et seulement lui : aucun
 * repli automatique d'un runtime, d'un compte ou d'un fournisseur vers un autre. Un
 * identifiant connu mais non enregistré (adapter pas encore livré dans ce build) refuse
 * le démarrage ; un adapter enregistré n'est accepté que si `probe` le dit disponible.
 */

import {
  FAKE_ADAPTER_ID,
  FakeAdapter,
  fakeScenario,
  type FakeScenario,
} from "../adapters/fake/index.js";
import { codexRegistrationFromEnv } from "../adapters/codex/registration.js";
import type {
  AdapterId,
  ExperimentId,
  RuntimeAdapter,
  RuntimeGroup,
  SessionId,
} from "../contracts/index.js";
import type { BillingFacts } from "../policy/index.js";
import type { AdapterHost } from "../runner/index.js";
import { SIMULATED_RUNTIME } from "./environment.js";

/** Runtimes d'exploration de la v0.1 (AGENTS §2, ADR-005), plus l'adapter factice. */
export const RUNTIME_IDS = ["fake", "codex", "claude", "gemini"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

/** Services du daemon offerts à la fabrique d'un adapter. */
export interface AdapterFactoryContext {
  readonly host: AdapterHost;
  readonly dataDir: string;
  /** Espace d'exploration (racines de la policy). */
  readonly workspaceDir: string;
  /** Expérience de la session, choisie par l'agent ou reprise. */
  experimentFor(sessionId: SessionId): ExperimentId | null;
  /** Proposition d'expérience de l'agent : contenu non fiable, validé par le daemon. */
  onProposal(sessionId: SessionId, proposal: unknown): void;
  /** Scénario de l'agent factice pour la session (adapter factice seulement). */
  fakeScenario(sessionId: SessionId): FakeScenario | undefined;
}

export interface AdapterRegistration {
  readonly id: AdapterId;
  /** `true` pour l'adapter factice : sessions SIMULÉES, Job Object seul. */
  readonly simulated: boolean;
  /** Runtime réellement configuré, comparé champ à champ à la policy, sans substitution. */
  runtime(): RuntimeGroup;
  /** Facturation de ce runtime (`subscription_quota` pour un forfait borné par la jauge). */
  billing(): BillingFacts;
  /** Racines runtime à accorder en lecture et exécution dans la sandbox (CLI, Node…). */
  runtimeRoots?(): readonly string[];
  create(context: AdapterFactoryContext): RuntimeAdapter;
}

export const FAKE_REGISTRATION: AdapterRegistration = {
  id: FAKE_ADAPTER_ID,
  simulated: true,
  runtime: () => ({ adapterId: FAKE_ADAPTER_ID, ...SIMULATED_RUNTIME }),
  billing: () => ({ kind: "no_charge" }),
  create: (context) =>
    new FakeAdapter({
      host: context.host,
      scenario: (sessionId) => context.fakeScenario(sessionId) ?? fakeScenario("success"),
      experimentFor: (sessionId) =>
        context.experimentFor(sessionId) ?? ("exp-inconnue" as ExperimentId),
      onProposal: (sessionId, proposal) => {
        context.onProposal(sessionId, proposal);
      },
    }),
};

export class AdapterRegistry {
  readonly #entries = new Map<string, AdapterRegistration>();

  constructor(registrations: readonly AdapterRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: AdapterRegistration): void {
    if (this.#entries.has(registration.id)) {
      throw new Error(`adapter déjà enregistré : ${registration.id}`);
    }
    this.#entries.set(registration.id, registration);
  }

  get(id: AdapterId | string): AdapterRegistration | null {
    return this.#entries.get(id) ?? null;
  }

  /** Adapters réels enregistrés (hors factice). */
  realIds(): readonly AdapterId[] {
    return [...this.#entries.values()].filter((r) => !r.simulated).map((r) => r.id);
  }
}

/**
 * Registre de ce build. Les adapters Codex, Claude et Gemini (`src/adapters/<runtime>/`)
 * s'y ajoutent à leur fusion ; Codex est lu dans l'environnement du daemon
 * (`MIND_WAKE_CODEX_BIN`, `MIND_WAKE_CODEX_MODEL`, `MIND_WAKE_CODEX_EFFORT`).
 */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry([FAKE_REGISTRATION, codexRegistrationFromEnv()]);
}
