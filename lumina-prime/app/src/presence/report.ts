import { chatUrl, type ChatSession } from '../chat/client.ts';
import type { MobilePresence } from './model.ts';
export async function reportMobilePresence(session: ChatSession, presence: MobilePresence,
  voice: { enabled: boolean; ready: boolean }, platform: 'web' | 'android' | 'ios', signal?: AbortSignal, fetchImpl = fetch) {
  const controller = new AbortController(); const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 4000);
  try {
    const response = await fetchImpl(`${chatUrl(session.url)}/chat/presence`, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema: 'mind.mobile.presence.v1', window: presence.window, lastInteractionAt: presence.lastInteractionAt,
        voiceEnabled: voice.enabled, voiceReady: voice.ready, platform }) });
    if (!response.ok) return false;
    const receipt = await response.json() as { schema?: string; deviceWideActivity?: boolean };
    return receipt.schema === 'mind.mobile.presence.receipt.v1' && receipt.deviceWideActivity === false;
  } catch { return false; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
