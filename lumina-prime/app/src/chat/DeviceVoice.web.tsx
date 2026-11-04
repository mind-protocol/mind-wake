import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { colors, styles as s } from '../ui/theme';
import { createLocalSpeech, type LocalSpeechConstructor, type LocalSpeechState } from './local-speech.ts';
import { createWasmSpeech } from './wasm-speech.web';
import { createVoiceIntent, subscribeCaptureSpeaking } from './voice-intent.ts';

export default function DeviceVoice({ onTranscript, isSpeaking=false }: { onTranscript:(text:string)=>void;isSpeaking?:boolean }) {
  const pathname=usePathname(); const router=useRouter();
  const [state,setState]=useState<LocalSpeechState>({phase:'idle',message:'Micro local · 30 s enchaînées'});
  const control=useRef<ReturnType<typeof createVoiceIntent>|null>(null);
  const speaking=useRef(isSpeaking);
  const transcript=useRef(onTranscript);
  useEffect(()=>{transcript.current=onTranscript;},[onTranscript]);
  useEffect(()=>{
    const browser=globalThis as typeof globalThis & {SpeechRecognition?:LocalSpeechConstructor;webkitSpeechRecognition?:LocalSpeechConstructor};
    // Older prefixed engines are accepted only when the instance exposes processLocally.
    const Constructor=browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    const shared={visible:()=>!document.hidden&&!speaking.current,onState:setState,onTranscript:(text:string)=>transcript.current(text)};
    const instance=Constructor?.available?createLocalSpeech({...shared,constructor:Constructor,secure:globalThis.isSecureContext}):createWasmSpeech(shared);
    const intent=createVoiceIntent(instance);control.current=intent; let disposed=false;
    const unsubscribe=subscribeCaptureSpeaking(value=>{speaking.current=value;intent.setSpeaking(value);});
    const hidden=()=>{if(document.hidden)intent.hidden();else intent.visible();};
    document.addEventListener('visibilitychange',hidden);
    // Permission already granted: honour requested default ON. No permission dialog on mount.
    void navigator.permissions?.query({name:'microphone' as PermissionName}).then(permission=>{
      if(!disposed && permission.state==='granted')void intent.start();
    }).catch(()=>{});
    return()=>{disposed=true;unsubscribe();document.removeEventListener('visibilitychange',hidden);control.current=null;instance.dispose();};
  },[]);
  useEffect(()=>{speaking.current=isSpeaking;control.current?.setSpeaking(isSpeaking);},[isSpeaking]);
  const running=state.phase==='recording'||state.phase==='checking';
  return <View style={{borderTopWidth:1,borderColor:colors.line,backgroundColor:colors.paper,paddingHorizontal:10,paddingVertical:3,gap:2}}>
    <View style={{flexDirection:'row',gap:8,alignItems:'center'}}>
      <Pressable accessibilityRole="button" accessibilityLabel={running?'Mettre le micro en pause':'Activer le micro local, tranches de 30 secondes'}
        onPress={()=>running?control.current?.pause():void control.current?.start(state.phase==='download')}
        style={{minHeight:44,minWidth:100,paddingHorizontal:12,borderRadius:14,backgroundColor:running?colors.green:colors.soft,justifyContent:'center',alignItems:'center'}}>
        <Text style={s.strong}>{running?'■ Pause micro':state.phase==='download'?'Télécharger le français':'● Micro ON'}</Text>
      </Pressable>
      {pathname!=='/chat'?<Pressable accessibilityRole="button" onPress={()=>router.push('/chat')} style={{minHeight:44,justifyContent:'center'}}><Text style={s.strong}>Ouvrir le chat</Text></Pressable>:null}
      <Text accessibilityLiveRegion="polite" numberOfLines={2} style={[s.small,{flex:1}]}>{state.message}</Text>
    </View>
    {state.phase==='recording'?<Text style={[s.small,{fontSize:10}]}>Chaque transcription rejoint le brouillon. Envoi avec « Envoyer ».</Text>:null}
  </View>;
}
