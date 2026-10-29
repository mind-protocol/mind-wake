/**
 * Matching FACTICE (SPEC §17.2) : sélection simple et déterministe parmi des agents
 * guest simulés. La demande du guide est minimale (langue, sujets acceptés) ; aucun
 * historique personnel n'est transmis. Un candidat doit avoir une question réellement
 * prête, une langue compatible, un budget fictif réservable et aucune autre séance active.
 */

import { multiplyAmount, parseAmount, type PoolId } from "../session/index.js";
import type { GuestPersona } from "./agent-host.js";

export interface GuestListing {
  readonly agentId: string;
  readonly topic: string;
  readonly language: string;
  /** L'agent a préparé une question à partir d'un besoin réel (pas fabriquée pour l'occasion). */
  readonly needReady: boolean;
  readonly poolId: PoolId;
  /** Fonds fictifs déposés par le propriétaire de l'agent dans sa réserve simulée. */
  readonly fictiveFunding: string;
  readonly unitPrice: string;
  readonly maxExchanges: number;
  readonly persona: GuestPersona;
  /** Simule un réveil impossible côté agent (H02). */
  readonly wakeFails?: boolean;
}

export interface MatchRequest {
  readonly language: string;
  /** Sujets acceptés ; vide ou absent : tout sujet. */
  readonly topics?: readonly string[];
}

export type MatchResult =
  | {
      readonly status: "matched";
      readonly listing: GuestListing;
      readonly rejected: readonly Rejection[];
    }
  | { readonly status: "no_candidate"; readonly rejected: readonly Rejection[] };

export interface Rejection {
  readonly agentId: string;
  readonly reason: string;
}

export interface MatchProbe {
  available(poolId: PoolId): bigint;
  busy(agentId: string): boolean;
}

export function matchGuest(
  catalog: readonly GuestListing[],
  request: MatchRequest,
  probe: MatchProbe,
): MatchResult {
  const rejected: Rejection[] = [];
  const ordered = [...catalog].sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const listing of ordered) {
    const reason = rejection(listing, request, probe);
    if (reason === null) return { status: "matched", listing, rejected };
    rejected.push({ agentId: listing.agentId, reason });
  }
  return { status: "no_candidate", rejected };
}

function rejection(listing: GuestListing, request: MatchRequest, probe: MatchProbe): string | null {
  if (!listing.needReady) return "aucune question prête";
  if (listing.language !== request.language) return "langue incompatible";
  const topics = request.topics ?? [];
  if (topics.length > 0 && !topics.includes(listing.topic)) return "sujet non accepté";
  if (probe.busy(listing.agentId)) return "déjà en séance";
  const block = multiplyAmount(parseAmount(listing.unitPrice), listing.maxExchanges, "bloc");
  if (probe.available(listing.poolId) < block) return "budget fictif insuffisant pour le bloc";
  return null;
}
