import { useSyncExternalStore } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import type { AuthProviderId, AuthState, LinkContext, PendingOAuth } from './types.ts';
import { normalizeAuthUrl, readPublicAuthEnv, resolveProviderConfig } from './config.ts';
import { codeChallengeS256, codeVerifierFromBytes, randomState } from './pkce.ts';
import { interpretCallback, parseUrlParams } from './callback.ts';
import { buildTelegramAuthorizeUrl, buildWaMeLink, buildXAuthorizeUrl, maskPhone, parseUserPhone, telegramRelayRedirectUri, isOtpShape } from './providers.ts';
import { authReducer, initialAuthState, type AuthEvent } from './session.ts';
import { createAuthApi, type FetchLike } from './api.ts';
import { clearSession, loadSession, saveSession } from './storage.ts';

// État d'auth partagé sans Provider (useSyncExternalStore) : l'écran login et
// l'onglet compte lisent la même source, sans modifier l'AppState existant.

let state: AuthState = initialAuthState;
let pending: PendingOAuth | null = null;
let whatsappLink: LinkContext | undefined;
let generation = 0;
let restoreStarted = false;
const listeners = new Set<() => void>();

function dispatch(event: AuthEvent) {
  const next = authReducer(state, event);
  if (next === state) return;
  state = next;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!restoreStarted) {
    restoreStarted = true;
    restoreSession()
      .catch(() => dispatch({ type: 'restored', session: null, now: Date.now() }));
  }
  return () => { listeners.delete(listener); };
}

async function restoreSession() {
  const session = await loadSession(Date.now());
  if (!session) { dispatch({ type: 'restored', session: null, now: Date.now() }); return; }
  const authUrl = normalizeAuthUrl(readPublicAuthEnv().authUrl);
  if (!authUrl) { dispatch({ type: 'restored', session: null, now: Date.now() }); return; }
  const result = await api(authUrl).validate(session.sessionToken);
  if (state.session.status === 'signed_in') return;
  if (result.ok) {
    await saveSession(result.value);
    dispatch({ type: 'restored', session: result.value, now: Date.now() });
  } else {
    if (result.code === 'unauthorized') await clearSession();
    dispatch({ type: 'restored', session: null, now: Date.now() });
    dispatch({ type: 'failed', provider: session.identity.provider, message: result.message });
  }
}

const getSnapshot = () => state;

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function providerConfig(provider: AuthProviderId) {
  return resolveProviderConfig(provider, readPublicAuthEnv());
}

function api(authUrl: string) {
  return createAuthApi(authUrl, fetch as unknown as FetchLike);
}

async function sha256Base64(input: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, { encoding: Crypto.CryptoEncoding.BASE64 });
}

/** Adresse de retour dans l'app : mindlumina://login (build natif), l'origine web, ou exp:// sous Expo Go. */
export function appRedirectUri(): string {
  return Linking.createURL('login');
}

export async function signInWithOAuth(provider: 'x' | 'telegram', options: { link?: boolean } = {}): Promise<void> {
  const startedGeneration = generation;
  const config = providerConfig(provider);
  if (!config.configured) { dispatch({ type: 'failed', provider, message: `Non configuré : ${config.missing.join(', ')}.` }); return; }
  dispatch({ type: 'flow', flow: { phase: 'opening', provider } });
  try {
    let link: LinkContext | undefined;
    if (options.link) {
      if (state.session.status !== 'signed_in') throw Error('Reconnecte-toi avant de relier un compte.');
      const sessionToken = state.session.session.sessionToken;
      const started = await api(config.authUrl).startLink(sessionToken, provider);
      if (!started.ok) throw Error(started.message);
      link = { sessionToken, linkChallenge: started.value.linkChallenge };
    }
    const codeVerifier = codeVerifierFromBytes(await Crypto.getRandomBytesAsync(32));
    const oauthState = randomState(await Crypto.getRandomBytesAsync(16));
    const codeChallenge = await codeChallengeS256(codeVerifier, sha256Base64);
    if (generation !== startedGeneration) return;
    const appRedirect = appRedirectUri();
    const clientId = config.provider === 'x' || config.provider === 'telegram' ? config.clientId : '';
    const redirectUri = provider === 'x' ? appRedirect : telegramRelayRedirectUri(config.authUrl);
    const input = { clientId, redirectUri, state: oauthState, codeChallenge };
    const url = provider === 'x' ? buildXAuthorizeUrl(input) : buildTelegramAuthorizeUrl(input);
    pending = { provider, state: oauthState, codeVerifier, redirectUri, createdAt: Date.now(), link, generation: startedGeneration };
    const result = await WebBrowser.openAuthSessionAsync(url, appRedirect);
    if (result.type === 'success') { await completeOAuthFromUrl(result.url); return; }
    // Sur Android le retour peut arriver par lien profond (écran login) : on garde `pending`.
    if (state.flow.phase === 'opening') dispatch({ type: 'failed', provider, message: 'Connexion annulée ou fenêtre fermée.' });
  } catch (error) {
    dispatch({ type: 'failed', provider, message: error instanceof Error ? `Impossible d’ouvrir la connexion : ${error.message}` : 'Impossible d’ouvrir la connexion.' });
  }
}

export function hasPendingOAuth(): boolean {
  return pending !== null;
}

export async function completeOAuthFromUrl(url: string): Promise<void> {
  await completeOAuthFromParams(parseUrlParams(url));
}

/** Termine un retour OAuth (résultat du navigateur ou lien profond vers /login). Usage unique du `pending`. */
export async function completeOAuthFromParams(params: Record<string, string>): Promise<void> {
  const current = pending;
  if (!current) return; // ex. fenêtre popup web, ou lien déjà traité
  pending = null;
  const verdict = interpretCallback(params, current, Date.now());
  if (!verdict.ok) { dispatch({ type: 'failed', provider: current.provider, message: verdict.message }); return; }
  const config = providerConfig(current.provider);
  if (!config.configured) { dispatch({ type: 'failed', provider: current.provider, message: 'Configuration disparue pendant la connexion.' }); return; }
  dispatch({ type: 'flow', flow: { phase: 'exchanging', provider: current.provider } });
  const client = api(config.authUrl);
  const body = { code: verdict.code, codeVerifier: current.codeVerifier, redirectUri: current.redirectUri };
  const result = current.provider === 'x' ? await client.exchangeX(body, current.link) : await client.exchangeTelegram(body, current.link);
  if (current.generation !== generation) return;
  if (!result.ok) { dispatch({ type: 'failed', provider: current.provider, message: result.message }); return; }
  await persistAndSignIn(result.value);
}

async function persistAndSignIn(session: Parameters<typeof saveSession>[0]) {
  try { await saveSession(session); } catch { /* la session reste valable pour cette exécution */ }
  dispatch({ type: 'signed_in', session, now: Date.now() });
}

export async function startWhatsApp(phoneInput: string, options: { link?: boolean } = {}): Promise<void> {
  const startedGeneration = generation;
  const config = providerConfig('whatsapp');
  if (!config.configured) { dispatch({ type: 'failed', provider: 'whatsapp', message: `Non configuré : ${config.missing.join(', ')}.` }); return; }
  if (config.provider !== 'whatsapp') return;
  const phone = parseUserPhone(phoneInput);
  if (!phone) { dispatch({ type: 'failed', provider: 'whatsapp', message: 'Numéro invalide. Format international attendu, ex. +33612345678.' }); return; }
  dispatch({ type: 'flow', flow: { phase: 'verifying', provider: 'whatsapp' } });
  whatsappLink = undefined;
  if (options.link) {
    if (state.session.status !== 'signed_in') { dispatch({ type: 'failed', provider: 'whatsapp', message: 'Reconnecte-toi avant de relier WhatsApp.' }); return; }
    const sessionToken = state.session.session.sessionToken;
    const started = await api(config.authUrl).startLink(sessionToken, 'whatsapp');
    if (generation !== startedGeneration) return;
    if (!started.ok) { dispatch({ type: 'failed', provider: 'whatsapp', message: started.message }); return; }
    whatsappLink = { sessionToken, linkChallenge: started.value.linkChallenge };
  }
  const result = await api(config.authUrl).whatsappStart({ phone });
  if (generation !== startedGeneration) return;
  if (!result.ok) { dispatch({ type: 'failed', provider: 'whatsapp', message: result.message }); return; }
  const challenge = result.value;
  if (challenge.delivery === 'otp') {
    dispatch({ type: 'flow', flow: { phase: 'awaiting_code', provider: 'whatsapp', challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, maskedPhone: maskPhone(phone) } });
  } else {
    dispatch({ type: 'flow', flow: { phase: 'awaiting_wa_message', provider: 'whatsapp', challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, userCode: challenge.userCode, waLink: buildWaMeLink(config.businessNumber, challenge.userCode) } });
  }
}

export async function verifyWhatsApp(code?: string): Promise<void> {
  const startedGeneration = generation;
  const flow = state.flow;
  const config = providerConfig('whatsapp');
  if (!config.configured || (flow.phase !== 'awaiting_code' && flow.phase !== 'awaiting_wa_message')) return;
  if (flow.phase === 'awaiting_code' && (!code || !isOtpShape(code))) { dispatch({ type: 'failed', provider: 'whatsapp', message: 'Le code WhatsApp contient 6 chiffres.' }); return; }
  const previous = flow;
  dispatch({ type: 'flow', flow: { phase: 'verifying', provider: 'whatsapp' } });
  const result = await api(config.authUrl).whatsappVerify(previous.phase === 'awaiting_code' ? { challengeId: previous.challengeId, code: code!.trim() } : { challengeId: previous.challengeId }, whatsappLink);
  if (generation !== startedGeneration) return;
  if (result.ok) { whatsappLink = undefined; await persistAndSignIn(result.value); return; }
  // code faux / message pas encore reçu : on reste sur la saisie, avec le message
  if (result.code === 'invalid_code' || result.code === 'pending') dispatch({ type: 'flow', flow: { ...previous, notice: result.message } });
  else dispatch({ type: 'failed', provider: 'whatsapp', message: result.message });
}

export async function signOut(): Promise<void> {
  generation += 1;
  pending = null;
  whatsappLink = undefined;
  const current = state.session;
  if (current.status === 'signed_in') {
    const authUrl = normalizeAuthUrl(readPublicAuthEnv().authUrl);
    if (authUrl) { try { await api(authUrl).logout(current.session.sessionToken); } catch { /* révocation best effort */ } }
  }
  await clearSession();
  pending = null;
  whatsappLink = undefined;
  dispatch({ type: 'signed_out' });
}

export function resetFlow(): void {
  generation += 1;
  pending = null;
  whatsappLink = undefined;
  dispatch({ type: 'reset_flow' });
}
