/** Partie pure du relais d'erreurs (sans React) : file, envoi authentifié, renvoi vers le panneau. Voir app-error-report.ts. */
import { call, type ChatSession } from './client.ts';

export type AppErrorItem = { screen: string; text: string; at: string };
type Send = (session: ChatSession, item: AppErrorItem) => Promise<unknown>;
const MAX_PENDING = 100;

export async function sendAppError(session: ChatSession, item: AppErrorItem, fetchImpl = fetch) {
  return call(session.url, '/chat/app-errors', { method: 'POST', headers: {
    Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen: item.screen, text: item.text, at: item.at }) }, fetchImpl);
}

export function createAppErrorRelay(send: Send = sendAppError, now: () => number = Date.now,
  toParent: ((item: AppErrorItem) => void) | null = null, platform = 'app') {
  const pending: AppErrorItem[] = [];
  let session: ChatSession | null = null;
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (session && pending.length) {
        try { await send(session, pending[0]!); pending.shift(); }
        catch (error) {
          // Refus définitif (requête invalide) : abandon de cette entrée ; sinon on réessaie plus tard.
          if ((error as { status?: number })?.status === 400) { pending.shift(); continue; }
          break;
        }
      }
    } finally { flushing = false; }
  }
  return {
    setSession(value: ChatSession | null) { session = value; void flush(); },
    report(screen: string, text: string) {
      const value = String(text ?? '').trim();
      if (!value) return;
      const item = { screen: `${platform} · ${screen}`.slice(0, 120), text: value.slice(0, 4000), at: new Date(now()).toISOString() };
      // Iframe d'appel du panneau Tauri : le panneau relaie (avec l'état de l'iframe), pas de doublon par la passerelle.
      if (toParent) { try { toParent(item); return; } catch { /* Panneau absent : passerelle. */ } }
      pending.push(item);
      if (pending.length > MAX_PENDING) pending.shift();
      void flush();
    },
    flush,
    pending: () => pending.length,
  };
}
