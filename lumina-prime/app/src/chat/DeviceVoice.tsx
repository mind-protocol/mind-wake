import React from 'react';
import { Text, View } from 'react-native';
import { styles as s } from '../ui/theme';
/** Expo Go does not provide a proven on-device French ASR engine. Never upload audio to the PC implicitly. */
export default function DeviceVoice(_props:{onTranscript:(text:string)=>void;isSpeaking?:boolean}) {
  return <View style={{padding:8}}><Text style={s.small}>Micro local natif à raccorder. Aucun audio envoyé au PC. Le chat texte reste disponible.</Text></View>;
}
