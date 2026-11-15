import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View, Platform } from 'react-native';
import { Button } from '../ui/Primitives';
import { styles as s } from '../ui/theme';
import { createSpeechEngine } from './speech-engine';
import { ReplyVoiceCursor, voiceText, type PublishedReply } from './model';
import { useMobilePresence } from './useMobilePresence';
import type { ChatSession } from '../chat/client';
import { usePresenceReporting } from './usePresenceReporting';

export function VoiceReplies({ messages, connected, session, onSpeakingChange, onEnabledChange }: { messages: readonly PublishedReply[]; connected: boolean; session?: ChatSession | null; onSpeakingChange?: (speaking: boolean) => void; onEnabledChange?: (enabled:boolean)=>void }) {
  const engine = useMemo(() => createSpeechEngine(), []); const cursor = useRef(new ReplyVoiceCursor());
  const presence = useMobilePresence(); const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('La voix est désactivée.');
  usePresenceReporting(session, connected, presence, enabled, engine.available());
  const last = messages.filter(message => message.role === 'agent' && message.status === 'published').at(-1);
  const speak = (text: string) => {
    onSpeakingChange?.(true);
    engine.speak(voiceText(text), { start: () => setStatus('Lecture en cours.'), done: () => { onSpeakingChange?.(false); setStatus('Lecture terminée par le système.'); },
      error: value => { onSpeakingChange?.(false); setStatus(value); setEnabled(false); onEnabledChange?.(false); } });
  };
  useEffect(() => {
    const fresh = cursor.current.take(messages, connected);
    if (enabled && fresh.length) speak(fresh.map(reply=>reply.text).join('\n'));
    // Only a new snapshot consumes replies. Presence changes never replay old history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, connected]);
  useEffect(() => () => { engine.stop(); onSpeakingChange?.(false); }, [engine, onSpeakingChange]);
  function enable() {
    cursor.current.reset(messages, connected); setEnabled(true); onEnabledChange?.(true);
    // This call stays in the physical button gesture on web; no autoplay on mount.
    speak('Bonjour, c’est Marco. Ceci est le test vocal de MIND sur votre téléphone.');
  }
  function stop() { engine.stop(); onSpeakingChange?.(false); setEnabled(false); onEnabledChange?.(false); setStatus('La voix est désactivée.'); }
  return <View style={{ gap: 8 }}>
    <Text style={s.small}>Voix des réponses Wake · {presence.window === 'foreground' ? 'application au premier plan' : presence.window === 'background' ? 'application en arrière-plan' : 'présence inconnue'}</Text>
    <View style={s.row}><View style={s.grow}><Button secondary title={enabled ? 'Réessayer la voix' : 'Activer la conversation vocale'} icon="volume-high-outline" onPress={enable} /></View>
      {enabled ? <View style={s.grow}><Button secondary title="Couper la voix" onPress={stop} /></View> : null}</View>
    {last ? <Button secondary title="Écouter la dernière réponse" onPress={() => speak(last.text)} /> : null}
    <Text accessibilityLiveRegion="polite" style={s.small}>{status}</Text>
    {enabled ? <Text style={s.small}>{Platform.OS === 'web' ? 'Les nouvelles réponses sont lues au premier plan. En arrière-plan, le navigateur peut suspendre la voix.' : 'Les nouvelles réponses sont lues tant que le système laisse l’app fonctionner.'}</Text> : null}
  </View>;
}
