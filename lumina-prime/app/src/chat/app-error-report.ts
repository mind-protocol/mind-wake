/**
 * Relais des erreurs affichées dans l'app vers l'agent principal (demande NLR, 17 nov 2026).
 * POST /chat/app-errors sur la session existante → message pair `app-error` au principal.
 * V1 : chaque erreur part, sans déduplication ni limite. Hors ligne, les erreurs attendent
 * en mémoire (100 au plus, pour ne pas épuiser la mémoire) et partent à la reconnexion.
 * Dans l'iframe d'appel du panneau Tauri (?receiver=desktop), elles passent au panneau
 * (postMessage) à la place, qui les relaie aussitôt avec l'état de l'iframe, même sans session.
 * Le texte affiché seulement : jamais le jeton, la conversation ni l'audio. Le runtime masque les secrets.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { createAppErrorRelay, sendAppError, type AppErrorItem } from './app-error-relay.ts';

const DESKTOP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

function parentForwarder(): ((item: AppErrorItem) => void) | null {
  if (typeof window === 'undefined' || window.parent === window || window.location?.pathname !== '/desktop-call'
    || new URLSearchParams(window.location.search).get('receiver') !== 'desktop') return null;
  return item => {
    for (const origin of DESKTOP_ORIGINS) window.parent.postMessage({ type: 'mind.app-error', ...item }, origin);
  };
}

export const appErrors = createAppErrorRelay(sendAppError, Date.now, parentForwarder(), Platform.OS);
export const reportAppError = (screen: string, text: string) => appErrors.report(screen, text);

/** Chaque fois qu'un texte d'erreur apparaît ou change à l'écran, il part. */
export function useReportedError(screen: string, error: string | null | undefined) {
  useEffect(() => { if (error) reportAppError(screen, error); }, [screen, error]);
}

let installed = false;
const describe = (value: unknown) => value instanceof Error ? (value.stack ?? value.message)
  : typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();

/** Erreurs JS globales, promesses rejetées et console.error. Une seule installation. */
export function installGlobalAppErrorHandlers() {
  if (installed) return;
  installed = true;
  let inside = false;
  const guard = (screen: string, text: string) => {
    if (inside) return;
    inside = true;
    try { reportAppError(screen, text); } finally { inside = false; }
  };
  const errorUtils = (globalThis as { ErrorUtils?: { getGlobalHandler: () => (e: unknown, fatal?: boolean) => void;
    setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void } }).ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, fatal) => { guard(fatal ? 'erreur fatale' : 'erreur JS', describe(error)); previous(error, fatal); });
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', event => guard('erreur JS', `${event.message}${event.filename ? ` (${event.filename}:${event.lineno})` : ''}`));
    window.addEventListener('unhandledrejection', event => guard('promesse rejetée', describe(event.reason)));
  }
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => { original(...args); guard('console', args.map(describe).join(' ')); };
}
