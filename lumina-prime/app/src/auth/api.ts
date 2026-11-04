import type { AuthProviderId, LinkContext, MindSession } from './types.ts';
import { describeServerError, parseServerError, parseSessionResponse, parseWhatsAppStart, type WhatsAppChallenge } from './providers.ts';

// Client du serveur d'auth MIND (contrat : SERVER-CONTRACT.md). fetch injecté pour les tests.

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ApiResult<T> = { ok: true; value: T } | { ok: false; message: string; code: string | null };

const TIMEOUT_MS = 15_000;

async function post(fetchImpl: FetchLike, url: string, body: unknown, bearer?: string, method = 'POST'): Promise<{ status: number; ok: boolean; json: unknown } | { failed: string }> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const response = await fetchImpl(url, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal: controller?.signal });
    let json: unknown = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, ok: response.ok, json };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { failed: aborted ? 'Le serveur d’authentification ne répond pas (délai dépassé).' : 'Serveur d’authentification injoignable.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sessionCall(fetchImpl: FetchLike, url: string, body: unknown, provider: AuthProviderId | null, now: () => number, bearer?: string, method = 'POST'): Promise<ApiResult<MindSession>> {
  const res = await post(fetchImpl, url, body, bearer, method);
  if ('failed' in res) return { ok: false, message: res.failed, code: null };
  if (!res.ok) { const code = parseServerError(res.json); return { ok: false, message: describeServerError(code, res.status), code }; }
  const session = parseSessionResponse(res.json, provider, now());
  return session ? { ok: true, value: session } : { ok: false, message: 'Réponse du serveur invalide : aucune session n’a été ouverte.', code: 'invalid_response' };
}

export function createAuthApi(authUrl: string, fetchImpl: FetchLike, now: () => number = Date.now) {
  return {
    exchangeX: (input: { code: string; codeVerifier: string; redirectUri: string }, link?: LinkContext) =>
      sessionCall(fetchImpl, `${authUrl}/auth/x/exchange`, { ...input, ...(link ? { linkChallenge: link.linkChallenge } : {}) }, 'x', now, link?.sessionToken),
    exchangeTelegram: (input: { code: string; codeVerifier: string; redirectUri: string }, link?: LinkContext) =>
      sessionCall(fetchImpl, `${authUrl}/auth/telegram/exchange`, { ...input, ...(link ? { linkChallenge: link.linkChallenge } : {}) }, 'telegram', now, link?.sessionToken),
    validate: (sessionToken: string) => sessionCall(fetchImpl, `${authUrl}/auth/session`, undefined, null, now, sessionToken, 'GET'),
    async startLink(sessionToken: string, provider: AuthProviderId): Promise<ApiResult<{ linkChallenge: string }>> {
      const res = await post(fetchImpl, `${authUrl}/auth/link/start`, { provider }, sessionToken);
      if ('failed' in res) return { ok: false, message: res.failed, code: null };
      if (!res.ok) { const code = parseServerError(res.json); return { ok: false, message: describeServerError(code, res.status), code }; }
      const value = res.json as Record<string, unknown> | null;
      if (!value || typeof value.linkChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.linkChallenge) || value.provider !== provider || typeof value.expiresAt !== 'string' || Date.parse(value.expiresAt) <= now() || !Number.isFinite(Date.parse(value.expiresAt))) return { ok: false, message: 'Demande de liaison invalide.', code: 'invalid_response' };
      return { ok: true, value: { linkChallenge: value.linkChallenge } };
    },
    async whatsappStart(input: { phone: string }): Promise<ApiResult<WhatsAppChallenge>> {
      const res = await post(fetchImpl, `${authUrl}/auth/whatsapp/start`, input);
      if ('failed' in res) return { ok: false, message: res.failed, code: null };
      if (!res.ok) { const code = parseServerError(res.json); return { ok: false, message: describeServerError(code, res.status), code }; }
      const challenge = parseWhatsAppStart(res.json, now());
      return challenge ? { ok: true, value: challenge } : { ok: false, message: 'Réponse du serveur invalide.', code: 'invalid_response' };
    },
    whatsappVerify: (input: { challengeId: string; code?: string }, link?: LinkContext) =>
      sessionCall(fetchImpl, `${authUrl}/auth/whatsapp/verify`, { ...input, ...(link ? { linkChallenge: link.linkChallenge } : {}) }, 'whatsapp', now, link?.sessionToken),
    async logout(sessionToken: string): Promise<void> {
      await post(fetchImpl, `${authUrl}/auth/logout`, {}, sessionToken);
    },
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
