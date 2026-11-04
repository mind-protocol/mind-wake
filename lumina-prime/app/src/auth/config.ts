import type { AuthProviderId, ProviderConfig, PublicAuthEnv } from './types.ts';

/**
 * Lecture des variables publiques. Expo n'injecte EXPO_PUBLIC_* qu'en accès
 * statique `process.env.EXPO_PUBLIC_…` : ne pas remplacer par un accès dynamique.
 */
export function readPublicAuthEnv(): PublicAuthEnv {
  return {
    authUrl: process.env.EXPO_PUBLIC_MIND_AUTH_URL,
    xClientId: process.env.EXPO_PUBLIC_X_CLIENT_ID,
    telegramClientId: process.env.EXPO_PUBLIC_TELEGRAM_CLIENT_ID,
    whatsappBusinessNumber: process.env.EXPO_PUBLIC_WHATSAPP_BUSINESS_NUMBER,
  };
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** URL du serveur d'auth : https obligatoire, sauf http://localhost / 127.0.0.1 / 10.0.2.2 en développement. */
export function normalizeAuthUrl(value: string | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const match = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(raw);
  if (!match) return null;
  const [, scheme, host] = match;
  const local = /^(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(host);
  if (scheme.toLowerCase() !== 'https' && !local) return null;
  return raw.replace(/\/+$/, '');
}

/** Numéro WhatsApp Business au format E.164 (+ et 8 à 15 chiffres). */
export function normalizeE164(value: string | undefined): string | null {
  const raw = clean(value)?.replace(/[\s().-]/g, '');
  if (!raw) return null;
  const withPlus = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

export function resolveProviderConfig(provider: AuthProviderId, env: PublicAuthEnv): ProviderConfig {
  const authUrl = normalizeAuthUrl(env.authUrl);
  const missing: string[] = [];
  if (!authUrl) missing.push('EXPO_PUBLIC_MIND_AUTH_URL');
  if (provider === 'x') {
    const clientId = clean(env.xClientId);
    if (!clientId) missing.push('EXPO_PUBLIC_X_CLIENT_ID');
    return authUrl && clientId ? { provider, configured: true, authUrl, clientId } : { provider, configured: false, missing };
  }
  if (provider === 'telegram') {
    const clientId = clean(env.telegramClientId);
    const valid = clientId !== null && /^\d+$/.test(clientId);
    if (!valid) missing.push('EXPO_PUBLIC_TELEGRAM_CLIENT_ID');
    return authUrl && valid ? { provider, configured: true, authUrl, clientId: clientId! } : { provider, configured: false, missing };
  }
  const businessNumber = normalizeE164(env.whatsappBusinessNumber);
  if (!businessNumber) missing.push('EXPO_PUBLIC_WHATSAPP_BUSINESS_NUMBER');
  return authUrl && businessNumber ? { provider, configured: true, authUrl, businessNumber } : { provider, configured: false, missing };
}
