import React, { createContext, useContext, useEffect, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { ChatClientError, chatCandidates, chatErrorMessage, needsNewChatSession, connectChat, logoutChat, readChat, sendChat, type ChatMessage, type ChatSession } from './client.ts';
import { clearChatSession, loadChatSession, saveChatSession } from './storage.ts';
import DeviceVoice from './DeviceVoice';
import { Pressable, Text, View } from 'react-native';
import { VoiceReplies } from '../presence/VoiceReplies';
import { colors, styles as s } from '../ui/theme';
import { setCaptureSpeaking } from './voice-intent.ts';
import { appErrors, installGlobalAppErrorHandlers, reportAppError, useReportedError } from './app-error-report.ts';
installGlobalAppErrorHandlers();
export type WakeChatContextValue = {
 url: string; setUrl: (value:string)=>void;
 session:ChatSession|null; connecting:boolean; error:string|null; messages:ChatMessage[];
 text:string; setText:React.Dispatch<React.SetStateAction<string>>; outgoing:Outgoing[];
 online:boolean; restoring:boolean; connect:(preferred?:string)=>Promise<void>; submit:(item:Outgoing)=>Promise<void>;
 disconnect:()=>Promise<void>; sendDraft:()=>void;
};
const Context = createContext<WakeChatContextValue|null>(null);
export function useWakeChat() { const value=useContext(Context); if(!value) throw new Error('WakeChatProvider missing'); return value; }
type Outgoing = { id: string; text: string; state: 'sending' | 'queued' | 'failed'; error?: string };
// No pairing: the configured gateway first, then the LAN and Tailscale fallbacks (comma-separated), then loopback (web on the PC).
const desktopCall = typeof window !== 'undefined' && window.location?.pathname === '/desktop-call';
const defaultCandidates=desktopCall ? [window.location.origin] : chatCandidates(process.env.EXPO_PUBLIC_MIND_CHAT_URL, process.env.EXPO_PUBLIC_MIND_CHAT_FALLBACK_URLS, 'http://127.0.0.1:8789');
const defaultChatUrl=defaultCandidates[0] ?? 'http://127.0.0.1:8789';
export function WakeChatProvider({ children }: { children: React.ReactNode }) {
  const [url, setUrl] = useState(defaultChatUrl);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [connecting, setConnecting] = useState(false); const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]); const [text, setText] = useState('');
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]); const [online, setOnline] = useState(false);
  const [restoring, setRestoring] = useState(true);
  // Erreurs affichées → agent principal (POST /chat/app-errors), file vidée dès qu'une session existe.
  useEffect(() => { appErrors.setSession(online ? session : null); }, [session, online]);
  useReportedError('chat · connexion', error);
  // « Charge à l'infini » : toujours pas en ligne après 30 s (part à la reconnexion).
  useEffect(() => { if (online) return; const timer = setTimeout(() => reportAppError('chat · chargement', `Toujours hors ligne après 30 s${error ? ` : ${error}` : ' (aucune erreur affichée)'}`), 30_000); return () => clearTimeout(timer); }, [online, error]);
  const [voiceOptions,setVoiceOptions]=useState(true);
  const [voiceConversation,setVoiceConversation]=useState(false);

  useEffect(() => { let active = true; void loadChatSession().then(async value => {
    // A session saved by an older build (USB pairing on 127.0.0.1, another LAN address) is dropped: no pairing is needed now.
    if (value && defaultCandidates.length && !defaultCandidates.includes(value.url)) { await clearChatSession(); value = null; }
    if (active) { setSession(value); setRestoring(false); }
    if (!value && active) await connect();
  }); return () => { active = false; }; }, []);
  // Never stay silently offline: while disconnected with an error, retry the connection every 5 s.
  useEffect(() => {
    if (session || connecting || restoring || !error) return;
    const timer = setTimeout(() => { void connect(); }, 5000); return () => clearTimeout(timer);
  }, [session, connecting, restoring, error]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true; let cursor = ''; let backoff = 1000;
    // Same token, other address of the same PC: rotate between LAN and Tailscale when one is unreachable.
    const urls = chatCandidates(session.url, ...defaultCandidates); let index = 0;
    const listen = async () => {
      const current = { ...session, url: urls[index] ?? session.url };
      try {
        const snapshot = await readChat(current, cursor, controller.signal);
        if (!active) return;
        if (current.url !== session.url) { await saveChatSession(current); if (active) setSession(current); return; }
        cursor = snapshot.cursor; backoff = 1000; setOnline(true); setError(null); setMessages(snapshot.messages);
        setOutgoing(previous => previous.filter(item => !snapshot.messages.some(message => message.id === item.id)));
        timer = setTimeout(() => { void listen(); }, 0);
      } catch (reason) {
        if (!active) return;
        setOnline(false); setError(`${chatErrorMessage(reason)} (${current.url})`);
        const unreachable = reason instanceof ChatClientError && ['connection_lost', 'connection_timeout'].includes(reason.code);
        // Only the server can invalidate the saved token. Keep it across network outages and restarts.
        if (needsNewChatSession(reason)) {
          void clearChatSession(); setSession(null); void connect(session.url); return;
        }
        if (unreachable && urls.length > 1) index = (index + 1) % urls.length;
        timer = setTimeout(() => { void listen(); }, backoff); backoff = Math.min(backoff * 2, 8000);
      }
    };
    void listen(); return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [session]);
  async function connect(preferred?: string) {
    const candidates = chatCandidates(preferred, ...defaultCandidates);
    setConnecting(true); setError(null);
    try {
      const value = await connectChat(candidates);
      await saveChatSession(value); setUrl(value.url); setSession(value);
    } catch (reason) { setError(`${chatErrorMessage(reason)} (${candidates.join(', ') || 'aucune adresse configurée'})`); }
    finally { setConnecting(false); }
  }
  async function submit(item: Outgoing) {
    if (!session) return;
    setOutgoing(previous => [...previous.filter(value => value.id !== item.id), { ...item, state: 'sending' }]);
    try {
      await sendChat(session, item.id, item.text);
      setOutgoing(previous => previous.map(value => value.id === item.id ? { ...value, state: 'queued', error: undefined } : value));
    } catch (reason) { reportAppError('chat · envoi', chatErrorMessage(reason)); setOutgoing(previous => previous.map(value => value.id === item.id
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
  return <Context.Provider value={{url,setUrl,session,connecting,error,messages,text,setText,outgoing,online,restoring,connect,submit,disconnect,sendDraft}}>
    {children}
    {session && !desktopCall ? <>
      <DeviceVoice session={session} onTranscript={value=>{
        if(voiceConversation && online) void submit({id:`chat-${Crypto.randomUUID()}`,text:value,state:'sending'});
        else setText(previous=>[previous.trim(),value].filter(Boolean).join('\n'));
      }} />
      <Text style={[s.small,{paddingHorizontal:10}]}>{voiceConversation?'Conversation vocale : transcriptions envoyées automatiquement. Pause micro pour arrêter.':'Dictée : transcriptions dans le brouillon. Active la conversation vocale pour l’envoi automatique.'}</Text>
      <View style={{backgroundColor:colors.paper,paddingHorizontal:10}}>
        <Pressable accessibilityRole="button" accessibilityState={{expanded:voiceOptions}} onPress={()=>setVoiceOptions(value=>!value)}
          style={{minHeight:44,justifyContent:'center'}}><Text style={s.small}>{voiceOptions?'Masquer les options voix ▴':'Voix des réponses / Essayer ▾'}</Text></Pressable>
        <View style={{display:voiceOptions?'flex':'none',paddingVertical:6}}><VoiceReplies messages={messages} connected={!!session&&online} session={session} onSpeakingChange={setCaptureSpeaking} onEnabledChange={setVoiceConversation}/></View>
      </View>
    </> : null}
  </Context.Provider>;
}
