/** Liens des messages d'appel : l'écran tourne dans une iframe « sandbox » du bureau (sans allow-popups), donc
 *  Linking.openURL n'y ouvre rien. On demande à la fenêtre parente d'ouvrir le navigateur externe (commande
 *  `open_external_url`, la même que pour les liens des autres messages). Hors iframe : ouverture normale. */
export const CALL_OPEN_URL = 'mind.call.open-url';

export function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\x5c]/.test(value)) return null;
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

type Parent = { postMessage: (message: unknown, target: string) => void };
export function openCallLink(value: string, env: { parent?: Parent; self?: unknown; open: (url: string) => void }): boolean {
  const url = webUrl(value); if (!url) return false;
  if (env.parent && env.parent !== env.self) { env.parent.postMessage({ type: CALL_OPEN_URL, url }, '*'); return true; }
  env.open(url); return true;
}
