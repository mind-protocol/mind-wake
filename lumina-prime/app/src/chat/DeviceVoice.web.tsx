import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { styles as s, colors } from '../ui/theme';
import { beginWebRecording } from './VoiceInput.web';
import { createDesktopCapture } from './desktop-capture.ts';
import { createVoiceIntent, subscribeCaptureSpeaking } from './voice-intent.ts';
import { transcribeChatVoice, chatErrorMessage, ChatClientError, type ChatSession } from './client.ts';
import { voiceErrorMessage, type VoiceState } from './voice-controller.ts';
export default function DeviceVoice({session,onTranscript}:{session:ChatSession;onTranscript:(text:string)=>void;isSpeaking?:boolean}) {
  const latest=useRef({session,onTranscript});
  useEffect(()=>{latest.current={session,onTranscript};},[session,onTranscript]);
  const [state,setState]=useState<VoiceState>({phase:'idle',message:null});
  const control=useRef<ReturnType<typeof createVoiceIntent>|null>(null);
  useEffect(()=>{
    const capture=createDesktopCapture({begin:beginWebRecording,
      transcribe:(clip,signal)=>transcribeChatVoice(latest.current.session,clip.audio,clip.mime,signal),
      onTranscript:text=>latest.current.onTranscript(text),onState:setState,
      describeError:error=>error instanceof ChatClientError?chatErrorMessage(error):voiceErrorMessage(error)});
    const intent=createVoiceIntent(capture);control.current=intent;
    const unsubscribe=subscribeCaptureSpeaking(value=>intent.setSpeaking(value));
    const visibility=()=>{if(document.hidden)intent.hidden();else intent.visible();};
    document.addEventListener('visibilitychange',visibility);
    return()=>{unsubscribe();document.removeEventListener('visibilitychange',visibility);control.current=null;capture.dispose();};
  },[]);
  const running=state.phase!=='idle';
  return <View style={{backgroundColor:colors.paper,paddingHorizontal:10,paddingVertical:4,gap:4}}>
    <Pressable accessibilityRole="button" accessibilityLabel={running?'Pause micro':'Activer le micro'}
      onPress={()=>running?control.current?.pause():void control.current?.start()}
      style={{minHeight:44,padding:10,borderRadius:14,backgroundColor:running?colors.green:colors.soft}}>
      <Text style={s.strong}>{running?'■ Pause micro':'● Parler à Marco'}</Text>
    </Pressable>
    <Text accessibilityLiveRegion="polite" style={s.small}>{state.phase==='recording'?'Je t’écoute…':state.phase==='transcribing'?'Transcription…':state.phase==='requesting'?'Autorisation du micro…':state.message??''}</Text>
  </View>;
}
