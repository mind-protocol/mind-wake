import fs from 'node:fs';
import path from 'node:path';
import { ChatError } from './chat-server.mjs';
import { PREFIX, shortLabel, MIRROR_TAG, isSilence, MAIN_HANDLE } from './chat-call.mjs';

/**
 * Sonnerie (NLR, 16 nov. 2026, 21:46) : « que les agents puissent m'appeler au téléphone quand ils
 * me posent une question, que l'application sonne littéralement ».
 *
 * Une question à NLR = un message d'agent du fil principal (message_owner, holders et rooms qui y
 * écrivent avec leur préfixe « Nom : ») qui :
 * - porte le marqueur explicite `[sonner]` ou commence par 📞 ; ou
 * - se termine par un point d'interrogation (dernière ligne, ponctuation et emoji de fin ignorés).
 * `[sans-sonnerie]` l'en empêche. Les copies d'appel, SILENCE et les messages d'un interlocuteur
 * déjà en appel ne sonnent jamais. L'app sonde `/chat/ring?since=` et affiche « <agent> t'appelle ».
 */
export const RING_MARKER = /\[sonner\]|^\s*📞️?\s*/iu;
export const NO_RING_MARKER = /\[sans-sonnerie\]/i;
export const RING_MAX_AGE_MS = 10 * 60_000;
/**
 * Rappel programmé (NLR, 16 nov. 2026, 21:49) : « je te rappelle dans 10 minutes », puis l'agent
 * rappelle vraiment. Marqueur `[rappel: 10 min]` (`[rappel: 2 h]`, `[rappel: 1 h 30]`) ou la phrase
 * « je te rappelle dans 10 minutes ». Le rappel est tenu par la passerelle (fichier sur disque), jamais
 * par la mémoire de l'agent : à l'échéance, le téléphone sonne et une notice est posée dans le fil de
 * l'agent pour qu'il rappelle avec ce qu'il a fait entre-temps. Délai plafonné à 24 h.
 */
export const CALLBACK_MARKER = /\[rappel\s*:\s*(\d{1,4})\s*(min(?:utes?)?|m|h(?:eures?)?)\s*(?:(\d{1,2})\s*(?:min)?)?\s*\]/i;
const CALLBACK_PHRASE = /\bje (?:te|vous) (?:rappelle|rappellerai) dans (\d{1,4})\s*(min(?:utes?)?|h(?:eures?)?)(?![\p{L}])/iu;
export const CALLBACK_MAX_MS = 24 * 60 * 60_000;
export const callbackNotice = reason => `[Rappel programmé] C'est l'heure de rappeler NLR : dis-lui ce que tu as fait depuis. `
  + `Ton message d'alors : « ${reason} »`;
const TAIL = /[\s*_`»"'”’)\]\p{Extended_Pictographic}️‍]+$/u;
const clip = (text, max = 180) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Rappel annoncé dans un message : { delayMs, reason } ou null. */
export function ringCallback(text) {
  const raw = String(text ?? '');
  if (!raw.trim() || raw.trimStart().startsWith(MIRROR_TAG) || NO_RING_MARKER.test(raw)) return null;
  const match = CALLBACK_MARKER.exec(raw) ?? CALLBACK_PHRASE.exec(raw);
  if (!match) return null;
  const hours = /^h/i.test(match[2]);
  const delayMs = (Number(match[1]) * (hours ? 60 : 1) + (hours ? Number(match[3] ?? 0) : 0)) * 60_000;
  if (!(delayMs > 0) || delayMs > CALLBACK_MAX_MS) return null;
  const rest = raw.replace(CALLBACK_MARKER, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return { delayMs, reason: clip(rest || 'Rappel promis') };
}

/** Question à faire sonner, ou null. Le texte rendu est la dernière phrase interrogative (180 caractères au plus). */
export function ringQuestion(text) {
  const raw = String(text ?? '');
  if (!raw.trim() || NO_RING_MARKER.test(raw) || raw.trimStart().startsWith(MIRROR_TAG) || isSilence(raw)) return null;
  const explicit = RING_MARKER.test(raw);
  const body = raw.replace(/\[sonner\]/gi, '').replace(CALLBACK_MARKER, '').replace(/^\s*📞️?\s*/u, '').trim();
  const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
  const last = (lines.at(-1) ?? '').replace(TAIL, '');
  if (!explicit && !last.endsWith('?')) return null;
  const sentences = last.split(/(?<=[.!?…])\s+(?=\S)/);
  let question = explicit && !last.endsWith('?') ? body.replace(/\s+/g, ' ') : sentences.at(-1);
  // Une question très courte (« Ok ? ») garde la phrase précédente pour le contexte.
  if (!explicit && question.length < 25 && sentences.length > 1) question = sentences.slice(-2).join(' ');
  question = question.replace(/\*\*/g, '').trim();
  return question ? clip(question) : null;
}

/** Qui appelle : préfixe « Nom : » / « 🪙 Nom · » rapproché des interlocuteurs d'appel, sinon l'agent principal. */
export function ringCaller(text, targets = [], mainLabel = 'Marco') {
  const main = { handle: MAIN_HANDLE, label: mainLabel, text: String(text) };
  const match = PREFIX.exec(String(text).replace(/^\s*📞️?\s*/u, ''));
  if (!match) return main;
  const name = match[2].trim().toLowerCase();
  const target = targets.find(t => t.handle !== MAIN_HANDLE && (shortLabel(t.label).toLowerCase() === name
    || t.handle === name || shortLabel(t.label).toLowerCase().split(' · ')[0] === name));
  if (target) return { handle: target.handle, label: target.label, text: String(text).slice(match[0].length) };
  // Préfixe de holder (emoji + « · ») inconnu de la table : on garde son nom, l'appel part au fil principal.
  if (match[1] && match[3] === '·') return { ...main, label: `${match[1]} ${match[2].trim()}` };
  return main;
}

/** Rappels persistés : JSON écrit atomiquement (fichier temporaire puis renommage). */
export function createCallbackFileStore(file) {
  return {
    load() { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(value?.callbacks) ? value.callbacks : []; } catch { return []; } },
    save(callbacks) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: 'mind.chat.callbacks.v1', callbacks }, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}

/**
 * deps : snapshot() → messages du fil principal ; targets() → interlocuteurs d'appel ;
 * active() → appels en cours [{ handles }] ; store { load, save } des rappels ;
 * notify(handle, key, text) → notice dans le fil de l'agent à l'échéance d'un rappel.
 * La fonction rendue sert `/chat/ring` ; `.tick()` enregistre les rappels annoncés et fait sonner les échus.
 */
export function createRingFeed({ snapshot, targets = () => [], active = () => [], mainLabel = 'Marco', now = Date.now,
  maxAgeMs = RING_MAX_AGE_MS, limit = 5, store = null, notify = null, keep = 200 } = {}) {
  if (typeof snapshot !== 'function') throw new Error('Ring feed requires the owner thread');
  const callbacks = new Map((store?.load() ?? []).filter(c => c?.id).map(c => [c.id, c]));
  const persist = () => store?.save([...callbacks.values()]);
  const listTargets = () => { try { return targets() ?? []; } catch { return []; } };
  let ticking = null;

  /** Enregistre chaque rappel annoncé une seule fois (clé = message), puis déclenche ceux qui sont dus. */
  function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const messages = await snapshot();
      const list = listTargets(); let changed = false;
      for (const m of Array.isArray(messages) ? messages : []) {
        if (m?.role !== 'agent' || typeof m.text !== 'string' || !Number.isFinite(Date.parse(m.at))) continue;
        const id = `ring:${m.id}:rappel`;
        if (callbacks.has(id)) continue;
        const caller = ringCaller(m.text, list, mainLabel);
        const callback = ringCallback(caller.text);
        if (!callback) continue;
        callbacks.set(id, { id, messageId: m.id, handle: caller.handle, label: caller.label, reason: callback.reason,
          scheduledAt: m.at, dueAt: new Date(Date.parse(m.at) + callback.delayMs).toISOString(), firedAt: null, noticed: false });
        changed = true;
      }
      for (const c of callbacks.values()) {
        if (Date.parse(c.dueAt) > now()) continue;
        if (!c.firedAt) { c.firedAt = new Date(now()).toISOString(); changed = true; }
        if (!c.noticed && typeof notify === 'function') {
          // Clé d'idempotence : un redémarrage entre la notice et l'écriture ne la double pas.
          try { await notify(c.handle, `ring-callback:${c.messageId}`.slice(0, 128), callbackNotice(c.reason)); c.noticed = true; changed = true; }
          catch { /* Nouvel essai au prochain passage. */ }
        }
      }
      // Les plus anciens rappels déjà sonnés sortent du fichier au-delà de `keep`.
      const fired = [...callbacks.values()].filter(c => c.firedAt && c.noticed).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      for (const c of fired.slice(0, Math.max(0, callbacks.size - keep))) { callbacks.delete(c.id); changed = true; }
      if (changed) persist();
    })().finally(() => { ticking = null; });
    return ticking;
  }

  async function events(since) {
    const floor = Date.parse(since);
    if (!Number.isFinite(floor)) throw new ChatError('invalid_request');
    await tick();
    const messages = await snapshot();
    if (!Array.isArray(messages)) throw new ChatError('wake_unavailable', 503);
    let busy = new Set(); try { busy = new Set((active() ?? []).flatMap(c => c.handles ?? [])); } catch { /* Aucun appel. */ }
    const list = listTargets();
    const oldest = now() - maxAgeMs;
    const out = [];
    for (const m of messages) {
      if (m?.role !== 'agent' || typeof m.text !== 'string') continue;
      const at = Date.parse(m.at);
      if (!(at > floor) || at < oldest) continue;
      const caller = ringCaller(m.text, list, mainLabel);
      // Déjà en ligne avec cet agent : la réponse s'affiche dans l'appel, pas de seconde sonnerie.
      if (busy.has(caller.handle) || ringCallback(caller.text)) continue;
      const question = ringQuestion(caller.text);
      if (question) out.push({ id: `ring:${m.id}:${m.version ?? 1}`, kind: 'question', messageId: m.id, at: m.at,
        handle: caller.handle, label: caller.label, question });
    }
    // Rappels : sonnent à leur échéance (jamais avant), y compris après un redémarrage de la passerelle.
    for (const c of callbacks.values()) {
      // Comparé à l'heure où la passerelle l'a déclenché : un client qui a déjà avancé son curseur ne le manque pas.
      const fired = Date.parse(c.firedAt ?? '');
      if (!(fired > floor) || fired < oldest || busy.has(c.handle)) continue;
      out.push({ id: c.id, kind: 'callback', messageId: c.messageId, at: c.firedAt, dueAt: c.dueAt, handle: c.handle, label: c.label,
        question: c.reason, scheduledAt: c.scheduledAt });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
  }
  /** Rappels pas encore dus (affichables, sans sonnerie). */
  events.pending = () => [...callbacks.values()].filter(c => !c.firedAt)
    .map(({ id, handle, label, reason, dueAt }) => ({ id, handle, label, reason, dueAt }));
  events.tick = tick;
  return events;
}
