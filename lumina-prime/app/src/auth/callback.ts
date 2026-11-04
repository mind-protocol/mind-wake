import type { PendingOAuth } from './types.ts';

/** Analyse de query/fragment sans dépendre de URL/URLSearchParams (partiels sur certaines cibles RN). */
export function parseUrlParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const queryStart = url.indexOf('?');
  const hashStart = url.indexOf('#');
  const parts: string[] = [];
  if (queryStart >= 0) parts.push(url.slice(queryStart + 1, hashStart > queryStart ? hashStart : undefined));
  if (hashStart >= 0) parts.push(url.slice(hashStart + 1));
  for (const part of parts) {
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
      const rawValue = eq >= 0 ? pair.slice(eq + 1) : '';
      try {
        const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        // la query l'emporte sur le fragment en cas de doublon
        if (!(key in out)) out[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      } catch { /* paire mal encodée ignorée */ }
    }
  }
  return out;
}

export type CallbackResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'cancelled' | 'provider_error' | 'state_mismatch' | 'missing_code' | 'expired' | 'no_pending'; message: string };

/** Durée max entre l'ouverture du navigateur et le retour (X n'accepte le code que 30 s après l'accord). */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export function interpretCallback(params: Record<string, string>, pending: PendingOAuth | null, now: number): CallbackResult {
  if (!pending) return { ok: false, reason: 'no_pending', message: 'Aucune connexion en cours. Recommence depuis l’écran de connexion.' };
  if (now - pending.createdAt > PENDING_TTL_MS) return { ok: false, reason: 'expired', message: 'La demande de connexion a expiré. Recommence.' };
  if (params.error) {
    const cancelled = params.error === 'access_denied';
    return { ok: false, reason: cancelled ? 'cancelled' : 'provider_error', message: cancelled ? 'Connexion refusée ou annulée.' : `Le fournisseur a renvoyé une erreur (${params.error.slice(0, 60)}).` };
  }
  // comparaison exacte : le state protège contre l'injection d'un code étranger (CSRF)
  if (!params.state || params.state !== pending.state) return { ok: false, reason: 'state_mismatch', message: 'Retour de connexion non reconnu (state différent). Recommence.' };
  if (!params.code) return { ok: false, reason: 'missing_code', message: 'Le fournisseur n’a pas renvoyé de code d’autorisation.' };
  return { ok: true, code: params.code };
}
