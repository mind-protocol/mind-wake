/** Durée pendant laquelle un défilement animé lancé par l'écran n'est pas pris pour un geste. */
export const SMOOTH_SCROLL_MS = 700;
/**
 * Choix du défilement vers le bas (NLR, 17 nov.) : animé pour un nouveau message, instantané pour
 * un recalage (image ou ASCII chargée après coup). Consomme la demande d'animation.
 */
export function pinScrollToEnd(smoothNext: { current: boolean }, animatingUntil: { current: number }, now: number): boolean {
  const animated = smoothNext.current; smoothNext.current = false;
  if (animated) animatingUntil.current = now + SMOOTH_SCROLL_MS;
  return animated;
}
