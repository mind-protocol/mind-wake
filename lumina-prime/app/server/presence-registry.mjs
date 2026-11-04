export class PresenceError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
/** Client app state, not Android usage access or device-wide activity. Session ownership stays with chat auth. */
export function createPresenceRegistry({ now = Date.now, ttlMs = 45000 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 120000) throw Error('Bounded presence TTL required');
  const entries = new Map();
  const validKey = key => { if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new PresenceError('unauthorized', 401); };
  return {
    update(sessionKey, input) {
      validKey(sessionKey);
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['schema', 'window', 'lastInteractionAt', 'voiceEnabled', 'voiceReady', 'platform'].includes(key))
        || input.schema !== 'mind.mobile.presence.v1' || !['foreground', 'background', 'unknown'].includes(input.window)
        || typeof input.voiceEnabled !== 'boolean' || typeof input.voiceReady !== 'boolean'
        || !['web', 'android', 'ios'].includes(input.platform)
        || (input.lastInteractionAt !== null && (!Number.isFinite(input.lastInteractionAt) || input.lastInteractionAt < 0 || input.lastInteractionAt > now() + 60000)))
        throw new PresenceError('invalid_presence');
      entries.set(sessionKey, { ...input, receivedAt: now() });
      return this.read(sessionKey);
    },
    read(sessionKey) {
      validKey(sessionKey); const report = entries.get(sessionKey); const fresh = !!report && now() - report.receivedAt <= ttlMs;
      return { schema: 'mind.mobile.presence.receipt.v1', fresh, window: fresh ? report.window : 'unknown',
        lastInteractionAt: fresh ? report.lastInteractionAt : null, voiceEnabled: fresh ? report.voiceEnabled : false,
        voiceReady: fresh ? report.voiceReady : false, platform: report?.platform ?? null,
        receivedAt: report ? new Date(report.receivedAt).toISOString() : null,
        expiresAt: report ? new Date(report.receivedAt + ttlMs).toISOString() : null, source: 'authenticated_app_report', deviceWideActivity: false };
    },
    routeHint(sessionKey) {
      const report = this.read(sessionKey);
      return { text: report.fresh && report.window === 'foreground' ? 'mobile' : 'owner-default',
        voice: report.fresh && report.window === 'background' && report.voiceEnabled
          ? report.platform !== 'web' && report.voiceReady ? 'mobile-tts-if-running' : 'fallback-not-configured' : 'none',
        presence: report.window, deviceWideActivity: false, delivered: false };
    },
    remove(sessionKey) { validKey(sessionKey); entries.delete(sessionKey); },
  };
}
