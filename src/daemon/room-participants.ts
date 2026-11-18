/**
 * Participants d'une room, pour l'appli (NLR, 18 nov. 2026 14:19 : « les holders, il faut que ce
 * soit assigné à des salles comme des agents normaux »). Agents de room (sessions, explicites ou
 * détectés) et pattern holders de la room (champ historique `holder` et entrées
 * `{ "id": slug, "kind": "holder" }` de `agents`), dans l'ordre de l'affectation.
 */
import { loadPatternHolders, type PatternHolder } from "../communication/pattern-holders.js";
import { resolveRoomAgents, roomHolderSlugs, type ForkAssignment } from "./fork-assignment.js";

export interface RoomParticipant {
  readonly id: string;
  readonly name: string;
  readonly kind: "agent" | "holder";
  /** Emoji du holder (holders seulement). */
  readonly emoji?: string;
  /** Holder posé dans l'affectation mais introuvable (dossier absent ou invalide). */
  readonly missing?: true;
}

/** Holders du workspace, lus au plus une fois par appelant. */
export function holdersOnce(dataDir: string): () => readonly PatternHolder[] {
  let holders: readonly PatternHolder[] | undefined;
  return () => {
    if (holders === undefined) {
      try {
        holders = loadPatternHolders(dataDir).holders;
      } catch {
        holders = [];
      }
    }
    return holders;
  };
}

export function roomParticipants(
  dataDir: string,
  assignment: ForkAssignment | null,
  holders: () => readonly PatternHolder[] = holdersOnce(dataDir),
): RoomParticipant[] {
  if (assignment === null) return [];
  let agents: RoomParticipant[] = [];
  try {
    agents = resolveRoomAgents(assignment, dataDir).map((a) => ({ id: a.id, name: a.name, kind: "agent" as const }));
  } catch {
    agents = [];
  }
  const slugs = roomHolderSlugs(assignment);
  const known = slugs.length === 0 ? [] : holders();
  const roomHolders = slugs.map((slug): RoomParticipant => {
    const h = known.find((k) => k.slug === slug);
    return h === undefined
      ? { id: slug, name: slug, kind: "holder", missing: true }
      : { id: slug, name: h.name, kind: "holder", emoji: h.emoji };
  });
  return [...agents, ...roomHolders];
}
