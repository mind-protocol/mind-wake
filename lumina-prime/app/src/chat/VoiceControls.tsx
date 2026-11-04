import React from 'react';
import { Text, View } from 'react-native';
import { Button } from '../ui/Primitives';
import { styles as s } from '../ui/theme';
import type { VoiceState } from './voice-controller.ts';
export function VoiceControls({ state, start, finish, cancel }: { state: VoiceState; start: () => void; finish: () => void; cancel: () => void }) {
  return <View style={{ gap: 8 }}>
    {state.phase === 'idle' ? <Button secondary title="Parler" icon="mic-outline" onPress={start} /> : <>
      <Text accessibilityLiveRegion="polite" style={s.small}>{state.phase === 'requesting' ? 'Autorisation du micro…' : state.phase === 'recording' ? 'Enregistrement · 60 secondes maximum' : 'Transcription locale…'}</Text>
      <View style={s.row}>{state.phase === 'recording' ? <View style={s.grow}><Button title="Terminer et transcrire" onPress={finish} /></View> : null}
        <View style={s.grow}><Button secondary title="Annuler" onPress={cancel} /></View></View>
    </>}
    {state.message ? <Text accessibilityLiveRegion="polite" style={s.small}>{state.message}</Text> : null}
  </View>;
}
