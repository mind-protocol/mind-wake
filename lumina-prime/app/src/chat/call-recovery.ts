export const CALL_RECOVERY_KEY = 'mind.wake.desktop-call.recovery.v1';
export const CALL_RECOVERY_MAX_AGE_MS = 10 * 60_000;
export type CallRecovery = { handles: string[]; muted: boolean; inviteHumans: boolean; callId: string; at: number };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function callRecovery(store: Store, now = Date.now) {
  const clear = () => { try { store.removeItem(CALL_RECOVERY_KEY); } catch { /* Storage unavailable. */ } };
  return {
    clear,
    save(value: Omit<CallRecovery, 'at'>) {
      try { store.setItem(CALL_RECOVERY_KEY, JSON.stringify({ ...value, at: now() })); } catch { /* Best effort on crash. */ }
    },
    load(): CallRecovery | null {
      try {
        const value = JSON.parse(store.getItem(CALL_RECOVERY_KEY) ?? 'null');
        if (!value || !Array.isArray(value.handles) || !value.handles.length || value.handles.length > 8
          || !value.handles.every((h: unknown) => typeof h === 'string' && /^[a-z0-9][a-z0-9_.-]{0,60}$/.test(h))
          || typeof value.muted !== 'boolean' || typeof value.inviteHumans !== 'boolean'
          || typeof value.callId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.callId)
          || !Number.isFinite(value.at) || value.at > now() || now() - value.at > CALL_RECOVERY_MAX_AGE_MS) {
          clear(); return null;
        }
        return value;
      } catch { clear(); return null; }
    },
  };
}
