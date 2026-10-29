/**
 * Scénarios déterministes de l'adapter factice. Chaque scénario est un script d'étapes
 * exécuté par un vrai processus enfant (`agent-process.ts`) ; aucun appel modèle.
 */

import type { JsonObject } from "../../contracts/index.js";

export type FakeStep =
  | { readonly do: "activity"; readonly summary: string }
  | { readonly do: "usage"; readonly tokens: number }
  /** Action contrôlée soumise au runner ; l'agent attend le verdict avant de continuer. */
  | { readonly do: "action"; readonly action: JsonObject }
  | { readonly do: "sleep"; readonly ms: number }
  /** Lance `count` enfants détachés qui lancent chacun un petit-enfant détaché. */
  | { readonly do: "spawn_descendants"; readonly count: number }
  | { readonly do: "checkpoint"; readonly summary: string }
  | { readonly do: "rate_limited"; readonly retryAfterMs: number | null }
  | {
      readonly do: "error";
      readonly code: "auth_failed" | "incompatible" | "transient" | "fatal";
      readonly message: string;
    }
  /** Fin brutale du processus, sans événement de fin. */
  | { readonly do: "crash"; readonly exitCode: number }
  | { readonly do: "end"; readonly reason: string }
  /** Attend indéfiniment (jusqu'à une demande de checkpoint ou la terminaison). */
  | { readonly do: "idle" }
  /** Répète `times` fois les étapes données. */
  | { readonly do: "repeat"; readonly times: number; readonly steps: readonly FakeStep[] };

export interface FakeScenario {
  readonly name: string;
  readonly steps: readonly FakeStep[];
  /** Ignore les demandes de checkpoint et la fin de son entrée standard. */
  readonly stubborn?: boolean;
  /** Fichier où l'agent écrit les PID de toute sa descendance (tests). */
  readonly pidFile?: string;
}

export const FAKE_SCENARIO_NAMES = [
  "success",
  "slow",
  "rate_limited",
  "auth_error",
  "stubborn",
  "crash",
] as const;

export type FakeScenarioName = (typeof FAKE_SCENARIO_NAMES)[number];

export interface FakeScenarioOptions {
  readonly pidFile?: string;
  /** Nombre d'itérations du scénario `slow` (100 ms chacune). */
  readonly iterations?: number;
}

/** Scénario prédéfini ; même nom et mêmes options donnent toujours le même script. */
export function fakeScenario(
  name: FakeScenarioName,
  options: FakeScenarioOptions = {},
): FakeScenario {
  const pid = options.pidFile === undefined ? {} : { pidFile: options.pidFile };
  switch (name) {
    case "success":
      return {
        name,
        ...pid,
        steps: [
          { do: "activity", summary: "lecture de la mémoire et choix d'une hypothèse" },
          { do: "action", action: { kind: "file_write", path: "notes/hypothese.md" } },
          { do: "usage", tokens: 120 },
          { do: "checkpoint", summary: "hypothèse notée, prochaine action : la tester" },
          { do: "usage", tokens: 30 },
          { do: "end", reason: "travail borné terminé" },
        ],
      };
    case "slow":
      return {
        name,
        ...pid,
        steps: [
          { do: "spawn_descendants", count: 1 },
          {
            do: "repeat",
            times: options.iterations ?? 200,
            steps: [
              { do: "sleep", ms: 100 },
              { do: "action", action: { kind: "file_read", path: "notes/hypothese.md" } },
              { do: "usage", tokens: 10 },
            ],
          },
          { do: "end", reason: "itérations épuisées" },
        ],
      };
    case "rate_limited":
      return {
        name,
        ...pid,
        steps: [
          { do: "usage", tokens: 20 },
          { do: "rate_limited", retryAfterMs: 60_000 },
          { do: "idle" },
        ],
      };
    case "auth_error":
      return {
        name,
        ...pid,
        steps: [
          { do: "error", code: "auth_failed", message: "session fournisseur expirée (simulée)" },
        ],
      };
    case "stubborn":
      return {
        name,
        ...pid,
        stubborn: true,
        steps: [{ do: "spawn_descendants", count: 2 }, { do: "usage", tokens: 40 }, { do: "idle" }],
      };
    case "crash":
      return {
        name,
        ...pid,
        steps: [
          { do: "spawn_descendants", count: 1 },
          { do: "usage", tokens: 50 },
          { do: "sleep", ms: 50 },
          { do: "crash", exitCode: 70 },
        ],
      };
  }
}
