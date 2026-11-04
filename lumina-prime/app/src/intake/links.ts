/**
 * Liens de préparation de soutien :
 *   mindlumina://compose/<username>?amount=10&note=...
 *   https://<hôte>/compose/<username>?amount=10   (web)
 * Un lien reçu est une DÉTECTION D'INTENTION : il pré-remplit le compositeur,
 * jamais il n'autorise un paiement. Tout paramètre invalide est ignoré et signalé.
 * Module pur : aucune dépendance native.
 */
import { parseAmount } from '../data/logic.ts';

export const USERNAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const NOTE_MAX = 140;
export const AMOUNT_MAX_LENGTH = 32;
export const ACCEPTED_SCHEMES = ['mindlumina:', 'exp:', 'exps:', 'http:', 'https:'] as const;

export type Via = 'lien' | 'capture' | 'collage';
export type LinkIssue = Readonly<{ param: string; reason: string }>;
export type ComposePrefill = Readonly<{
  username: string | null;
  amount: string | null;
  note: string | null;
  via: Via | null;
  issues: readonly LinkIssue[];
}>;

type Params = Record<string, string | string[] | undefined>;

const KNOWN = new Set(['username', 'amount', 'note', 'via']);
const COMMAND_LIKE = /◈|\$\s*MIND|\+\s*[0-9]|\bMIND\b/i;
// C0/C1 controls, bidi overrides and zero-width characters.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

function single(value: string | string[] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? null : value;
}

export function validateAmount(value: string): { amount: string } | { reason: string } {
  if (value.length > AMOUNT_MAX_LENGTH || !/^[0-9]+(?:[.,][0-9]{1,9})?$/.test(value)) {
    return { reason: 'montant invalide (nombre positif, 9 décimales au plus)' };
  }
  try { return { amount: parseAmount(value).decimal }; }
  catch { return { reason: 'montant nul ou hors limites' }; }
}

export function validateNote(value: string): { note: string } | { reason: string } {
  if (UNSAFE_CHARS.test(value.replace(/[\n\r\t]/g, ' '))) return { reason: 'caractères de contrôle interdits' };
  const note = value.replace(/\s+/g, ' ').trim();
  if (!note) return { reason: 'note vide' };
  if (note.length > NOTE_MAX) return { reason: `note trop longue (${NOTE_MAX} caractères au plus)` };
  if (COMMAND_LIKE.test(note)) return { reason: 'une note ne peut pas contenir de commande de paiement' };
  return { note };
}

/** Validate route/query params (useLocalSearchParams). Never throws. */
export function readComposeParams(params: Params): ComposePrefill {
  const issues: LinkIssue[] = [];
  let username: string | null = null;
  let amount: string | null = null;
  let note: string | null = null;
  let via: Via | null = null;

  const rawUser = single(params.username);
  if (rawUser === null) issues.push({ param: 'username', reason: 'valeur répétée' });
  else if (rawUser !== undefined) {
    if (USERNAME.test(rawUser)) username = rawUser;
    else issues.push({ param: 'username', reason: 'nom de destinataire invalide' });
  }

  const rawAmount = single(params.amount);
  if (rawAmount === null) issues.push({ param: 'amount', reason: 'valeur répétée' });
  else if (rawAmount !== undefined) {
    const checked = validateAmount(rawAmount);
    if ('amount' in checked) amount = checked.amount;
    else issues.push({ param: 'amount', reason: checked.reason });
  }

  const rawNote = single(params.note);
  if (rawNote === null) issues.push({ param: 'note', reason: 'valeur répétée' });
  else if (rawNote !== undefined) {
    const checked = validateNote(rawNote);
    if ('note' in checked) note = checked.note;
    else issues.push({ param: 'note', reason: checked.reason });
  }

  const rawVia = single(params.via);
  if (rawVia === null) issues.push({ param: 'via', reason: 'valeur répétée' });
  else if (rawVia !== undefined) {
    if (rawVia === 'lien' || rawVia === 'capture' || rawVia === 'collage') via = rawVia;
    else issues.push({ param: 'via', reason: 'provenance inconnue' });
  }
  if (!via && (amount !== null || note !== null)) via = 'lien';

  for (const key of Object.keys(params)) {
    if (KNOWN.has(key) || key.startsWith('__') || key.startsWith('#')) continue;
    issues.push({ param: key.slice(0, 40), reason: 'paramètre inconnu' });
  }
  return Object.freeze({ username, amount, note, via, issues: Object.freeze(issues.map(issue => Object.freeze(issue))) });
}

export type ParsedLink =
  | (ComposePrefill & { ok: true })
  | Readonly<{ ok: false; reason: string }>;

/** Path of a URL as seen by the router, for custom schemes, Expo Go and web. */
function routePath(url: URL): string {
  if (url.protocol === 'exp:' || url.protocol === 'exps:') {
    const marker = url.pathname.indexOf('/--/');
    return marker === -1 ? '' : url.pathname.slice(marker + 3);
  }
  if (url.protocol === 'mindlumina:') return `/${url.host}${url.pathname}`.replace(/^\/+/, '/');
  return url.pathname;
}

/** Parse a full incoming link. Only the compose route is accepted. */
export function parseComposeUrl(input: string): ParsedLink {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { return Object.freeze({ ok: false, reason: 'lien illisible' }); }
  if (!(ACCEPTED_SCHEMES as readonly string[]).includes(url.protocol)) {
    return Object.freeze({ ok: false, reason: 'schéma non accepté' });
  }
  if (url.username || url.password) return Object.freeze({ ok: false, reason: 'identifiants interdits dans le lien' });
  const match = /^\/compose\/([^/]+)\/?$/.exec(routePath(url));
  if (!match) return Object.freeze({ ok: false, reason: 'ce lien n’ouvre pas le compositeur' });
  let username: string;
  try { username = decodeURIComponent(match[1]); }
  catch { return Object.freeze({ ok: false, reason: 'nom de destinataire illisible' }); }
  if (!USERNAME.test(username)) return Object.freeze({ ok: false, reason: 'nom de destinataire invalide' });

  const params: Params = { username };
  const extra: LinkIssue[] = [];
  for (const [key, value] of url.searchParams) {
    if (key === 'username') {
      extra.push(Object.freeze({ param: 'username', reason: 'le destinataire vient du chemin, pas de la requête' }));
      continue;
    }
    const previous = params[key];
    params[key] = previous === undefined ? value : ([] as string[]).concat(previous, value);
  }
  const prefill = readComposeParams(params);
  return Object.freeze({ ...prefill, issues: Object.freeze([...prefill.issues, ...extra]), ok: true });
}

/**
 * Parts for expo-linking createURL(path, { queryParams }). Throws only on an
 * invalid username; an invalid amount or note is simply left out.
 */
export function composeLinkParts(
  username: string,
  options: { amount?: string | null; note?: string | null } = {},
): { path: string; queryParams: Record<string, string> } {
  if (!USERNAME.test(username)) throw Error('Destinataire invalide.');
  const queryParams: Record<string, string> = {};
  if (options.amount) {
    const checked = validateAmount(options.amount);
    if ('amount' in checked) queryParams.amount = checked.amount;
  }
  if (options.note) {
    const checked = validateNote(options.note);
    if ('note' in checked) queryParams.note = checked.note;
  }
  return { path: `compose/${username}`, queryParams };
}

/** Relative web path, e.g. /compose/alice?amount=10 */
export function composeWebPath(username: string, options: { amount?: string | null; note?: string | null } = {}): string {
  const { path, queryParams } = composeLinkParts(username, options);
  const query = new URLSearchParams(queryParams).toString();
  return `/${path}${query ? `?${query}` : ''}`;
}

export function shareMessage(name: string, username: string, url: string, amount?: string | null): string {
  const what = amount ? `un soutien de ${amount} ◈ à ${name} (@${username})` : `un soutien à ${name} (@${username})`;
  return `Je te propose ${what} sur MIND : ${url}\nCe lien ouvre un brouillon à relire. Il n’envoie aucun paiement.`;
}

export function issuesSummary(issues: readonly LinkIssue[]): string | null {
  if (!issues.length) return null;
  return `Paramètre${issues.length > 1 ? 's' : ''} ignoré${issues.length > 1 ? 's' : ''} : ${issues.map(issue => `${issue.param} (${issue.reason})`).join(' ; ')}.`;
}
