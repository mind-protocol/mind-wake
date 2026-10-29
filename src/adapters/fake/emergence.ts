/**
 * Agent factice de la démo (AGENTS §7), SIMULÉ : thème « petits systèmes émergents ».
 * Les choix de l'agent sont scriptés ici, de façon déterministe, à partir de la seule
 * mémoire qu'il reçoit au réveil ; le calcul (automate cellulaire élémentaire) est réel
 * et ses résultats sont écrits comme artefacts par le processus de l'agent. Aucun appel
 * modèle : la « réflexion » d'un vrai agent n'est pas simulée, seulement ses effets.
 *
 * - Mémoire vide : session A — proposition d'expérience, première tentative sur un petit
 *   anneau, échec documenté (cycle), hypothèse, checkpoint.
 * - Mémoire avec l'observation `largeur=N` : session B — reprise, anneau quatre fois plus
 *   large, petit résultat, hypothèse restante, checkpoint.
 * - Au-delà : session de continuation longue et coopérative (démo des contrôles).
 */

import type { MemoryItem } from "../../checkpoint/index.js";
import type { FakeScenario, FakeStep } from "./scenarios.js";

export interface EcaRun {
  readonly rule: number;
  readonly width: number;
  readonly steps: number;
  /** Premier pas où un état déjà vu réapparaît, et période du cycle ; `null` sans cycle. */
  readonly repeatAt: number | null;
  readonly period: number | null;
  /** Nombre de 1 dans la colonne centrale, pas 0 compris. */
  readonly centerOnes: number;
  readonly rows: readonly string[];
}

/** Automate cellulaire élémentaire sur un anneau, graine unique au centre. */
export function runEca(rule: number, width: number, steps: number): EcaRun {
  let state: number[] = Array.from({ length: width }, (_, i) =>
    i === Math.floor(width / 2) ? 1 : 0,
  );
  const seen = new Map<string, number>([[state.join(""), 0]]);
  const rows = [state.join("")];
  const centre = Math.floor(width / 2);
  let centerOnes = state[centre] ?? 0;
  for (let t = 1; t <= steps; t += 1) {
    const prev = state;
    state = prev.map((cell, i) => {
      const left = prev[(i - 1 + width) % width] ?? 0;
      const right = prev[(i + 1) % width] ?? 0;
      return (rule >> ((left << 2) | (cell << 1) | right)) & 1;
    });
    const key = state.join("");
    rows.push(key);
    centerOnes += state[centre] ?? 0;
    const first = seen.get(key);
    if (first !== undefined) {
      return { rule, width, steps: t, repeatAt: t, period: t - first, centerOnes, rows };
    }
    seen.set(key, t);
  }
  return { rule, width, steps, repeatAt: null, period: null, centerOnes, rows };
}

function render(run: EcaRun): string {
  const header = [
    `# Règle ${String(run.rule)}, anneau de ${String(run.width)} cellules (SIMULÉ : agent factice)`,
    run.repeatAt === null
      ? `# ${String(run.steps)} pas, aucun état répété`
      : `# état répété au pas ${String(run.repeatAt)}, période ${String(run.period)}`,
    `# colonne centrale : ${String(run.centerOnes)} cellules à 1 sur ${String(run.rows.length)}`,
  ];
  return `${[...header, ...run.rows.map((r) => r.replace(/0/g, ".").replace(/1/g, "#"))].join("\n")}\n`;
}

export interface EmergenceOptions {
  /** Racine d'artefacts absolue, écrite par l'agent. */
  readonly artifactRoot: string;
  /** Préfixe de la racine d'artefacts, relatif à l'espace d'exploration (policy). */
  readonly artifactsSegment: string;
  /** Mémoire chargée au réveil (`loadWakeMemory`), dans le budget d'entrée. */
  readonly memory: readonly MemoryItem[];
  /** Séquence du dernier checkpoint de l'expérience active, `null` sans expérience. */
  readonly lastCheckpoint: number | null;
  /** Itérations de 100 ms de la session de continuation. */
  readonly continuationIterations?: number;
}

const FIRST_WIDTH = 10;
const FIRST_STEPS = 64;
const RESUMED_STEPS = 256;

function artifactStep(options: EmergenceOptions, id: string, path: string, run: EcaRun): FakeStep {
  return {
    do: "write_artifact",
    id,
    root: options.artifactRoot,
    path,
    actionPath: `${options.artifactsSegment}/${path}`,
    content: render(run),
  };
}

function sessionA(options: EmergenceOptions): FakeScenario {
  const run = runEca(30, FIRST_WIDTH, FIRST_STEPS);
  const cycle =
    run.repeatAt === null
      ? `largeur=${String(FIRST_WIDTH)} pas=${String(FIRST_STEPS)} : aucun cycle observé`
      : `largeur=${String(FIRST_WIDTH)} pas=${String(FIRST_STEPS)} : état répété au pas ${String(run.repeatAt)}, cycle de période ${String(run.period)}`;
  return {
    name: "emergence-a",
    steps: [
      {
        do: "activity",
        summary: "mémoire vide : choix d'une expérience (petits systèmes émergents)",
      },
      { do: "usage", tokens: 220 },
      {
        do: "propose",
        proposal: {
          title: "Règle 30 sur un anneau : la colonne centrale reste-t-elle désordonnée ?",
          question:
            "Sur un anneau fini, la colonne centrale de la règle 30 garde-t-elle environ 50 % de 1 sans se répéter ?",
          motivation:
            "Petit système émergent, entièrement local et synthétique ; un échec est instructif",
          firstAction: `simuler la règle 30 sur ${String(FIRST_WIDTH)} cellules pendant ${String(FIRST_STEPS)} pas`,
          stopCondition:
            "conclure si une largeur modeste évite tout cycle sur 256 pas ; abandonner sinon",
          writeRoots: [options.artifactsSegment],
        },
      },
      artifactStep(options, "eca-r30-w10", `eca/rule30-w${String(FIRST_WIDTH)}.txt`, run),
      { do: "usage", tokens: 310 },
      {
        do: "checkpoint",
        summary: "première tentative : petit anneau, la colonne centrale entre dans un cycle",
        observations: [
          { text: cycle, confidence: "observed" },
          {
            text: "sur un anneau assez large, la colonne centrale resterait proche de 50 % de 1",
            confidence: "hypothesis",
          },
        ],
        failures: [
          `anneau de ${String(FIRST_WIDTH)} cellules trop petit : la séquence centrale devient périodique`,
        ],
        incompleteWork: ["mesurer la colonne centrale sur un anneau sans cycle"],
        nextAction: `relancer avec une largeur quatre fois plus grande sur ${String(RESUMED_STEPS)} pas`,
        hibernationReason: "première tentative terminée",
        withArtifacts: true,
      },
      { do: "usage", tokens: 40 },
      { do: "end", reason: "session A terminée" },
    ],
  };
}

function sessionB(options: EmergenceOptions, previousWidth: number, from: number): FakeScenario {
  const width = previousWidth * 4;
  const run = runEca(30, width, RESUMED_STEPS);
  const total = run.rows.length;
  const pct = ((run.centerOnes / total) * 100).toFixed(1);
  const result =
    run.repeatAt === null
      ? `largeur=${String(width)} pas=${String(RESUMED_STEPS)} : aucun état répété ; colonne centrale ${String(run.centerOnes)}/${String(total)} à 1 (${pct} %)`
      : `largeur=${String(width)} : état répété au pas ${String(run.repeatAt)}`;
  return {
    name: "emergence-b",
    steps: [
      {
        do: "activity",
        summary: `reprise depuis le checkpoint ${String(from)} : largeur=${String(previousWidth)} trop petite, essai à ${String(width)}`,
      },
      { do: "usage", tokens: 180 },
      artifactStep(options, `eca-r30-w${String(width)}`, `eca/rule30-w${String(width)}.txt`, run),
      { do: "usage", tokens: 260 },
      {
        do: "checkpoint",
        summary: `reprise : anneau de ${String(width)} cellules, pas de cycle sur ${String(RESUMED_STEPS)} pas`,
        observations: [
          { text: result, confidence: "observed" },
          {
            text: `l'observation du checkpoint ${String(from)} (cycle à largeur=${String(previousWidth)}) a fixé la nouvelle largeur`,
            confidence: "inferred",
          },
          {
            text: "l'équilibre à 50 % au-delà de 256 pas et pour d'autres règles reste non démontré",
            confidence: "hypothesis",
          },
        ],
        failures: [],
        incompleteWork: ["vérifier sur 1024 pas et comparer aux règles 90 et 110"],
        nextAction: "étendre la mesure à 1024 pas",
        hibernationReason: "petit résultat obtenu, budget de session préservé",
        withArtifacts: true,
      },
      { do: "usage", tokens: 40 },
      { do: "end", reason: "session B terminée" },
    ],
  };
}

function continuation(options: EmergenceOptions): FakeScenario {
  return {
    name: "emergence-continuation",
    steps: [
      {
        do: "activity",
        summary: "continuation : mesure longue, coopère aux demandes de checkpoint",
      },
      {
        do: "repeat",
        times: options.continuationIterations ?? 600,
        steps: [
          { do: "sleep", ms: 100 },
          {
            do: "action",
            action: { kind: "file_read", path: `${options.artifactsSegment}/eca` },
          },
          { do: "usage", tokens: 2 },
        ],
      },
      { do: "end", reason: "mesure longue terminée" },
    ],
  };
}

/** Largeur observée dans la mémoire (`largeur=N`, observation déclarée observée). */
function observedWidth(memory: readonly MemoryItem[]): number | null {
  for (const item of memory) {
    if (item.kind !== "observed") continue;
    const match = /largeur=(\d{1,4})\b/.exec(item.text);
    if (match !== null) return Number(match[1]);
  }
  return null;
}

/** Scénario de la prochaine session, choisi d'après la seule mémoire reçue. */
export function emergenceScenario(options: EmergenceOptions): FakeScenario {
  if (options.lastCheckpoint === null) return sessionA(options);
  const width = observedWidth(options.memory);
  if (options.lastCheckpoint === 1 && width !== null) {
    return sessionB(options, width, options.lastCheckpoint);
  }
  return continuation(options);
}
