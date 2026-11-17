import { call, ChatClientError, type ChatSession } from './client.ts';

/** Sonnerie (NLR, 16 nov. 2026, 21:46) : une question d'agent ou un rappel promis fait sonner le téléphone. */
export type RingEvent = { id: string; kind: 'question' | 'callback'; messageId: string; at: string; handle: string; label: string;
  question: string; scheduledAt?: string };
export type ScheduledRing = { id: string; handle: string; label: string; reason: string; dueAt: string };
export const RING_CHANNEL = 'appel-agent';
const HANDLE = /^[a-z0-9][a-z0-9_.-]{0,60}$/;

export function parseRing(value: unknown): { events: RingEvent[]; scheduled: ScheduledRing[]; observedAt: string } {
  const input = value as { schema?: unknown; events?: unknown; scheduled?: unknown; observedAt?: unknown } | null;
  if (input?.schema !== 'mind.chat.ring.v1' || !Array.isArray(input.events) || typeof input.observedAt !== 'string'
    || !Number.isFinite(Date.parse(input.observedAt))) throw new ChatClientError('invalid_response');
  const events = (input.events as RingEvent[]).filter(e => typeof e?.id === 'string' && HANDLE.test(String(e.handle))
    && typeof e.label === 'string' && typeof e.question === 'string' && Number.isFinite(Date.parse(e.at)));
  const scheduled = Array.isArray(input.scheduled) ? (input.scheduled as ScheduledRing[]).filter(s => typeof s?.id === 'string'
    && HANDLE.test(String(s.handle)) && Number.isFinite(Date.parse(s.dueAt))) : [];
  return { events, scheduled, observedAt: input.observedAt };
}

export async function readRing(session: ChatSession, since: string, signal?: AbortSignal) {
  return parseRing(await call(session.url, `/chat/ring?since=${encodeURIComponent(since)}`,
    { headers: { Authorization: `Bearer ${session.token}` }, signal }));
}

/** Titre et corps de la notification : « <agent> t'appelle », la question en corps. */
export function ringNotice(event: RingEvent) {
  const name = event.label.trim() || 'Un agent';
  return { title: `${name} t'appelle`, body: event.kind === 'callback' ? `Rappel promis : ${event.question}` : event.question };
}

/**
 * Curseur de sonnerie : premier passage à l'heure courante (pas de sonnerie pour l'historique),
 * puis chaque événement une seule fois ; le curseur avance à l'événement le plus récent vu.
 */
export function createRingTracker(start = new Date().toISOString()) {
  let since = start; const seen = new Set<string>();
  return {
    since: () => since,
    accept(events: RingEvent[]): RingEvent[] {
      const fresh = events.filter(e => !seen.has(e.id));
      for (const e of events) { seen.add(e.id); if (e.at > since) since = e.at; }
      if (seen.size > 500) for (const id of [...seen].slice(0, seen.size - 500)) seen.delete(id);
      return fresh;
    },
  };
}
