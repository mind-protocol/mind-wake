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

/** Fenêtre après un nouveau message pendant laquelle toute croissance du fil recolle en bas (image, ASCII, police tardives). */
export const PIN_WINDOW_MS = 6000;
type GrowthNode = { firstElementChild?: unknown; addEventListener?: (type: string, fn: () => void, capture?: boolean) => void; removeEventListener?: (type: string, fn: () => void, capture?: boolean) => void };
/**
 * Web : observe le contenu du fil (ResizeObserver + MutationObserver + « load » des images) et appelle `pin`
 * quand il grandit et que `shouldPin()` est vrai. Rend la fonction de nettoyage.
 */
export function observeTranscriptGrowth(node: GrowthNode | null | undefined, shouldPin: () => boolean, pin: () => void): () => void {
  if (!node) return () => {};
  const react = () => { if (shouldPin()) pin(); };
  const cleanups: Array<() => void> = [];
  const content = node.firstElementChild as Element | null | undefined;
  const RO = (globalThis as { ResizeObserver?: new (cb: () => void) => { observe(n: unknown): void; disconnect(): void } }).ResizeObserver;
  if (RO) { const ro = new RO(react); ro.observe(node); if (content) ro.observe(content); cleanups.push(() => ro.disconnect()); }
  const MO = (globalThis as { MutationObserver?: new (cb: () => void) => { observe(n: unknown, o: object): void; disconnect(): void } }).MutationObserver;
  if (MO) { const mo = new MO(react); mo.observe(content ?? node, { childList: true, subtree: true, characterData: true }); cleanups.push(() => mo.disconnect()); }
  if (node.addEventListener) { node.addEventListener('load', react, true); cleanups.push(() => node.removeEventListener?.('load', react, true)); }
  return () => { for (const fn of cleanups) fn(); };
}
