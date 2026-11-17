import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Button, Modal, Text, View } from 'react-native';
import { createAudioPlayer } from 'expo-audio';
import { router } from 'expo-router';
import { call, chatErrorMessage } from './client';
import { useWakeChat } from './WakeChatProvider';
import { phoneToken, phoneRingtoneKeys } from './phone-token';
import { advertiseRingtoneCapabilities } from './phone-ringtone-registration';
import { useReportedError } from './app-error-report.ts';

type Invite = { id: string; caller: string; label: string; until: number; ringtone?: 'common' | 'marco' | 'vox' | 'equerre' | 'rose_des_vents' | 'medicis' };
const Context = createContext<{accepted: Invite | null; consume: () => void; busy: (on: boolean) => void} | null>(null);
export function useIncomingPhone() { return useContext(Context); }

export function IncomingPhone({children}: {children: React.ReactNode}) {
  const {session} = useWakeChat();
  const desktop = typeof window !== 'undefined' && window.location?.pathname === '/desktop-call'
    && new URLSearchParams(window.location.search).get('receiver') === 'desktop';
  const [invite, setInvite] = useState<Invite | null>(null);
  const [accepted, setAccepted] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useReportedError('appel entrant', error);
  const answering = useRef(false);
  const decided = useRef<string | null>(null);
  const [previousSession, setPreviousSession] = useState(session);
  if (previousSession !== session) {
    setPreviousSession(session); setInvite(null); setAccepted(null); setError('');
  }

  useEffect(() => {
    if (!session) return;
    const abort = new AbortController();
    const headers = {Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json'};
    let timer: ReturnType<typeof setTimeout>;
    let token: string | null = null;
    let registered: string | null | undefined;
    let ringtoneKeys: string[] = [];
    let capabilityRegistered = '';
    let capabilityProbeAfter = 0;
    void phoneToken().then(async value => { token = value; ringtoneKeys = await phoneRingtoneKeys(); }).catch(() => {});
    let polling = false;
    async function poll() {
      if (!session || abort.signal.aborted || polling) return;
      polling = true;
      try {
        if (registered !== token) {
          const registering = token;
          await call(session.url, '/chat/phone/register', {method: 'POST', headers, body: JSON.stringify({token:registering}), signal: abort.signal});
          registered = registering; capabilityRegistered = '';
        }
        const capsKey=JSON.stringify(ringtoneKeys);
        if(capabilityRegistered!==capsKey && Date.now()>=capabilityProbeAfter){
          capabilityProbeAfter=Date.now()+60000;
          const advertised=await advertiseRingtoneCapabilities((method,body)=>call(session.url!, '/chat/phone/ringtone-capabilities',
            {method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:abort.signal}),ringtoneKeys);
          if(advertised)capabilityRegistered=capsKey;
        }
        const result = await call(session.url, '/chat/phone/pending', {headers, signal: abort.signal}) as {invite: Invite | null};
        if (!abort.signal.aborted && !answering.current) setInvite(result.invite?.id === decided.current ? null : result.invite);
      } catch { if (!abort.signal.aborted) setInvite(null); }
      polling = false;
      if (!desktop && !abort.signal.aborted) timer = setTimeout(() => { void poll(); }, 1800);
    }
    const pulse = (event: MessageEvent) => {
      if (event.source === window.parent && event.data === 'mind.phone.poll') void poll();
    };
    if (desktop) window.addEventListener('message', pulse);
    void poll();
    return () => {
      abort.abort(); clearTimeout(timer);
      if (desktop) window.removeEventListener('message', pulse);
    };
  }, [session, desktop]);

  const ringing = !busy && invite ? invite.id : null;
  useEffect(() => {
    if (!ringing || desktop) return;
    const source = invite?.ringtone === 'marco' ? require('../../assets/ring_marco.wav') : invite?.ringtone === 'vox' ? require('../../assets/ring_vox.wav') : invite?.ringtone === 'equerre' ? require('../../assets/ring_equerre.wav') : invite?.ringtone === 'rose_des_vents' ? require('../../assets/ring_rose_des_vents.wav') : invite?.ringtone === 'medicis' ? require('../../assets/ring_medicis.wav') : require('../../assets/ring.wav');
    const player = createAudioPlayer(source);
    const play = () => { if (AppState.currentState !== 'background') { player.loop = true; player.play(); } };
    play();
    const sub = AppState.addEventListener('change', state => state === 'active' ? play() : player.pause());
    return () => { sub.remove(); player.remove(); };
  }, [ringing, desktop, invite?.ringtone]);

  useEffect(() => {
    if (desktop) window.parent.postMessage({type:'mind.phone.ringing', invite: busy ? null : invite}, '*');
  }, [desktop, busy, invite]);

  async function answer(decision: 'accept' | 'decline') {
    if (!session || !invite || answering.current) return;
    answering.current = true;
    try {
      const result = await call(session.url, '/chat/phone/answer', {method:'POST',
        headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},
        body:JSON.stringify({id:invite.id,decision})}) as {caller:string};
      decided.current = invite.id;
      setError(''); setInvite(null);
      if (decision === 'accept') {
        if (desktop) window.parent.postMessage({type:'mind.phone.accepted', invite}, '*');
        setAccepted({...invite,caller:result.caller}); if (typeof window === 'undefined' || window.location?.pathname !== '/desktop-call') router.navigate('/call'); }
    } catch (reason) { setInvite(null); setError(chatErrorMessage(reason)); }
    finally { answering.current = false; }
  }
  useEffect(() => {
    if (!desktop) return;
    const decide = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== window.parent || !invite || busy || data?.type !== 'mind.phone.answer' || data.id !== invite.id) return;
      if (data.action === 'accept' || data.action === 'decline') void answer(data.action);
    };
    window.addEventListener('message', decide);
    return () => window.removeEventListener('message', decide);
  });
  return <Context.Provider value={{accepted,consume:() => setAccepted(null),busy:setBusy}}>{children}
    <Modal transparent visible={Boolean((!desktop && ringing) || error)} onRequestClose={() => error ? setError('') : void answer('decline')}>
      <View style={{flex:1,justifyContent:'center',backgroundColor:'#0009',padding:32}}>
        <View style={{backgroundColor:'white',padding:24,gap:16,borderRadius:20}}>
          <Text style={{fontSize:22,fontWeight:'600'}}>{error || invite?.label + ' t’appelle'}</Text>
          {error ? <Button title="Fermer" onPress={() => setError('')} /> : <>
            <Button title="Décrocher" onPress={() => void answer('accept')} />
            <Button title="Refuser" color="#963634" onPress={() => void answer('decline')} />
          </>}
        </View>
      </View>
    </Modal>
  </Context.Provider>;
}
