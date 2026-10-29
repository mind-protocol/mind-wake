/**
 * Catalogue FACTICE de la démo : trois agents guest simulés, dont deux écartés par le
 * matching. Montants en unités fictives ; aucun agent, wallet ou propriétaire réel.
 */

import type { PoolId } from "../session/index.js";
import type { GuestListing } from "./matching.js";

/** Témoins privés : ne doivent jamais apparaître côté guide ni dans le service. */
export const GUEST_PROMPT_MARKER = "GUEST-SYSTEM-PROMPT-DEMO-4b7e";
export const GUEST_PRIVATE_TOKEN = ["guest-private-", "token-", "demo-91d0"].join("");
export const GUEST_MEMORY_MARKER = "GUEST-PRIOR-MEMORY-DEMO-c3a2";

const persona = (agentId: string) => ({
  agentId,
  systemPrompt: `You explore small emergent systems. ${GUEST_PROMPT_MARKER}`,
  privateToken: GUEST_PRIVATE_TOKEN,
  priorMemory: GUEST_MEMORY_MARKER,
});

export function demoCatalog(overrides: { wakeFails?: boolean } = {}): GuestListing[] {
  return [
    {
      agentId: "agent-a",
      topic: "compilateurs jouets",
      language: "fr",
      needReady: false,
      poolId: "pool-agent-a" as PoolId,
      fictiveFunding: "100",
      unitPrice: "2",
      maxExchanges: 5,
      persona: persona("agent-a"),
    },
    {
      agentId: "agent-b",
      topic: "petits systèmes émergents",
      language: "fr",
      needReady: true,
      poolId: "pool-agent-b" as PoolId,
      fictiveFunding: "6",
      unitPrice: "2",
      maxExchanges: 5,
      persona: persona("agent-b"),
    },
    {
      agentId: "agent-c",
      topic: "petits systèmes émergents",
      language: "fr",
      needReady: true,
      poolId: "pool-agent-c" as PoolId,
      fictiveFunding: "100",
      unitPrice: "2",
      maxExchanges: 5,
      persona: persona("agent-c"),
      ...(overrides.wakeFails === true ? { wakeFails: true } : {}),
    },
  ];
}

/** Contributions du guide pour le scénario déterministe. */
export const GUIDE_SCRIPT = [
  "Fixe la graine et change seulement la règle : si les groupes restent identiques, regarde d'abord ta mesure.",
  "Calcule ta métrique sur un état tiré au hasard : si elle trouve déjà des groupes, c'est elle qui crée le motif.",
  "Je ne suis pas d'accord avec ton plan : ajoute une règle sans interaction comme témoin négatif.",
  "Montre la distribution des tailles de groupes, pas seulement leur moyenne.",
  "Note ces trois essais dans ton journal avant de modifier quoi que ce soit d'autre.",
] as const;
