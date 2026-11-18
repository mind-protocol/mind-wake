/**
 * Salles visibles dans le bandeau au-dessus du fil (NLR, 18 nov. 2026 : « il faudrait montrer
 * que les salles actives dans l'onglet, au-dessus du fil »).
 *
 * Une salle est **active** si l'une de ces conditions tient :
 *  1. c'est la salle ouverte (on ne cache jamais ce qu'on lit) ;
 *  2. elle travaille : On et tour en cours (`lastTurn.endedAt === null`) ;
 *  3. elle **attend NLR** — même immobile, même Off (pattern holder : le filtre ne fait pas
 *     disparaître en silence un choix ouvert) :
 *     - message(s) de l'agent non lus sur cet appareil, ou
 *     - son dernier message d'agent est postérieur au dernier message de NLR et contient une
 *       question (« ? ») ;
 *  4. activité récente : On et une entrée (message, état, activité publique) depuis moins de
 *     `RECENT_MS` (6 h).
 * Les autres restent accessibles par le bouton « + N autres ».
 */
export const RECENT_MS = 6 * 60 * 60 * 1000;

export interface RoomActivityEntry {
  at: string;
  role: "agent" | "human" | "event";
  text: string;
  senderFork?: number;
  notice?: unknown;
  activity?: boolean;
}
export interface RoomActivityFork {
  enabled: boolean;
  lastTurn: { endedAt: string | null } | null;
  entries: readonly RoomActivityEntry[];
  activity?: readonly { at: string }[];
}
export type RoomActivityReason = "ouverte" | "travaille" | "attend ta réponse" | "récente";

/** NLR a la main : non lu, ou question de l'agent restée sans réponse de NLR. */
export function roomAwaitsOwner(fork: RoomActivityFork, unread: number): boolean {
  if (unread > 0) return true;
  let lastOwner = -Infinity;
  let lastAgent: RoomActivityEntry | undefined;
  for (const entry of fork.entries) {
    const at = Date.parse(entry.at);
    if (entry.role === "human" && entry.senderFork === undefined && entry.notice === undefined)
      lastOwner = Math.max(lastOwner, at);
    else if (entry.role === "agent" && !entry.activity && (lastAgent === undefined || at >= Date.parse(lastAgent.at)))
      lastAgent = entry;
  }
  return lastAgent !== undefined && Date.parse(lastAgent.at) > lastOwner && /\?/.test(lastAgent.text);
}

export function roomActivity(
  fork: RoomActivityFork,
  state: { selected: boolean; working: boolean; unread: number; now?: number },
): RoomActivityReason | null {
  if (state.selected) return "ouverte";
  if (state.working || (fork.enabled && fork.lastTurn !== null && fork.lastTurn.endedAt === null)) return "travaille";
  if (roomAwaitsOwner(fork, state.unread)) return "attend ta réponse";
  if (fork.enabled) {
    const now = state.now ?? Date.now();
    const last = Math.max(-Infinity, ...fork.entries.map((e) => Date.parse(e.at)), ...(fork.activity ?? []).map((a) => Date.parse(a.at)));
    if (now - last < RECENT_MS) return "récente";
  }
  return null;
}
