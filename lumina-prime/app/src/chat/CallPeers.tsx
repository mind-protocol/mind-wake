import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { call, type ChatSession } from './client';
import { type CallTarget } from './call-client';
import { colors, styles as s } from '../ui/theme';

type Peer = { id: string; label: string; direction: 'in' | 'out'; online?: boolean; address?: string };
type PeerState = { label: string; caller: string; enabled: boolean; addresses: string[]; targets: CallTarget[]; peers: Peer[]; blocked?: {id:string;label:string}[];  error?:string|null };
const errors: Record<string,string> = {
  peer_admin_local_only: 'Les appels entre colonies se règlent depuis le desktop de ce PC.',
  peer_unavailable: 'Colonie inaccessible : vérifie que les deux PC sont sur le même réseau et que le pare-feu autorise les appels.',
  peer_address_invalid: 'La colonie n’annonce pas d’adresse locale utilisable.',
  peer_name_invalid: 'Indique un nom pour ce PC et pour la personne qui appelle.',
  peer_port_unavailable: 'Le port d’appel 8790 est déjà utilisé. Ferme l’autre passerelle pour recevoir les appels.',
};
const inputStyle = { minHeight:40,borderWidth:1,borderColor:colors.muted,borderRadius:8,padding:8,color:colors.ink };

function Button({text,disabled,onPress}:{text:string;disabled?:boolean;onPress:()=>void}) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
    style={{padding:10,borderRadius:8,backgroundColor:colors.soft,opacity:disabled?0.5:1}}><Text style={s.body}>{text}</Text></Pressable>;
}

/** Desktop-only management. The peer listener exposes calls, never these owner controls. */
export function CallPeers({session,onChanged}:{session:ChatSession;onChanged:()=>void}) {
  const [state,setState]=useState<PeerState|null>(null),[label,setLabel]=useState(''),[caller,setCaller]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=(action:string,data:Record<string,unknown>={})=>call(session.url,'/chat/call/peers',{
    method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify({action,...data}),
  }) as Promise<PeerState>;
  const report=(reason:unknown)=>{const key=String((reason as {code?:string})?.code??'');setError(errors[key]??'Impossible de mettre à jour la liaison entre PC.');};
  useEffect(()=>{
    let live=true;
    void request('status').then(value=>{if(live){setState(value);setLabel(value.label);setCaller(value.caller);}}).catch(reason=>{if(live)report(reason);});
    return ()=>{live=false;};
  },[session]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run(action:string,data:Record<string,unknown>={}) {
    setBusy(true);setError('');
    try {setState(await request(action,data));onChanged();}
    catch(reason){report(reason);}finally{setBusy(false);}
  }
  return <View style={{gap:10,borderTopWidth:1,borderTopColor:colors.soft,paddingTop:12}}>
    <Text style={[s.body,{fontWeight:'700'}]}>Appels avec d’autres PC</Text>
    <Text style={s.small}>Retrouve les colonies de ton carnet sur le même réseau local. Pendant un appel, les réponses sont partagées avec tous ses participants.</Text>
    {error?<Text accessibilityRole="alert" style={{color:colors.danger}}>{error}</Text>:null}
    {state?.error?<Text accessibilityRole="alert" style={{color:colors.danger}}>{errors[state.error]??'La réception des appels est indisponible.'}</Text>:null}
    {state?<>
      <TextInput accessibilityLabel="Nom de cette installation" placeholder="Nom de ce PC" value={label} onChangeText={setLabel} style={inputStyle}/>
      <TextInput accessibilityLabel="Nom de la personne qui appelle" placeholder="Ton nom" value={caller} onChangeText={setCaller} style={inputStyle}/>
      <Button text="Enregistrer les noms" disabled={busy} onPress={()=>void run('profile',{label,caller})}/>
      <Text style={s.small}>Les colonies du carnet sont reliées automatiquement sur le réseau local. Active le pont dans Réglages → Pont pair-à-pair entre colonies sur les deux PC. Ajoute leur carte au carnet si elles ne sont pas encore connues.</Text>
      <Text style={s.small}>Tous les agents et rooms sont disponibles. Pour appeler, ferme les réglages et choisis les participants dans « Autres PC ». L’invitation humaine reste facultative.</Text>
      {!state.enabled?<Text style={s.small}>Réception inactive : active le pont entre colonies dans les réglages du desktop.</Text>:null}
      {!state.peers.length?<Text style={s.small}>Aucune colonie joignable annoncée pour les appels locaux.</Text>:null}
      {state.peers.map(p=><View key={p.id} style={{gap:4}}>
        <Text style={s.body}>{p.label} — {p.direction==='in'?'peut appeler ici':p.online===false?'injoignable':'agents disponibles'}</Text>
        {p.direction==='in'?<Text style={s.small}>Tous les agents et rooms</Text>:null}
        <Button text={`Révoquer ${p.label}`} disabled={busy} onPress={()=>void run('revoke',{id:p.id})}/>
      </View>)}
      {state.blocked?.map(p=><Button key={p.id} text={`Autoriser à nouveau ${p.label}`} disabled={busy} onPress={()=>void run('allow',{id:p.id})}/>)}
      <Button text={busy?'Connexion…':'Actualiser les installations'} disabled={busy} onPress={()=>void run('refresh')}/>
    </>:!error?<Text style={s.small}>Chargement…</Text>:null}
  </View>;
}
