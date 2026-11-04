export type MobileWindow = 'foreground' | 'background' | 'unknown';
export type MobilePresence = { window: MobileWindow; lastInteractionAt: number | null; changedAt: number };
export type PublishedReply = { id: string; text: string; role: 'agent' | 'human'; status: string };
export function voiceText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' [Extrait de code disponible dans le message.] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'lien disponible dans le message').replace(/[#*_`]/g, '').trim().slice(0, 1800);
}
/** Baseline avoids reading the entire restored history. Revisions do not repeat a reply. */
export class ReplyVoiceCursor {
  private ids = new Set<string>(); private initialized = false;
  reset(messages: readonly PublishedReply[], historyReady: boolean) { this.ids = new Set(messages.map(message => message.id)); this.initialized = historyReady; }
  take(messages: readonly PublishedReply[], historyReady: boolean): PublishedReply[] {
    if (!historyReady) return [];
    if (!this.initialized) { this.reset(messages, true); return []; }
    const fresh = messages.filter(message => !this.ids.has(message.id) && message.role === 'agent' && message.status === 'published');
    messages.forEach(message => this.ids.add(message.id)); return fresh;
  }
}
