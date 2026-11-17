/**
 * Couleur des bulles selon l'auteur (NLR, 15 nov. 2026) : pattern holders en jaune, VOX en
 * violet, NLR en bleu, avec un repère emoji dans la ligne d'auteur. Affichage seulement :
 * l'auteur est lu dans les métadonnées et signatures existantes, rien n'est réécrit.
 */
export type AuthorTint = "holder" | "vox" | "owner";

/** Room affectée à VOX (identifiant interne `fork:7`). */
export const VOX_ROOM = 7;

const MARKERS: Readonly<Record<AuthorTint, string>> = { holder: "🟡", vox: "🟣", owner: "🔵" };

/** Préfixe publié par le runtime pour un holder : « <emoji> <Nom> · ». */
const HOLDER_PREFIX = /^\p{Extended_Pictographic}️?\s[^\n·]{1,60} · /u;
/** Signature de VOX dans le fil principal (ancienne et nouvelle forme). */
const VOX_SIGNATURE = /^VOX \((?:Fork|Room) 7\)/;

/** Réponse rapide ⚡ : ni holder ni VOX. */
const FAST_REPLY = /^\s*⚡/u;

export function holderAuthored(text: string): boolean {
  return !FAST_REPLY.test(text) && HOLDER_PREFIX.test(text);
}

/** Auteur d'un message agent d'après son texte ; `room` = Room où il a été écrit. */
export function agentTint(text: string, room?: number): AuthorTint | null {
  if (FAST_REPLY.test(text)) return null;
  if (holderAuthored(text)) return "holder";
  if (VOX_SIGNATURE.test(text) || room === VOX_ROOM) return "vox";
  return null;
}

/** Marque la bulle ; rend le repère emoji à placer en tête de la ligne d'auteur. */
export function authorMarker(li: HTMLElement, tint: AuthorTint | null): HTMLSpanElement | null {
  if (tint === null) return null;
  li.dataset["author"] = tint;
  const marker = document.createElement("span");
  marker.className = "author-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = `${MARKERS[tint]} `;
  return marker;
}
