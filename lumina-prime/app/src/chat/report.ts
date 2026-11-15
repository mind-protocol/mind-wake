import { call, ChatClientError, type ChatMessage, type ChatSession } from './client.ts';
export const reportReasons = { offensive: 'Contenu offensant', dangerous: 'Contenu dangereux', privacy: 'Vie privée', other: 'Autre' };
export type ChatReport = { id: string; messageId: string; version: number; text: string; reason: keyof typeof reportReasons; comment: string };
export function draftReport(message: ChatMessage, id: string): ChatReport {
  if (message.role !== 'agent' || message.status !== 'published')
    throw new ChatClientError('invalid_report');
  return { id, messageId: message.id, version: message.version, text: message.text.slice(0, 12000), reason: 'offensive', comment: '' };
}
export async function sendReport(session: ChatSession, input: ChatReport, fetchImpl = fetch) {
  // Explicit projection: no conversation, provider identity, voice or capture data.
  const { id, messageId, version, text, reason, comment } = input;
  const value = await call(session.url, '/chat/reports', { method: 'POST', headers: {
    Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, messageId, version, text, reason, comment }) }, fetchImpl) as Record<string, unknown>;
  if (value?.schema !== 'mind.chat.report.receipt.v1' || value.id !== id || value.status !== 'stored_local'
    || value.destination !== 'paired_wake_local_inbox' || typeof value.duplicate !== 'boolean'
    || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new ChatClientError('invalid_response');
  return value;
}
export function reportError(error: unknown) {
  const code = error instanceof ChatClientError ? error.code : '';
  return ({ unauthorized: 'Session expirée : reconnecte cet appareil avant de réessayer.',
    body_too_large: 'Signalement refusé : la requête dépasse la limite de réception.',
    invalid_report: 'Signalement refusé : données invalides ou limites dépassées.',
    reports_unavailable: 'La réception des signalements n’est pas configurée sur ce Wake.',
    report_message_changed: 'Cette réponse a changé ou quitté le fil. Ferme puis sélectionne sa version actuelle.',
    report_conflict: 'Cet identifiant correspond déjà à un autre signalement.',
    report_limit: 'La boîte locale est pleine. Son opérateur doit la traiter.' } as Record<string, string>)[code]
    ?? 'Réception non confirmée. Réessaie le même signalement pour éviter un doublon.';
}
