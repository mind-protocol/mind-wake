import React from 'react';
/** Expo Go does not provide a proven on-device French ASR engine. Never upload audio to the PC implicitly. */
export default function DeviceVoice(_props:{session:import('./client').ChatSession;onTranscript:(text:string)=>void;isSpeaking?:boolean}) {
  return null;
}
