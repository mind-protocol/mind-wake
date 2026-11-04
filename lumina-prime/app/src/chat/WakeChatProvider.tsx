import React, { createContext, useContext, useEffect, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { ChatClientError, chatErrorMessage, logoutChat, pairChat, readChat, sendChat, type ChatMessage, type ChatSession } from './client.ts';
import { clearChatSession, loadChatSession, saveChatSession } from './storage.ts';
import DeviceVoice from './DeviceVoice';
import { Pressable, Text, View } from 'react-native';
import { VoiceReplies } from '../presence/VoiceReplies';
import { colors, styles as s } from '../ui/theme';
import { setCaptureSpeaking } from './voice-intent.ts';
export type WakeChatContextValue = {
 url: string; setUrl: (value:string)=>void; code:string; setCode:(value:string)=>void;
 session:ChatSession|null; pairing:boolean; error:string|null; messages:ChatMessage[];
 text:string; setText:React.Dispatch<React.SetStateAction<string>>; outgoing:Outgoing[];
 online:boolean; restoring:boolean; pair:()=>Promise<void>; submit:(item:Outgoing)=>Promise<void>;
 disconnect:()=>Promise<void>; sendDraft:()=>void;
};
const Context = createContext<WakeChatContextValue|null>(null);
export function useWakeChat() { const value=useContext(Context); if(!value) throw new Error('WakeChatProvider missing'); return value; }
type Outgoing = { id: string; text: string; state: 'sending' | 'queued' | 'failed'; error?: string };
export function WakeChatProvider({ children }: { children: React.ReactNode }) {
  const [url, setUrl] = useState(process.env.EXPO_PUBLIC_MIND_CHAT_URL ?? 'http://127.0.0.1:8789');
  const [code, setCode] = useState(''); const [session, setSession] = useState<ChatSession | null>(null);
  const [pairing, setPairing] = useState(false); const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]); const [text, setText] = useState('');
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]); const [online, setOnline] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [voiceOptions,setVoiceOptions]=useState(false);

  useEffect(() => { let active = true; void loadChatSession().then(value => {
    if (active) { setSession(value); setRestoring(false); }
  }); return () => { active = false; }; }, []);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true; let cursor = ''; let backoff = 1000;
    const listen = async () => {
      try {
        const snapshot = await readChat(session, cursor, controller.signal);
        if (!active) return;
        cursor = snapshot.cursor; backoff = 1000; setOnline(true); setError(null); setMessages(snapshot.messages);
        setOutgoing(previous => previous.filter(item => !snapshot.messages.some(message => message.id === item.id)));
        timer = setTimeout(() => { void listen(); }, 0);
      } catch (reason) {
        if (!active) return;
        setOnline(false); setError(chatErrorMessage(reason));
        if (reason instanceof ChatClientError && reason.status === 401) {
          void clearChatSession(); setSession(null); return;
        }
        timer = setTimeout(() => { void listen(); }, backoff); backoff = Math.min(backoff * 2, 8000);
      }
    };
    void listen(); return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [session]);
  async function pair() {
    setPairing(true); setError(null);
    try { const value = await pairChat(url, code); await saveChatSession(value); setCode(''); setSession(value); }
    catch (reason) { setError(chatErrorMessage(reason)); }
    finally { setPairing(false); }
  }
  async function submit(item: Outgoing) {
    if (!session) return;
    setOutgoing(previous => [...previous.filter(value => value.id !== item.id), { ...item, state: 'sending' }]);
    try {
      await sendChat(session, item.id, item.text);
      setOutgoing(previous => previous.map(value => value.id === item.id ? { ...value, state: 'queued', error: undefined } : value));
    } catch (reason) { setOutgoing(previous => previous.map(value => value.id === item.id
      ? { ...value, state: 'failed', error: chatErrorMessage(reason) } : value)); }
  }
  async function disconnect() {
    if (session) { try { await logoutChat(session); } catch { setError('Déconnexion locale faite. La révocation serveur reste à confirmer ; le jeton expirera automatiquement.'); } }
    await clearChatSession(); setSession(null); setMessages([]); setOutgoing([]); setOnline(false);
  }
  function sendDraft() {
    if (!text.trim() || text.length > 4000 || !session) return;
    const item: Outgoing = { id: `chat-${Crypto.randomUUID()}`, text: text.trim(), state: 'sending' };
    setText(''); void submit(item);
  }
  return <Context.Provider value={{url,setUrl,code,setCode,session,pairing,error,messages,text,setText,outgoing,online,restoring,pair,submit,disconnect,sendDraft}}>
    {children}
    {session ? <>
      <DeviceVoice onTranscript={value=>setText(previous=>[previous.trim(),value].filter(Boolean).join('\n'))} />
      <View style={{backgroundColor:colors.paper,paddingHorizontal:10}}>
        <Pressable accessibilityRole="button" accessibilityState={{expanded:voiceOptions}} onPress={()=>setVoiceOptions(value=>!value)}
          style={{minHeight:44,justifyContent:'center'}}><Text style={s.small}>{voiceOptions?'Masquer les options voix ▴':'Voix des réponses / Essayer ▾'}</Text></Pressable>
        <View style={{display:voiceOptions?'flex':'none',paddingVertical:6}}><VoiceReplies messages={messages} connected={!!session&&online} session={session} onSpeakingChange={setCaptureSpeaking}/></View>
      </View>
    </> : null}
  </Context.Provider>;
}
