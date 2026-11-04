import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { MobilePresence, MobileWindow } from './model';
export function useMobilePresence() {
  const [presence, setPresence] = useState<MobilePresence>(() => ({ window: 'unknown', lastInteractionAt: null, changedAt: Date.now() }));
  useEffect(() => {
    const update = (window: MobileWindow) => setPresence(previous => ({ ...previous, window, changedAt: Date.now() }));
    const interaction = () => setPresence(previous => ({ ...previous, lastInteractionAt: Date.now() }));
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const visible = () => update(document.visibilityState === 'visible' ? 'foreground' : 'background');
      visible(); document.addEventListener('visibilitychange', visible);
      document.addEventListener('pointerdown', interaction, { passive: true }); document.addEventListener('keydown', interaction);
      return () => { document.removeEventListener('visibilitychange', visible); document.removeEventListener('pointerdown', interaction); document.removeEventListener('keydown', interaction); };
    }
    update(AppState.currentState === 'active' ? 'foreground' : AppState.currentState ? 'background' : 'unknown');
    const change = AppState.addEventListener('change', state => update(state === 'active' ? 'foreground' : 'background'));
    const focus = AppState.addEventListener('focus', () => update('foreground'));
    const blur = AppState.addEventListener('blur', () => update('background'));
    return () => { change.remove(); focus.remove(); blur.remove(); };
  }, []);
  return presence;
}
