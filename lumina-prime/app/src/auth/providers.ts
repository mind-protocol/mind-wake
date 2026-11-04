import type { AuthProviderId, LinkedIdentity, MindSession } from './types.ts';
import { AUTH_PROVIDERS } from './types.ts';

// Sources : docs.x.com (OAuth 2.0 Authorization Code with PKCE) et
// core.telegram.org/bots/telegram-login (OpenID Connect). Voir SERVER-CONTRACT.md.
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_SCOPES = ['users.read', 'tweet.read'] as const;
export const TELEGRAM_AUTHORIZE_URL = 'https://oauth.telegram.org/auth';
export const TELEGRAM_SCOPES = ['openid', 'profile'] as const;

export const PROVIDER_LABELS: Record<AuthProviderId, string> = { x: 'X', telegram: 'Telegram', whatsapp: 'WhatsApp' };

function query(params: Record<string, string>): string {
  return Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

export function buildXAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  return `${X_AUTHORIZE_URL}?${query({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: X_SCOPES.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  })}`;
}

/** Telegram n'accepte que des URL de retour pré-enregistrées chez @BotFather : on passe par le relais https du serveur. */
export function telegramRelayRedirectUri(authUrl: string): string {
  return `${authUrl}/auth/telegram/callback`;
}

export function buildTelegramAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  return `${TELEGRAM_AUTHORIZE_URL}?${query({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: TELEGRAM_SCOPES.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  })}`;
}

/** Lien wa.me (mode « l'utilisateur envoie le code ») : https://wa.me/<numéro sans +>?text=… */
export function buildWaMeLink(businessNumber: string, userCode: string): string {
  return `https://wa.me/${businessNumber.replace(/^\+/, '')}?text=${encodeURIComponent(`MIND ${userCode}`)}`;
}

export function maskPhone(e164: string): string {
  return e164.length > 6 ? `${e164.slice(0, 3)} ••• ${e164.slice(-3)}` : '•••';
}

// ---- Validation stricte des réponses du serveur : rien n'est « connecté » sans session valide. ----

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseIdentity(value: unknown): LinkedIdentity | null {
  if (!isObject(value)) return null;
  const { provider, providerUserId, handle, displayName, verifiedAt } = value;
  if (typeof provider !== 'string' || !(AUTH_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (typeof providerUserId !== 'string' || !providerUserId) return null;
  if (typeof handle !== 'string' || !handle) return null;
  if (displayName !== null && typeof displayName !== 'string') return null;
  if (!isIsoDate(verifiedAt)) return null;
  return { provider: provider as AuthProviderId, providerUserId, handle, displayName, verifiedAt };
}

export function parseSessionResponse(value: unknown, expectedProvider: AuthProviderId | null, now: number): MindSession | null {
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  const { sessionToken, expiresAt } = value;
  if (typeof sessionToken !== 'string' || sessionToken.length < 20) return null;
  if (!isIsoDate(expiresAt) || Date.parse(expiresAt) <= now) return null;
  const identity = parseIdentity(value.identity);
  if (!identity) return null;
  if (expectedProvider && identity.provider !== expectedProvider) return null;
  let unified: Pick<MindSession, 'mindUserId' | 'identities'> = {};
  if (value.mindUserId !== undefined || value.identities !== undefined) {
    if (typeof value.mindUserId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.mindUserId) || !Array.isArray(value.identities) || !value.identities.length || value.identities.length > 20) return null;
    const identities = value.identities.map(parseIdentity);
    if (identities.some(item => item === null)) return null;
    const valid = identities as LinkedIdentity[];
    if (new Set(valid.map(item => `${item.provider}:${item.providerUserId}`)).size !== valid.length) return null;
    if (!valid.some(item => item.provider === identity.provider && item.providerUserId === identity.providerUserId)) return null;
    unified = { mindUserId: value.mindUserId, identities: valid };
  }
  return { schemaVersion: 1, sessionToken, expiresAt, identity, ...unified };
}

export type WhatsAppChallenge =
  | { delivery: 'otp'; challengeId: string; expiresAt: string }
  | { delivery: 'wa_link'; challengeId: string; expiresAt: string; userCode: string };

export function parseWhatsAppStart(value: unknown, now: number): WhatsAppChallenge | null {
  if (!isObject(value)) return null;
  const { delivery, challengeId, expiresAt, userCode } = value;
  if (typeof challengeId !== 'string' || !challengeId || !isIsoDate(expiresAt) || Date.parse(expiresAt) <= now) return null;
  if (delivery === 'otp') return { delivery, challengeId, expiresAt };
  if (delivery === 'wa_link' && typeof userCode === 'string' && /^[A-Z0-9]{4,15}$/.test(userCode)) return { delivery, challengeId, expiresAt, userCode };
  return null;
}

export function parseServerError(value: unknown): string | null {
  if (!isObject(value) || typeof value.error !== 'string') return null;
  return value.error;
}

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: 'Ce fournisseur n’est pas encore configuré côté serveur.',
  invalid_request: 'Requête refusée par le serveur.',
  invalid_grant: 'Le code d’autorisation a expiré ou a déjà servi. Recommence.',
  provider_unavailable: 'Le fournisseur ne répond pas. Réessaie plus tard.',
  invalid_code: 'Code incorrect.',
  expired: 'Le code a expiré. Demande-en un nouveau.',
  too_many_attempts: 'Trop d’essais. Demande un nouveau code.',
  pending: 'Message WhatsApp pas encore reçu. Envoie-le puis réessaie.',
  rate_limited: 'Trop de demandes. Patiente un peu.',
  unauthorized: 'Ta session n’est plus valide. Reconnecte-toi.',
  expired_link: 'La demande de liaison a expiré ou a déjà servi. Recommence.',
  invalid_link: 'Cette demande ne correspond pas à ta session ou au compte choisi.',
  identity_already_linked: 'Ce compte appartient déjà à une autre identité MIND. Il n’a pas été déplacé.',
  identity_limit: 'Cette identité MIND a atteint sa limite de comptes reliés.',
};

export function describeServerError(code: string | null, status: number): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return `Le serveur d’authentification a répondu ${status}.`;
}

/** Numéro saisi par l'utilisateur → E.164, ou null. */
export function parseUserPhone(input: string): string | null {
  const raw = input.replace(/[\s().-]/g, '');
  const withPlus = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

export function isOtpShape(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}
