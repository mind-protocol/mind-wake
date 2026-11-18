import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { call, type ChatSession } from './client';
import { type CallTarget } from './call-client';
import { colors, styles as s } from '../ui/theme';

type Peer = { id: string; label: string; direction: 'in' | 'out'; online?: boolean; address?: string };
type PeerState = { label: string; caller: string; enabled: boolean; addresses: string[]; targets: CallTarget[]; peers: Peer[]; code?: string; expiresAt?: number; error?:string|null };
const errors: Record<string,string> = {
  peer_admin_local_only: 'L’association se règle depuis le desktop de ce PC.',
  peer_unavailable: 'PC inaccessible : vérifie son adresse, le même réseau Wi-Fi et le pare-feu (TCP 8790).',
  peer_code_invalid: 'Colle le code complet affiché sur l’autre PC.',
  peer_invitation_expired: 'Ce code a expiré. Crée un nouveau code sur l’autre PC.',
  peer_address_invalid: 'Saisis l’adresse locale affichée sur l’autre PC, par exemple http://192.168.1.25:8790.',
  peer_name_invalid: 'Indique un nom pour ce PC et pour la personne qui appelle.',
  peer_port_unavailable: 'Le port d’appel 8790 est déjà utilisé. Ferme l’autre passerelle avant de créer un code.',
};
const inputStyle = { minHeight:40,borderWidth:1,borderColor:colors.muted,borderRadius:8,padding:8,color:colors.ink };

function Button({text,disabled,onPress}:{text:string;disabled?:boolean;onPress:()=>void}) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
    style={{padding:10,borderRadius:8,backgroundColor:colors.soft,opacity:disabled?0.5:1}}><Text style={s.body}>{text}</Text></Pressable>;
}

/** Desktop-only management. The peer listener exposes calls, never these owner controls. */
export function CallPeers({session,onChanged}:{session:ChatSession;onChanged:()=>void}) {
  const [state,setState]=useState<PeerState|null>(null),[label,setLabel]=useState(''),[caller,setCaller]=useState('');
  const [address,setAddress]=useState(''),[code,setCode]=useState('');
  const [invitation,setInvitation]=useState<{code:string;expiresAt:number}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [linkPrompt,setLinkPrompt]=useState(''),[copyStatus,setCopyStatus]=useState('');
  const request=(action:string,data:Record<string,unknown>={})=>call(session.url,'/chat/call/peers',{
    method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify({action,...data}),
  }) as Promise<PeerState>;
  const report=(reason:unknown)=>{const key=String((reason as {code?:string})?.code??'');setError(errors[key]??'Impossible de mettre à jour la liaison entre PC.');};
  useEffect(()=>{
    let live=true;
    void request('status').then(value=>{if(live){setState(value);setLabel(value.label);setCaller(value.caller);}}).catch(reason=>{if(live)report(reason);});
    return ()=>{live=false;};
  },[session]); // eslint-disable-line react-hooks/exhaustive-deps
  async function copyPrompt(text:string) {
    try {
      const copied=await Clipboard.setStringAsync(text);
      setCopyStatus(copied?'Prompt copié — colle-le à l’agent de l’autre PC.':'Copie automatique indisponible. Sélectionne et copie le prompt ci-dessous.');
    }catch{setCopyStatus('Copie automatique indisponible. Sélectionne et copie le prompt ci-dessous.');}
  }
  async function run(action:string,data:Record<string,unknown>={},withPrompt=false) {
    setBusy(true);setError('');setCopyStatus('');
    try {
      if(action==='pair'||action==='invite')await request('profile',{label,caller});
      const value=await request(action,data);setState(value);
      if(value.code&&value.expiresAt){
        setInvitation({code:value.code,expiresAt:value.expiresAt});
        setLinkPrompt('');
        if(withPrompt){
          const text=`Relie notre installation MIND Wake à celle de l’autre PC sur le même réseau Wi-Fi.

Installation qui m’envoie cette invitation : ${value.label}
Utilisateur : ${value.caller}
Adresses locales à essayer depuis ton PC (pas localhost) :
${value.addresses.map(url=>`- ${url}`).join('\n')}
Code d’association : ${value.code}
Expiration : ${new Date(value.expiresAt).toISOString()} (UTC, valable 1 heure, usage unique).
Tous les agents et rooms de ce PC sont accessibles par défaut, y compris ceux ajoutés ensuite. Liste actuelle :
${value.targets.map(t=>`- ${t.label} (${t.handle})`).join('\n')}

Sur TON PC :
1. Vérifie que MIND Wake est installé et dispose des appels entre PC. Repère son installation locale ; ne suppose pas que les chemins du PC émetteur existent chez toi.
2. Dans le desktop, ouvre Appel → Réglages → Appels avec d’autres PC. Renseigne le nom de ton installation et de son utilisateur.
3. Sous « Appeler les agents d’un autre PC », saisis une des adresses ci-dessus et le code, puis clique « Associer ce PC ». Essaie une autre adresse fournie si la première est inaccessible. Si le code a expiré ou a déjà été utilisé, demande un nouveau prompt.
4. Vérifie que les agents distants apparaissent dans « Autres PC ». Cette association permet à ton PC d’appeler les agents listés ci-dessus.
5. Pour que le PC émetteur puisse aussi appeler tes agents, prépare l’association inverse : utilise « Copier le prompt de liaison » et renvoie ce prompt à ton utilisateur. Tous tes agents et rooms seront accessibles par défaut.

Pendant un appel, les messages des agents participants sont partagés entre eux. Pour faire sonner aussi l’humain distant, l’appelant coche « Inviter aussi l’humain » ; celui-ci doit décrocher. N’ouvre pas le microphone et ne lance pas d’appel de test sans demande.
Si la liaison échoue, vérifie le même réseau local, l’absence d’isolation Wi-Fi et l’accès au port TCP indiqué dans l’adresse (8790 par défaut). La voix humaine utilise aussi WebRTC/UDP local. Ne configure pas de redirection Internet.
Confirme ce qui est effectivement relié, le sens de l’association et ce qui reste à tester. Ce code ne doit pas être publié dans un dépôt ou une room publique.`;
          setLinkPrompt(text);await copyPrompt(text);
        }
      }
      if(action==='pair'){setCode('');setAddress('');}
      onChanged();
    }catch(reason){report(reason);}finally{setBusy(false);}
  }
  return <View style={{gap:10,borderTopWidth:1,borderTopColor:colors.soft,paddingTop:12}}>
    <Text style={[s.body,{fontWeight:'700'}]}>Appels avec d’autres PC</Text>
    <Text style={s.small}>Associe les installations sur le même Wi-Fi. Pendant un appel, les réponses sont partagées avec tous ses participants.</Text>
    {error?<Text accessibilityRole="alert" style={{color:colors.danger}}>{error}</Text>:null}
    {state?.error?<Text accessibilityRole="alert" style={{color:colors.danger}}>{errors[state.error]??'La réception des appels est indisponible.'}</Text>:null}
    {state?<>
      <TextInput accessibilityLabel="Nom de cette installation" placeholder="Nom de ce PC" value={label} onChangeText={setLabel} style={inputStyle}/>
      <TextInput accessibilityLabel="Nom de la personne qui appelle" placeholder="Ton nom" value={caller} onChangeText={setCaller} style={inputStyle}/>
      <Button text="Enregistrer les noms" disabled={busy} onPress={()=>void run('profile',{label,caller})}/>
      <Text style={[s.body,{fontWeight:'600'}]}>Autoriser un autre PC à appeler ici</Text>
      <Text style={s.small}>Tous les agents et rooms sont partagés avec les PC associés, y compris ceux ajoutés ensuite. Pendant un appel, les messages sont partagés entre ses participants.</Text>
      <Button text="Créer un code d’association" disabled={busy} onPress={()=>void run('invite')}/>
      <Button text="Copier le prompt de liaison" disabled={busy||!state.addresses.length} onPress={()=>void run('invite',{},true)}/>
      <Text style={s.small}>Crée un nouveau code et copie les informations pour l’agent de l’autre PC. Tous les agents et rooms sont inclus. Le nouveau code remplace le précédent.</Text>
      {!state.addresses.length?<Text style={s.small}>Connecte ce PC au Wi-Fi pour préparer un prompt avec son adresse locale.</Text>:null}
      {copyStatus?<Text accessibilityLiveRegion="polite" style={s.small}>{copyStatus}</Text>:null}
      {linkPrompt?<View style={{gap:5}}>
        <TextInput accessibilityLabel="Prompt de liaison à coller à l’autre agent" value={linkPrompt} editable={false} selectTextOnFocus multiline style={[inputStyle,{maxHeight:180}]}/>
        <Button text="Recopier ce prompt" disabled={busy} onPress={()=>{if(invitation&&Date.now()<invitation.expiresAt)void copyPrompt(linkPrompt);else setCopyStatus('Ce prompt a expiré. Clique « Copier le prompt de liaison » pour en créer un nouveau.');}}/>
      </View>:null}
      {invitation?<View style={{gap:5}}>
        <Text style={s.small}>Sur l’autre PC, saisis une de ces adresses et colle ce code. Il expire à {new Date(invitation.expiresAt).toLocaleTimeString()} et sert une seule fois.</Text>
        {state.addresses.map(url=><Text selectable key={url} style={s.body}>{url}</Text>)}
        {!state.addresses.length?<Text style={s.small}>Aucune adresse Wi-Fi détectée. Connecte ce PC au réseau local.</Text>:null}
        <TextInput accessibilityLabel="Code à copier sur l’autre PC" value={invitation.code} editable={false} selectTextOnFocus multiline style={inputStyle}/>
      </View>:null}
      <Text style={[s.body,{fontWeight:'600'}]}>Appeler les agents d’un autre PC</Text>
      <TextInput accessibilityLabel="Adresse de l’autre PC" placeholder="http://192.168.1.25:8790" autoCapitalize="none" value={address} onChangeText={setAddress} style={inputStyle}/>
      <TextInput accessibilityLabel="Code de l’autre PC" placeholder="Code d’association" autoCapitalize="none" value={code} onChangeText={setCode} style={inputStyle}/>
      <Button text="Associer ce PC" disabled={busy||!address||!code} onPress={()=>void run('pair',{address,code})}/>
      <Text style={s.small}>Pour appeler dans les deux sens, fais aussi l’association inverse.</Text>
      {state.peers.map(p=><View key={p.id} style={{gap:4}}>
        <Text style={s.body}>{p.label} — {p.direction==='in'?'peut appeler ici':p.online===false?'injoignable':'agents disponibles'}</Text>
        {p.direction==='in'?<Text style={s.small}>Tous les agents et rooms</Text>:null}
        <Button text={`Révoquer ${p.label}`} disabled={busy} onPress={()=>void run('revoke',{id:p.id})}/>
      </View>)}
      <Button text={busy?'Connexion…':'Actualiser les installations'} disabled={busy} onPress={()=>void run('refresh')}/>
    </>:!error?<Text style={s.small}>Chargement…</Text>:null}
  </View>;
}
