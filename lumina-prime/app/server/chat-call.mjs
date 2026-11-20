import { ChatError } from './chat-server.mjs';
import { createHash } from 'node:crypto';
import { cleanTranscript } from './stt-hallucinations.mjs';

/**
 * Mode « Appel » de l'app mobile (NLR, 16 nov. 2026 17:53 et 17:55) : chaque prise de parole
 * transcrite part à l'interlocuteur choisi, et ses réponses sont lues à voix haute sur le
 * téléphone avec la voix de cet agent.
 *
 * Interlocuteurs : MIND (fil principal, par défaut) et la table `@handle` du pont Telegram
 * (rooms, agents de room, pattern holders du fil principal). La remise réutilise ce chemin
 * (`routeTelegramHandle`), sans en dupliquer la logique. Rien ne synthétise un texte fourni par
 * le client : la voix ne lit qu'une réponse retrouvée dans le fil de l'interlocuteur.
 */
export const MAIN_HANDLE = 'mind';
export const CALL_TAG = '[Appel vocal en cours]';
/** NLR, 16 nov. : réponses rapides et en petits morceaux, lues à voix haute au fil de l'eau. */
/** NLR, 16 nov. : plusieurs messages courts, chacun pouvant tenir en quelques phrases courtes. */
export const CALL_INSTRUCTION = `${CALL_TAG} Réponds vite, à l'oral, en plusieurs messages courts : d'abord ce que tu vas faire, tout de suite ; puis des points d'étape si ça prend du temps ; puis la réponse. Chaque message peut tenir en quelques phrases courtes. Pas de listes ni de markdown.`;
export const callBody = text => `${CALL_INSTRUCTION}\n\n${text.trim()}`;
const HANDLE = /^[a-z0-9][a-z0-9_.-]{0,60}$/;
const ITEM = /^(?:m:[A-Za-z0-9_.:-]{1,120}|r[2-9]:\d{1,12})(?:~\d{1,3})?$/;
export const MAX_TARGETS = 8;
/** Une invitation par sujet reste valable ce temps : l'agent ajouté reçoit la phrase qui l'a appelé. */
export const TOPIC_PENDING_MS = 3 * 60_000;

const foldTopic = text => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const escapeTopic = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Sujets déclarés présents dans un texte (NLR, 18 nov. 2026 14:55 : « tout ce qui parle de la
 * visualisation, c'est l'agent Viz, il faut le rajouter au call »). Même règle que `topicIn` du
 * runtime (pattern-holders.ts) : mot ou expression entière, sans accents ni casse, le sujet le
 * plus long d'abord ; une correspondance au plus par agent. `registry` : [{ handle, topics }].
 */
export function topicHits(text, registry) {
  const folded = foldTopic(text); const hits = [];
  for (const entry of Array.isArray(registry) ? registry : []) {
    if (!entry || typeof entry.handle !== 'string' || !Array.isArray(entry.topics)) continue;
    const topic = entry.topics.filter(t => typeof t === 'string' && t.trim().length >= 3)
      .sort((a, b) => b.length - a.length)
      .find(t => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeTopic(foldTopic(t).trim())}($|[^\\p{L}\\p{N}])`, 'u').test(folded));
    if (topic) hits.push({ handle: entry.handle, topic });
  }
  return hits;
}
/** Identifiant de remise dérivé (format chat-<uuid>) : la phrase renvoyée à l'agent invité. */
const derivedChatId = (id, handle) => {
  const h = createHash('sha256').update(`${id}|topic|${handle}`).digest('hex');
  return `chat-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** Phrases regroupées en morceaux courts ; le premier reste une seule phrase pour que la voix démarre vite. */
export function speechChunks(text, max = 240) {
  const sentences = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+(?=\S)/).filter(Boolean);
  const out = [];
  for (const sentence of sentences) {
    const last = out.at(-1);
    if (out.length > 1 && last.length + sentence.length + 1 <= max && last.length < 120) out[out.length - 1] = `${last} ${sentence}`;
    else out.push(sentence);
  }
  return out.slice(0, 40);
}
export const PREFIX = /^(?:(\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*)\s+)?([^\s:·][^:·\n]{0,48}?)\s*([:·])\s+/u;
export const shortLabel = label => String(label).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D]*\s*/u, '').replace(/\s*\((?:Room \d+|fil principal)\)\s*$/, '').replace(/^Room \d+ \((.+)\)$/, '$1').trim();
/**
 * Préfixe unique (NLR, 18 nov. 2026, lot 2) : « Marco : Marco : … » venait d'un texte qui portait
 * déjà « Marco : » et qu'une autre voie préfixait encore. Retire en tête le nom de l'orateur
 * (« Nom : » ou « 🕸️ Nom · »), répété ou non, pour qu'un seul préfixe soit posé ensuite.
 */
export function stripSpeakerPrefix(name, text) {
  const bare = shortLabel(name ?? '');
  let out = String(text ?? '').trim();
  if (!bare) return out;
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(String.raw`^(?:\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s*)?` + escaped + String.raw`\s*[:·]\s*`, 'iu');
  while (head.test(out)) out = out.replace(head, '').trim();
  return out;
}
/** Rappel du même interlocuteur peu après (raccroché puis rappelé) : même échange, pas de nouveau préavis ni de nouveau décroché. */
export const RING_REPEAT_MS = 120_000;
/** Morceau `~k` d'une réponse découpée. */
const chunkId = (id, index, count) => (count > 1 ? `${id}~${index}` : id);

/**
 * Appel = room partagée temporaire (NLR, 16 nov. 2026) : pendant l'appel, chaque réponse d'un
 * participant est recopiée dans le fil de chaque autre participant, en notice « [Appel] Nom : … ».
 * Une copie n'est jamais une réponse d'agent (notice de room, message pair au fil principal) :
 * elle n'est donc jamais recopiée à son tour, ne compte pas comme message humain et ne réveille
 * personne. Seule la parole de NLR réveille les participants ; les copies sont du contexte lu au
 * prochain réveil.
 */
export const MIRROR_TAG = '[Appel]';
// Retained only to recognize silence in older conversation entries.
export const MIRROR_RULE = "(Règle d'appel : Marco répond par défaut ; les autres participants ne parlent que s'ils apportent quelque chose de neuf, sinon SILENCE.)";
/**
 * Copie d'appel entière (NLR, 18 nov. 2026 14:50) : plus de coupe à 1 200 caractères. La limite
 * reste sous le budget du hook du fil principal (OWNER_HOOK_MAX_CHARS = 8 000, src/communication/
 * owner-inbox.ts) ; une coupe éventuelle est signalée en clair, jamais par un simple « … ».
 */
export const MIRROR_MAX_CHARS = 6000;
/** Regroupement des morceaux d'un même orateur pour les agents : accalmie, puis plafond d'attente. */
export const MIRROR_QUIET_MS = 5000;
export const MIRROR_MAX_WAIT_MS = 20_000;
/** Préavis d'appel (NLR, 17 nov. 2026) : l'appelé sait que NLR l'appelle avant la première phrase. */
export const ringText = (callId, caller = 'NLR') => `${MIRROR_TAG} 📞 ${caller} t'appelle — prépare-toi à décrocher et envoie-lui ce que tu as à lui dire (appel ${callId}).`;
/** Une copie : un ou plusieurs morceaux consécutifs du même orateur, dans l'ordre, séparés par une ligne vide. */
export const mirrorText = (speaker, text) => {
  const body = (Array.isArray(text) ? text : [text]).map(part => String(part).trim()).filter(Boolean).join('\n\n');
  const clipped = body.length > MIRROR_MAX_CHARS
    ? `${body.slice(0, MIRROR_MAX_CHARS)}… [copie d'appel coupée : ${body.length - MIRROR_MAX_CHARS} caractères non recopiés]`
    : body;
  return `${MIRROR_TAG} ${speaker} : ${clipped}`;
};
/** Copie d'un orateur : son nom déjà en tête d'un morceau n'est pas recopié une seconde fois. */
const mirrorOf = (speaker, parts) => mirrorText(speaker, parts.map(part => stripSpeakerPrefix(speaker, part)));
/** Convention « pas de réponse » : texte SILENCE, ou dernière ligne SILENCE une fois la règle d'appel retirée. */
export function isSilence(text) {
  const lines = String(text).split(MIRROR_RULE).join('').split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && /^\**SILENCE\**\.?$/.test(lines.at(-1));
}
const keySafe = value => String(value).replace(/[^A-Za-z0-9_.:-]/g, '_');

/**
 * deps :
 * - mainLabel : nom affiché de l'agent principal ; mainAgentId : id pour la voix.
 * - handleTable() : Map handle → { room, agent: {id,name}|null, holder?, label } (telegramHandleTable).
 * - routeHandle(handle, text, id) : remise d'une room/agent (routeTelegramHandle).
 * - sendMain(id, text) : envoi au fil principal (bridge.send) ; wakeMain() : demande de réveil.
 * - mainReplies() : messages du fil principal (bridge.snapshot) ; roomEntries(room) : entrées de la room.
 * - speak(text, agentId) : { bytes, mime, provider }.
 * - holders() : [{ slug, name, emoji, thread: 'principal' | 'fork:<n>' | null }] (pattern holders et leur fil).
 * - owners() : Map room → { handle, name } : l'agent propriétaire d'une room (VOX pour la room 7).
 * - transcribing() : vrai pendant une transcription ; la voix attend, la transcription de NLR passe d'abord.
 */
export function createCallService({ mainLabel = 'Marco', mainAgentId = MAIN_HANDLE, handleTable, routeHandle,
  sendMain, wakeMain = () => {}, mainReplies, roomEntries, speak, holders: holderList, owners: ownerMap,
  transcribing: busy = () => false, now = Date.now, cacheSize = 12,
  noticeMain = null, noticeRoom = null, answerCall = null, mirrorPerMinute = 20, idleMs = 45_000, mirrorIntervalMs = 2000,
  mirrorQuietMs = MIRROR_QUIET_MS, mirrorMaxWaitMs = MIRROR_MAX_WAIT_MS, topics: topicList = null } = {}) {
  let transcribing = busy;
  let remote = null;
  if (typeof sendMain !== 'function' || typeof mainReplies !== 'function' || typeof speak !== 'function')
    throw new Error('Call service requires main thread and speech');
  const table = () => { try { return handleTable?.() ?? new Map(); } catch { return new Map(); } };
  const holders = () => { try { return (holderList?.() ?? []).filter(h => h && HANDLE.test(h.slug) && h.thread); } catch { return []; } };
  const owners = () => { try { return ownerMap?.() ?? new Map(); } catch { return new Map(); } };
  const roomOf = thread => (/^fork:\d+$/.test(thread ?? '') ? Number(thread.slice(5)) : 0);
  /** Holder qui écoute le fil d'une room (champ « holder » de son affectation). */
  const roomHolder = (room, list = holders()) => list.find(h => roomOf(h.thread) === room) ?? null;
  const holderLabel = h => (h.emoji ? `${h.emoji} ${h.name}` : h.name);

  function resolve(handle) {
    if (typeof handle !== 'string' || !HANDLE.test(handle)) throw new ChatError('call_target_invalid');
    const distant = remote?.resolve(handle);
    if (distant) return distant;
    if (handle === MAIN_HANDLE) return { handle, kind: 'main', label: mainLabel, agentId: mainAgentId };
    const target = table().get(handle);
    // Un agent de room reste joint dans sa room, même s'il porte aussi un fichier de holder (coachs).
    if (!target?.agent) {
      const holder = holders().find(h => h.slug === handle);
      if (holder) {
        const room = roomOf(holder.thread);
        // Holder du fil principal : @slug au fil principal ; holder d'une room : @slug dans le fil de sa room
        // (c'est le fil qu'il écoute, holderThread).
        const base = { handle, kind: 'holder', label: holderLabel(holder), agentId: holder.slug, mention: `@${holder.slug}` };
        return room ? { ...base, room, prefix: `${holder.emoji} ${holder.name} · ` } : base;
      }
    }
    if (!target) throw new ChatError('call_target_unknown', 404);
    if (target.holder !== undefined)
      return { handle, kind: 'holder', label: target.label, agentId: target.holder, mention: `@${target.holder}` };
    const holder = target.agent ? null : roomHolder(target.room);
    return { handle, kind: target.agent ? 'agent' : 'room', label: target.label, room: target.room,
      agent: target.agent ? { id: target.agent.id, name: target.agent.name } : null,
      // Une room appelée réveille aussi son holder (NLR : « donne au gardien de VOX la possibilité de répondre »).
      holderMention: holder ? `@${holder.slug}` : null,
      // Voix : id de l'agent, sinon nom de la room (vox) ou alias room-<n> du registre des voix.
      agentId: target.agent?.id ?? (/^room\d+$/.test(handle) ? `room-${target.room}` : handle) };
  }

  /**
   * Marco d'abord, puis les agents (propriétaires de room comme VOX, holders, agents de room),
   * puis les rooms (handle room<n>). Une ligne par interlocuteur.
   */
  function targets() {
    const current = table(); const entries = [...current];
    const list = holders();
    const roomName = room => /^(.*) \(Room \d+\)$/.exec(current.get(`room${room}`)?.label ?? '')?.[1] ?? null;
    const agents = []; const rooms = []; const seen = new Set([MAIN_HANDLE]);
    const push = (bucket, item) => { if (seen.has(item.handle)) return; seen.add(item.handle); bucket.push(item); };
    for (const [room, owner] of [...owners()].sort((a, b) => a[0] - b[0]))
      if (owner?.handle && current.get(owner.handle)?.room === room)
        push(agents, { handle: owner.handle, label: owner.name ?? owner.handle, kind: 'agent', room });
    const agentIds = new Set(entries.filter(([, t]) => t.agent).map(([, t]) => t.agent.id));
    const listed = new Set();
    for (const h of list) {
      if (agentIds.has(h.slug)) continue;
      const room = roomOf(h.thread); listed.add(h.slug);
      push(agents, { handle: h.slug, label: holderLabel(h) + (room ? ` · ${roomName(room) ?? `Room ${room}`}` : ''), kind: 'holder', ...(room ? { room } : {}) });
    }
    // Holders du fil principal connus de la seule table (sans liste de holders).
    for (const [handle, t] of entries)
      if (t.holder !== undefined && handle === t.holder && !listed.has(handle) && !agentIds.has(handle))
        push(agents, { handle, label: t.label, kind: 'holder' });
    for (const [handle, t] of entries) {
      if (!t.agent || handle !== t.agent.id) continue;
      const h = list.find(item => item.slug === t.agent.id);
      push(agents, { handle, label: h ? `${holderLabel(h)}${h.name === t.agent.name ? '' : ` · ${t.agent.name}`} (Room ${t.room})` : t.label, kind: 'agent', room: t.room });
    }
    const roomIds = [...new Set(entries.filter(([, t]) => !t.agent && t.holder === undefined).map(([, t]) => t.room))].sort((a, b) => a - b);
    for (const room of roomIds) {
      const handle = current.has(`room${room}`) ? `room${room}`
        : entries.find(([, t]) => t.room === room && !t.agent && t.holder === undefined)[0];
      const name = roomName(room);
      push(rooms, { handle, label: `Room ${room}${name ? ` · ${name}` : ''}`, kind: 'room', room });
    }
    return [...[{ handle: MAIN_HANDLE, label: mainLabel, kind: 'main' }, ...agents, ...rooms].slice(0, 120), ...(remote?.targets() ?? [])];
  }

  /** `handles` : un handle ou une liste (« room 1 + vox »), `a,b` accepté. */
  function parseTargets(handles) {
    const list = [...new Set((Array.isArray(handles) ? handles : String(handles ?? '').split(',')).map(h => String(h).trim()).filter(Boolean))];
    if (!list.length || list.length > MAX_TARGETS) throw new ChatError('call_target_invalid');
    return list.map(resolve);
  }
  /**
   * Agents dont un sujet déclaré est dans la phrase de l'humain et qui ne sont pas dans l'appel :
   * proposés une seule fois par appel (même retirés ensuite), dans la limite des places. L'app les
   * ajoute (addSession) en l'annonçant d'une ligne ; la phrase leur est alors remise.
   */
  function topicInvites(c, id, text, context) {
    if (typeof topicList !== 'function' || String(context.owner).startsWith('peer:')) return [];
    let registry; try { registry = topicList() ?? []; } catch { return []; }
    c.topicOffered ??= new Set(); c.topicPending ??= new Map();
    const invites = [];
    for (const hit of topicHits(text, registry)) {
      if (c.targets.size + invites.length >= MAX_TARGETS) break;
      if (c.targets.has(hit.handle) || c.topicOffered.has(hit.handle)) continue;
      let target; try { target = resolve(hit.handle); } catch { continue; }
      if (target.kind === 'remote') continue;
      c.topicOffered.add(hit.handle);
      c.topicPending.set(hit.handle, { id, text, speaker: context.speaker ?? null, at: now() });
      invites.push({ handle: hit.handle, label: target.label, topic: hit.topic });
    }
    return invites;
  }
  /** Une seule transcription, une remise par fil ; la consigne « réponds vite » précède le texte. */
  async function deliver(handles, id, text, context = null, audio = null) {
    let targets = parseTargets(handles); let invites = [];
    // Parole d'appel seulement (orateur ou mesure audio) : hallucinations de Whisper sur le silence écartées.
    if (audio || context?.speaker) {
      const cleaned = cleanTranscript(text, audio ?? {});
      if (cleaned.text === null) return { status: 'dropped', reason: cleaned.reason, at: new Date(now()).toISOString(), label: '' };
      text = cleaned.text;
    }
    if (context) {
      const current = assertSession(context.owner, context.id, context.epoch);
      targets = targets.filter(t => current.targets.has(t.handle));
      // Invités par un agent (invite_to_call) : l'app ne les connaît pas encore, ils entendent quand même.
      for (const handle of current.agentInvited ?? [])
        if (current.targets.has(handle) && !targets.some(t => t.handle === handle)) targets.push(current.targets.get(handle).target);
      if(!targets.length) return {status:'empty',at:new Date(now()).toISOString(),label:''};
      current.lastActivity = now();
      invites = topicInvites(current, id, text, context);
    } else joinCall(targets);
    const distant = targets.filter(t => t.kind === 'remote');
    if (distant.length) {
      if (!context) throw new ChatError('call_session_required');
      await remote.deliver(distant, id, text, assertSession(context.owner, context.id, context.epoch),context.speaker);
    }
    const body = callBody(context?.speaker ? `[${context.speaker}] ${text}` : text);
    const delivered = []; let at = new Date(now()).toISOString();
    // Fil principal (MIND et holders du fil principal) : un seul message, les holders mentionnés en tête.
    const main = targets.filter(t => t.kind === 'main' || (t.kind === 'holder' && !t.room));
    if (main.length) {
      const mentions = main.filter(t => t.kind === 'holder').map(t => t.mention).join(' ');
      const invitation = mentions && main.some(t => t.kind === 'main')
        ? `Participants appelés : ${targets.map(t => t.label).join(', ')}. ${mainLabel}, réponds dans ce fil : l’app y lit tes messages.\n`
        : '';
      const receipt = await sendMain(id, mentions ? `${mentions} ${invitation}${body}` : body);
      try { wakeMain(); } catch { /* Le message reste enregistré ; le scheduler décide du réveil. */ }
      at = receipt?.at ?? at; delivered.push(...main.map(t => t.label));
    }
    // Rooms : un message par room, son holder et les holders choisis de cette room mentionnés en tête.
    function routesFor(list) {
      const byRoom = new Map();
      for (const t of list.filter(t => t.kind === 'room'))
        if (!byRoom.has(t.room)) byRoom.set(t.room, { key:`room:${t.room}`,handle: t.handle, fallback: t.label, mentions: new Set(t.holderMention ? [t.holderMention] : []), labels: [null] });
      for (const t of list.filter(t => t.kind === 'holder' && t.room)) {
        const slot = byRoom.get(t.room) ?? { key:`room:${t.room}`,handle: `room${t.room}`, fallback: t.label, mentions: new Set(), labels: [] };
        slot.mentions.add(t.mention); slot.labels.push(t.label); byRoom.set(t.room, slot);
      }
      const routes = [...byRoom.values()].map(slot => ({ ...slot, text: slot.mentions.size ? `${[...slot.mentions].join(' ')} ${body}` : body }));
      for (const t of list.filter(t => t.kind === 'agent')) routes.push({ key:`agent:${t.handle}`,handle: t.handle, fallback: t.label, labels: [null], text: body });
      return routes;
    }
    const planned = routesFor(targets);
    for (const initial of planned) {
      // Rebuild grouped mentions immediately before each handoff. A retained room/holder
      // does not authorise mentioning a different participant removed during an earlier await.
      let route=initial;
      if(context) {
        const current=assertSession(context.owner,context.id,context.epoch);
        const retained=targets.filter(t=>current.targets.has(t.handle));
        route=routesFor(retained).find(candidate=>candidate.key===initial.key);
        if(!route)continue;
      }
      if (typeof routeHandle !== 'function') throw new ChatError('call_target_unavailable', 503);
      // Stable grouped destination under scoped retries, even when one mention was removed.
      const key=context?`${id}:${route.key}`:targets.length>1?`${id}:${route.handle}`:id;
      const result = await routeHandle(route.handle, route.text, key);
      if (result?.status !== 'routed') throw new ChatError('call_target_unavailable', 503);
      delivered.push(...route.labels.map(label => label ?? result.label ?? route.fallback));
    }
    return { label: [...delivered, ...distant.map(t => t.label)].join(' + '), at, ...(invites.length ? { invites } : {}) };
  }

  /** Noms des participants connus → voix (id d'agent ou slug de holder). */
  function speakers() {
    const names = new Map();
    // L'agent principal signe « Marco : » : son nom est reconnu comme les autres, donc retiré du texte.
    names.set(shortLabel(mainLabel).toLowerCase(), mainAgentId);
    for (const target of table().values()) {
      if (target.agent) names.set(target.agent.name.toLowerCase(), target.agent.id);
      else if (target.holder !== undefined) names.set(shortLabel(target.label).toLowerCase(), target.holder);
    }
    return names;
  }
  /** Qui parle : « Nom : » d'un agent connu, ou « 🪙 Nom · » d'un holder ; sinon l'interlocuteur lui-même. */
  function speakerOf(text, target, names) {
    const match = PREFIX.exec(text);
    if (match) {
      const name = match[2].trim(); const known = names.get(name.toLowerCase());
      if (known || (match[3] === '·' && match[1]))
        // NLR, 16 nov. 2026 : l'emoji du holder reste à côté de son nom (« 🪙 Crypto »).
        return { speaker: match[1] ? `${match[1].trim()} ${name}` : name, voice: known ?? name, named: true,
          text: stripSpeakerPrefix(name, text.slice(match[0].length)) };
    }
    return { speaker: shortLabel(target.label), voice: target.agentId, text: stripSpeakerPrefix(target.label, text) };
  }

  /** Réponses d'agent d'un interlocuteur déjà résolu, non découpées (toutes dates). */
  async function rawItems(target, names = speakers(), context = null) {
    if (target.kind === 'remote') return remote.items(target, context);
    if (target.kind === 'main' || (target.kind === 'holder' && !target.room)) {
      const messages = await mainReplies();
      if (!Array.isArray(messages)) throw new ChatError('wake_unavailable', 503);
      const mainSpeaker = { label: mainLabel, agentId: mainAgentId };
      return messages.filter(m => m.role === 'agent' && typeof m.text === 'string')
        .map(m => ({ id: `m:${m.id}`, at: m.at, ...speakerOf(m.text, mainSpeaker, names) }))
        .filter(item => !isSilence(item.text));
    }
    if (typeof roomEntries !== 'function') throw new ChatError('call_target_unavailable', 503);
    const prefix = target.agent ? `${target.agent.name} :` : null;
    // Les copies d'appel sont des notices (rôle humain) : jamais relues comme réponses d'agent.
    return (await roomEntries(target.room) ?? []).filter(e => e.role === 'agent' && typeof e.text === 'string'
      && (!prefix || e.text.trim().toLowerCase().startsWith(prefix.toLowerCase()))
      && (!target.prefix || e.text.startsWith(target.prefix)))
      .map(e => ({ id: `r${target.room}:${e.id}`, at: e.at, ...(prefix
        ? { speaker: target.agent.name, voice: target.agent.id, named: true, text: stripSpeakerPrefix(target.agent.name, e.text.trim().slice(prefix.length)) }
        : speakerOf(e.text, target, names)) }))
      // SILENCE n'est ni lu à voix haute, ni affiché dans l'app, ni recopié aux autres participants.
      .filter(item => !isSilence(item.text));
  }

  /** Réponses de l'interlocuteur postérieures à `since` (ISO), les plus anciennes d'abord. */
  async function replies(handle, since, scope = null) {
    const target = resolve(handle);
    const context=scope?assertSession(scope.owner,scope.id,scope.epoch):null;
    if(context&&!context.targets.has(handle))throw new ChatError('call_target_not_joined',403);
    if(target.kind==='remote'&&!context)return [];
    const floor = Date.parse(since);
    if (!Number.isFinite(floor)) throw new ChatError('invalid_request');
    touch(handle);
    const items = await rawItems(target, speakers(), context);
    // Une réponse longue devient des morceaux phrase par phrase : la voix démarre sur la première.
    return items.filter(item => Date.parse(item.at) > floor && item.text.trim())
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-20)
      .flatMap(item => {
        const chunks = speechChunks(item.text);
        return chunks.map((text, index) => ({ id: chunkId(item.id, index, chunks.length), at: item.at, text,
          speaker: item.speaker, voice: item.voice, first: index === 0 }));
      });
  }

  // --- Appel = room partagée temporaire -------------------------------------------------------
  /** Appels actifs : id → { targets: Map handle → { target, joinedAt }, lastActivity, seen, sent }. */
  const calls = new Map(); let callSeq = 0;
  const channelOf = t => t.kind === 'remote' ? t.channel : (t.kind === 'main' || (t.kind === 'holder' && !t.room) ? 'main' : `room:${t.room}`);
  const callOf = handle => [...calls.values()].find(c => !c.explicit && c.targets.has(handle)) ?? null;
  /** Le sondage des réponses par l'app garde l'appel ouvert ; sans sondage, il expire (idleMs). */
  function touch(handle) { const c = callOf(handle); if (c) c.lastActivity = now(); }
  /** Une prise de parole ouvre l'appel, ou met à jour ses participants s'il en partage un. */
  function joinCall(targets) {
    const at = now();
    let call = targets.map(t => callOf(t.handle)).find(Boolean);
    if (!call) {
      call = { id: `c${at.toString(36)}${(callSeq++).toString(36)}`, startedAt: at, targets: new Map(), seen: new Set(), sent: [] };
      calls.set(call.id, call);
    }
    const next = new Map();
    for (const t of targets) next.set(t.handle, call.targets.get(t.handle) ?? { target: t, joinedAt: at });
    for (const other of calls.values()) if (other !== call && !other.explicit) for (const t of targets) other.targets.delete(t.handle);
    for (const [id, other] of calls) if (other !== call && !other.explicit && !other.targets.size) calls.delete(id);
    call.targets = next; call.lastActivity = at;
    return call;
  }
  const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const closedSessions = new Map();
  function sessionKey(owner, id, epoch) {
    if (typeof owner !== 'string' || !owner || !sessionId.test(id) || epoch !== 1) throw new ChatError('call_session_invalid');
    return `${owner}|${id}|${epoch}`;
  }
  function rememberClosed(key) {
    closedSessions.set(key, now());
    // UUIDs are not reused. The durable control store retains terminal state beyond this bound.
    while (closedSessions.size > 1024) closedSessions.delete(closedSessions.keys().next().value);
  }
  function assertSession(owner, id, epoch) {
    const key = sessionKey(owner,id,epoch);
    if (closedSessions.has(key)) throw new ChatError('call_ended', 410);
    const c = calls.get(id);
    if (!c || !c.explicit) throw new ChatError('call_session_unknown', 404);
    if (c.owner !== owner || c.epoch !== epoch) throw new ChatError('call_session_forbidden', 403);
    return c;
  }
  function sessionView(c) { return { id:c.id, epoch:c.epoch, status:'active', revision:c.revision, handles:[...c.targets.keys()] }; }
  /**
   * Préavis « NLR t'appelle » : une notice par appelé et par appel, par le chemin des copies d'appel
   * (noticeMain → owner inbox canal « call » ; noticeRoom → notice de room). Une room n'en reçoit
   * qu'une même si la room et son agent sont appelés. Jamais bloquant pour l'ouverture de l'appel.
   */
  const rung = new Set();
  const answered = new Set();
  /**
   * Un échange, un décroché (NLR, 18 nov. 2026 14:47, lot 2). Début de l'échange par interlocuteur :
   * un rappel moins de RING_REPEAT_MS après le précédent continue le même échange.
   */
  const exchanges = new Map();
  const noticedAt = new Map();
  function exchangeSince(handle, at) {
    const prev = exchanges.get(handle);
    const since = prev && at - prev.last <= RING_REPEAT_MS ? prev.since : at;
    exchanges.set(handle, { since, last: at });
    while (exchanges.size > 512) exchanges.delete(exchanges.keys().next().value);
    return since;
  }
  /**
   * L'interlocuteur a-t-il déjà parlé dans son fil depuis `since` ? Le décroché automatique n'est
   * qu'un repli : si Marco (ou l'agent appelé) a déjà décroché lui-même, il ne republie rien.
   * Fil principal : seuls les messages signés « Marco : » comptent (pas les holders ni la Simulation).
   */
  async function spokeSince(target, since) {
    if (target.kind === 'remote') return false;
    const items = await rawItems(target, speakers());
    const own = target.kind === 'main' ? shortLabel(mainLabel)
      : target.kind === 'holder' && !target.room ? target.label
        : target.kind === 'room' && !target.prefix ? shortLabel(target.label) : null;
    return items.some(i => Date.parse(i.at) >= since && !i.text.startsWith(MIRROR_TAG)
      && (!own || (i.speaker === own && (target.kind === 'room' || i.named))));
  }
  function ring(id, targets, caller = 'NLR') {
    const at = now();
    const since = new Map(targets.map(t => [t.handle, exchangeSince(t.handle, at)]));
    for (const target of targets) {
      if (target.kind === 'remote' || !answerCall) continue;
      const key = `${id}:${target.handle}`;
      if (answered.has(key)) continue;
      answered.add(key);
      while (answered.size > 2048) answered.delete(answered.values().next().value);
      const current = calls.get(id);
      const active = () => calls.get(id) === current && current?.targets.has(target.handle)
        && now() - current.lastActivity <= idleMs;
      const spoke = () => spokeSince(target, since.get(target.handle));
      Promise.resolve().then(() => active() && answerCall({ id, target, caller, active, answered: spoke }))
        .catch(error => console.error('Call opening response failed:', error.message));
    }
    const notices = new Map();
    for (const t of targets) {
      if (t.kind === 'remote') continue;
      const key = t.room ? `call-ring:${keySafe(id)}:room${t.room}` : `call-ring:${keySafe(id)}:${keySafe(t.handle)}`;
      if (rung.has(key) || notices.has(key)) continue;
      // Raccroché puis rappelé : le préavis de l'échange en cours suffit (plus de « 📞 » en double).
      const fil = t.room ? `room${t.room}` : t.handle;
      if (at - (noticedAt.get(fil) ?? -Infinity) <= RING_REPEAT_MS) continue;
      noticedAt.set(fil, at);
      while (noticedAt.size > 512) noticedAt.delete(noticedAt.keys().next().value);
      const mention = t.room ? '' : (t.mention ?? '');
      notices.set(key, { channel: t.room ? `room:${t.room}` : 'main', text: mention ? `${mention} ${ringText(id, caller)}` : ringText(id, caller), main: !t.room });
    }
    for (const [key, n] of notices) {
      rung.add(key);
      while (rung.size > 512) rung.delete(rung.values().next().value);
      Promise.resolve().then(() => post(n.channel, key.slice(0, 128), n.text))
        .then(ok => { if (!ok) rung.delete(key); }, () => { rung.delete(key); });
    }
  }
  function openSession(owner,id,epoch,handles,options = {}) {
    const key=sessionKey(owner,id,epoch);
    if(closedSessions.has(key)) throw new ChatError('call_ended',410);
    const targets=parseTargets(handles); const existing=calls.get(id);
    if(existing) return sessionView(assertSession(owner,id,epoch));
    const at=now();
    const c={id,epoch,owner,revision:1,explicit:true,startedAt:at,lastActivity:at,targets:new Map(targets.map(target=>[target.handle,{target,joinedAt:at}])),seen:new Set(),sent:[]};
    c.mirror = options.mirror !== false; c.caller = options.caller ?? 'NLR';
    calls.set(id,c);ring(id,targets.filter(t=>!options.skipRing?.includes(t.handle)),c.caller);return sessionView(c);
  }
  // Only an owner-side phone invitation may transfer an agent-hosted session to its accepting app.
  function adoptAgentSession(id,owner) {
    const c=assertSession(`agent-call:${id}`,id,1);
    rememberClosed(sessionKey(c.owner,id,1));c.owner=owner;c.lastActivity=now();
    return sessionView(c);
  }
  const agentSessionOwned=id=>calls.get(id)?.owner===`agent-call:${id}`;
  function addSession(owner,id,epoch,handles,revision) {
    const c=assertSession(owner,id,epoch);
    if(revision!==c.revision)throw new ChatError('call_revision_conflict',409);
    const targets=parseTargets(handles);
    const next=new Map(c.targets);const at=now();for(const target of targets)if(!next.has(target.handle))next.set(target.handle,{target,joinedAt:at});
    if(next.size>MAX_TARGETS)throw new ChatError('call_target_invalid');
    const added=targets.filter(t=>!c.targets.has(t.handle));
    c.targets=next;ring(id,added,c.caller);c.revision++;c.lastActivity=at;
    forwardTopicPhrase(c,owner,added);
    return sessionView(c);
  }
  /**
   * Agent ajouté après une invitation par sujet : il reçoit la phrase qui l'a appelé, une fois.
   * Holder du fil principal alors que Marco est dans l'appel : la phrase est déjà dans le fil, où
   * son sujet le réveille (pattern-holders.ts) ; rien n'est renvoyé.
   */
  function forwardTopicPhrase(c,owner,added) {
    for (const t of added) {
      const pending = c.topicPending?.get(t.handle);
      if (!pending) continue;
      c.topicPending.delete(t.handle);
      if (now() - pending.at > TOPIC_PENDING_MS) continue;
      if (channelOf(t) === 'main' && [...c.targets.values()].some(v => v.target.kind === 'main')) continue;
      const scope = { owner, id: c.id, epoch: c.epoch, ...(pending.speaker ? { speaker: pending.speaker } : {}) };
      Promise.resolve().then(() => deliver(t.handle, derivedChatId(pending.id, t.handle), pending.text, scope))
        .catch(error => console.error('Topic invite delivery failed:', error.message));
    }
  }
  /**
   * Invitation par un agent (outil MCP invite_to_call, NLR 18 nov. 2026 : « un outil pour tout le
   * monde ») : le serveur ajoute lui-même, avec ses droits, sans session de l'app. Garde minimale :
   * la cible doit exister et ne pas être déjà participante. Annonce d'une ligne dans le fil de chaque
   * participant (qui a invité qui, pourquoi). L'invité reçoit ensuite les phrases de l'humain.
   */
  function inviteSession(id, epoch, handle, { by = '', reason = '' } = {}) {
    const c = calls.get(id);
    if (!c || !c.explicit || c.epoch !== epoch) throw new ChatError('call_session_unknown', 404);
    const target = resolve(handle);
    const joined = [...c.targets.values()].map(v => v.target);
    if (c.targets.has(target.handle) || joined.some(t => t.agentId && t.agentId === target.agentId && t.kind === target.kind))
      return { ...sessionView(c), status: 'already_joined', label: target.label };
    const state = addSession(c.owner, id, epoch, target.handle, c.revision);
    c.agentInvited ??= new Set(); c.agentInvited.add(target.handle);
    const who = String(by).replace(/\s+/g, ' ').trim().slice(0, 80) || 'Un agent';
    const why = String(reason).replace(/\s+/g, ' ').trim().slice(0, 200);
    const text = `${MIRROR_TAG} ➕ ${who} a invité ${target.label} dans l'appel${why ? ` — ${why}` : ''}.`;
    const channels = [...new Set([...c.targets.values()].map(v => channelOf(v.target)))].filter(ch => !ch.startsWith('remote:'));
    for (const channel of channels)
      Promise.resolve().then(() => post(channel, `call-invite:${keySafe(id)}:${keySafe(target.handle)}:${state.revision}:${keySafe(channel)}`.slice(0, 128), text, c))
        .catch(error => console.error('Call invite notice failed:', error.message));
    return { ...state, status: 'added', label: target.label };
  }
  function removeSession(owner,id,epoch,handles,revision) {
    const c=assertSession(owner,id,epoch);
    if(revision!==c.revision)throw new ChatError('call_revision_conflict',409);
    const removals=parseTargets(handles).map(t=>t.handle);
    if(removals.some(handle=>!c.targets.has(handle)))throw new ChatError('call_target_not_joined',409);
    const next=new Map(c.targets);for(const handle of removals)next.delete(handle);
    if(!next.size)return endSession(owner,id,epoch);
    c.targets=next;c.revision++;c.lastActivity=now();return sessionView(c);
  }
  function stateSession(owner,id,epoch) {
    const key=sessionKey(owner,id,epoch);
    if(closedSessions.has(key))return {id,epoch,status:'ended',handles:[]};
    const c=assertSession(owner,id,epoch);c.lastActivity=now();return sessionView(c);
  }
  function endSession(owner,id,epoch) {
    const key=sessionKey(owner,id,epoch);const c=calls.get(id);
    if(c && (!c.explicit || c.owner!==owner || c.epoch!==epoch))throw new ChatError('call_session_forbidden',403);
    rememberClosed(key);if(c){calls.delete(id);remote?.end(c);}return {id,epoch,status:'ended',handles:[]};
  }
  /** Caller authority derives from resolved targets and server-owned owner map, never labels. */
  function identityKeys(handles) {
    const keys=new Set();for(const t of parseTargets(handles)) {
      keys.add(t.handle);if(t.agentId&&HANDLE.test(t.agentId))keys.add(t.agentId);
      if(t.kind==='main'){keys.add('mind');keys.add('marco');}
      if(t.room && t.kind==='room') {keys.add(`room${t.room}`);const owner=owners().get(t.room);if(owner?.handle&&HANDLE.test(owner.handle))keys.add(owner.handle);}
    }return [...keys];
  }
  /** Raccrocher : fin de l'appel de ces participants ; plus aucune copie ensuite. */
  function end(handles) {
    const list = (Array.isArray(handles) ? handles : String(handles ?? '').split(',')).map(h => String(h).trim()).filter(Boolean);
    let ended = 0;
    for (const handle of list) { const c = callOf(handle); if (c) { calls.delete(c.id); ended++; } }
    return { ended };
  }
  const active = () => [...calls.values()].map(c => ({ id: c.id, handles: [...c.targets.keys()] }));
  async function post(channel, key, text, context = null) {
    if (channel.startsWith('remote:')) return remote.post(channel, key, text, context);
    if (channel === 'main') { if (typeof noticeMain !== 'function') return false; await noticeMain(key, text); return true; }
    if (typeof noticeRoom !== 'function') return false;
    await noticeRoom(Number(channel.slice(5)), key, text); return true;
  }
  let ticking = null;
  /** Un passage : fin des appels inactifs, puis copie des nouvelles réponses vers les autres fils. */
  function mirrorTick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const at = now();
      for (const [id, c] of calls) if (at - c.lastActivity > idleMs) {
        if(c.explicit) rememberClosed(sessionKey(c.owner,c.id,c.epoch));calls.delete(id);remote?.end(c);
      }
      const names = speakers();
      for (const c of [...calls.values()]) {
        if (c.mirror === false) continue;
        const channels = [...new Set([...c.targets.values()].map(v => channelOf(v.target)))];
        if (channels.length < 2) continue;
        const fresh = new Map();
        for (const { target, joinedAt } of c.targets.values()) {
          let items; try { items = await rawItems(target, names, c); } catch { continue; }
          if (!c.targets.has(target.handle)) continue;
          const floor = Math.max(c.startedAt, joinedAt);
          for (const item of items)
            if (!c.seen.has(item.id) && Date.parse(item.at) >= floor && item.text.trim() && !item.text.startsWith(MIRROR_TAG))
              fresh.set(item.id, { ...item, channel: channelOf(target), source: target.handle });
        }
        /*
         * Regroupement (NLR, 18 nov. 2026 14:50) : un agent répond en plusieurs messages courts ; les
         * autres agents reçoivent une seule copie par prise de parole. Les morceaux d'un même orateur
         * s'accumulent jusqu'à une accalmie (mirrorQuietMs sans nouveau morceau) ou au plafond
         * d'attente (mirrorMaxWaitMs depuis le premier). L'humain n'est pas concerné : l'app lit les
         * réponses dans le fil de l'interlocuteur (replies/speech), sans attendre ces copies.
         */
        c.groups ??= new Map(); c.outbox ??= [];
        const seenAt = now();
        const freeze = (groupKey, group) => {
          c.groups.delete(groupKey);
          c.outbox.push({ ...group, dests: new Set(channels.filter(ch => ch !== group.channel)),
            text: mirrorOf(group.speaker, group.items.map(i => i.text)) });
        };
        for (const item of [...fresh.values()].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) {
          c.seen.add(item.id);
          const groupKey = `${item.source}|${item.channel}|${item.speaker}`;
          const open = c.groups.get(groupKey);
          // Un groupe trop long part tel quel ; le morceau suivant en ouvre un autre (pas de coupe).
          if (open && open.items.reduce((n, i) => n + i.text.trim().length + 2, item.text.trim().length) > MIRROR_MAX_CHARS)
            freeze(groupKey, open);
          const group = c.groups.get(groupKey) ?? { source: item.source, channel: item.channel, speaker: item.speaker, items: [], first: seenAt, last: seenAt };
          group.items.push({ id: item.id, text: item.text }); group.last = seenAt;
          c.groups.set(groupKey, group);
        }
        for (const [groupKey, group] of [...c.groups].sort(([, x], [, y]) => x.first - y.first))
          if (seenAt - group.last >= mirrorQuietMs || seenAt - group.first >= mirrorMaxWaitMs) freeze(groupKey, group);
        // Envoi dans l'ordre ; une copie figée garde son texte et sa clé jusqu'à remise à chaque fil.
        for (const entry of [...c.outbox]) {
          if (!calls.has(c.id)) break; // Raccroché pendant le passage : plus aucune copie.
          if (!c.targets.has(entry.source)) { c.outbox.splice(c.outbox.indexOf(entry), 1); continue; }
          let capped = false;
          for (const dest of [...entry.dests]) {
            if (!calls.has(c.id)) break;
            if (![...c.targets.values()].some(v => channelOf(v.target) === dest)) { entry.dests.delete(dest); continue; }
            c.sent = c.sent.filter(t => now() - t < 60_000);
            // Plafond par appel : au-delà, la copie attend un passage suivant.
            if (c.sent.length + 1 > mirrorPerMinute) { capped = true; break; }
            // Clé d'idempotence par groupe et par fil : un nouveau passage ou un redémarrage ne double
            // rien (un groupe d'un seul morceau garde la clé d'avant le regroupement).
            const key = `call-mirror:${keySafe(c.id)}:${createHash('sha256').update(`${entry.items.map(i => i.id).join(',')}|${dest}`).digest('hex')}`;
            try { if (await post(dest, key, entry.text, c)) { c.sent.push(now()); entry.dests.delete(dest); } } catch { /* Nouvel essai au passage suivant. */ }
          }
          if (!entry.dests.size) c.outbox.splice(c.outbox.indexOf(entry), 1);
          if (capped) break;
        }
      }
    })().finally(() => { ticking = null; });
    return ticking;
  }
  const timer = mirrorIntervalMs > 0 ? setInterval(() => { mirrorTick().catch(() => {}); }, mirrorIntervalMs) : null;
  timer?.unref?.();
  const stop = () => { if (timer) clearInterval(timer); calls.clear(); };

  const cache = new Map();
  let queue = Promise.resolve();
  /** Voix d'une réponse retrouvée dans le fil de l'interlocuteur ; synthèses en série, mises en cache. */
  async function speech(handle, itemId, announce = false, scope = null) {
    const target = resolve(handle);
    if (target.kind === 'remote') {
      if(!scope)throw new ChatError('call_session_required');
      const c=assertSession(scope.owner,scope.id,scope.epoch);
      if(!c.targets.has(handle))throw new ChatError('call_target_not_joined',403);
      return remote.speech(target, itemId, announce, c);
    }
    if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new ChatError('invalid_request');
    const key = `${handle}|${itemId}|${announce ? 1 : 0}`;
    if (cache.has(key)) return cache.get(key);
    const item = (await replies(handle, new Date(0).toISOString())).find(value => value.id === itemId);
    if (!item) throw new ChatError('call_reply_unknown', 404);
    const run = queue.then(async () => {
      // La transcription de NLR passe avant la voix : la synthèse attend qu'elle soit finie (60 s au plus).
      for (let waited = 0; waited < 60_000 && transcribing(); waited += 150) await new Promise(r => setTimeout(r, 150));
      const started = now();
      // Nom annoncé brièvement au début d'une réponse quand plusieurs voix se succèdent.
      const result = await speak(announce && item.first && item.speaker ? `${item.speaker.replace(/^\p{Extended_Pictographic}[️‍]*\s*/u, '')}. ${item.text}` : item.text, item.voice);
      if (!result?.bytes?.length) throw new ChatError('nothing_to_speak', 422);
      return { ...result, ms: now() - started };
    });
    queue = run.catch(() => {});
    cache.set(key, run);
    run.catch(() => cache.delete(key));
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return run;
  }
  /** Le serveur HTTP branche ici son état « transcription en cours ». */
  const setTranscribing = fn => { if (typeof fn === 'function') transcribing = fn; };
  // Federation reads only the lifetime of an explicitly authorized call, never a whole thread.
  async function sessionItems(owner, id, epoch, handle) {
    const c = assertSession(owner,id,epoch), joined = c.targets.get(handle);
    if (!joined) throw new ChatError('call_target_not_joined',403);
    const items = await rawItems(joined.target, speakers(), c);
    assertSession(owner,id,epoch);
    if (!c.targets.has(handle)) throw new ChatError('call_target_not_joined',403);
    return items.filter(item => Date.parse(item.at) >= c.targets.get(handle).joinedAt && !item.text.startsWith(MIRROR_TAG)).slice(-100);
  }
  async function sessionNotice(owner,id,epoch,handle,key,text) {
    const c=assertSession(owner,id,epoch), joined=c.targets.get(handle);
    if(!joined)throw new ChatError('call_target_not_joined',403);
    return post(channelOf(joined.target),key,text,c);
  }
  const syncRemote = scope => remote?.sync(assertSession(scope.owner,scope.id,scope.epoch));
  /** Après une invitation par un agent : pairs distants resynchronisés sans la session de l'app. */
  const syncInvited = id => { const c = calls.get(id); return c?.explicit ? remote?.sync(c) : undefined; };
  return { targets, resolve, parseTargets, deliver, replies, speech, setTranscribing, openSession, adoptAgentSession, agentSessionOwned, addSession, inviteSession, removeSession, stateSession, endSession, assertSession, identityKeys, end, active, mirrorTick, stop,
    attachRemote: value => { remote=value; }, syncRemote, syncInvited, sessionItems, sessionNotice, channelOf };
}

/** Type audio d'après les octets : WAV (voix locale) ou MP3 (ElevenLabs), OGG en dernier recours. */
export function audioMime(bytes) {
  const head = bytes.subarray(0, 4).toString('latin1');
  if (head === 'RIFF') return 'audio/wav';
  if (head === 'OggS') return 'audio/ogg';
  if (head.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return 'application/octet-stream';
}
