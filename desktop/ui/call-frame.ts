// Iframe d'appel (passerelle 8789) : quand la recharger, quand la dire indisponible.
// Machine chargée, le WebView2 peut mettre plus de 20 s à charger les bundles (17 nov. 2026) :
// la recharger à chaque `phone-poll` relançait alors le chargement sans fin. On attend donc
// la fin du chargement (`load`) avant de réessayer, avec une limite si `load` n'arrive jamais.

export const CALL_RETRY_MS = 20_000;
export const CALL_LOAD_LIMIT_MS = 90_000;

export interface CallFrameState {
  hidden: boolean;
  /** `load` reçu pour le dernier `src`. */
  loaded: boolean;
  openedAt: number;
  now: number;
}

/** Recharger seulement après un chargement fini sans `mind.call.ready`, ou bloqué trop longtemps. */
export function shouldReopenCall(s: CallFrameState): boolean {
  if (!s.hidden) return false;
  const age = s.now - s.openedAt;
  return age >= CALL_LOAD_LIMIT_MS;
}

/** Après 10 s sans `ready` : encore en chargement, ou vraiment indisponible. */
export function callWaitStatus(s: CallFrameState): "loading" | "unavailable" {
  return s.now - s.openedAt < CALL_LOAD_LIMIT_MS ? "loading" : "unavailable";
}
