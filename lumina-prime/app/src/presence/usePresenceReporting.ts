import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import type { ChatSession } from '../chat/client';
import type { MobilePresence } from './model';
import { reportMobilePresence } from './report';
export function usePresenceReporting(session: ChatSession | null | undefined, connected: boolean,
  presence: MobilePresence, voiceEnabled: boolean, voiceReady: boolean) {
  const [reported, setReported] = useState(false);
  useEffect(() => {
    if (!session || !connected) return;
    const controller = new AbortController(); let active = true;
    const publish = async () => {
      const ok = await reportMobilePresence(session, presence, { enabled: voiceEnabled, ready: voiceReady },
        Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web', controller.signal);
      if (active) setReported(ok);
    };
    void publish(); const timer = setInterval(() => { void publish(); }, 15000);
    return () => { active = false; clearInterval(timer); controller.abort(); };
  }, [session, connected, presence, voiceEnabled, voiceReady]);
  return !!session && connected && reported;
}
