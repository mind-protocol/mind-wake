import React, { useRef } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Card } from '../ui/Primitives';
import { colors, styles as s } from '../ui/theme';
import type { ChatMessage } from './client.ts';
import { useWakeChat } from './WakeChatProvider';
export default function WakeChatScreen() {
  const {url,setUrl,code,setCode,session,pairing,error,messages,text,setText,outgoing,online,restoring,pair,submit,disconnect,sendDraft}=useWakeChat();
  const list=useRef<FlatList<ChatMessage>>(null);
  const lastHuman = messages.filter(message => message.role === 'human').at(-1);
  const lastAgent = messages.filter(message => message.role === 'agent').at(-1);
  const awaiting = lastHuman && (!lastAgent || lastHuman.at > lastAgent.at);
  return <SafeAreaView style={s.page} edges={['top', 'left', 'right']}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 4, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={s.strong}>Marco <Text style={s.small}>{restoring ? '…' : session ? online ? '· connecté' : '· reconnexion' : '· appairage'}</Text></Text>
        {session ? <Pressable accessibilityRole="button" accessibilityLabel="Déconnecter cet appareil" hitSlop={10} onPress={() => { void disconnect(); }} style={{ minHeight:44,justifyContent:'center' }}><Text style={s.small}>Déconnecter</Text></Pressable> : null}
      </View>
      {!session ? <View style={{ padding: 20, gap: 16, maxWidth: 620, width: '100%', alignSelf: 'center' }}>
        <Card><Text style={s.body}>Retrouve ici les réponses de ton agent Wake. L’appairage donne accès à ton fil personnel ; la connexion X ou Telegram ne le remplace pas.</Text>
          <Text style={s.small}>Sur le téléphone, utilise l’adresse locale du PC et le code temporaire fourni dans Wake. Ce parcours n’autorise aucun paiement.</Text>
          <TextInput accessibilityLabel="Adresse de la passerelle Wake" style={s.input} autoCapitalize="none" autoCorrect={false} value={url} onChangeText={setUrl} keyboardType="url" />
          <TextInput accessibilityLabel="Code temporaire d’appairage" secureTextEntry style={s.input} autoCapitalize="none" autoCorrect={false} value={code} onChangeText={setCode} />
          <Button title={pairing ? 'Appairage…' : 'Relier mon Wake'} disabled={pairing || restoring || !code.trim()} onPress={() => { void pair(); }} />
        </Card>
        {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
      </View> : <>
        <FlatList ref={list} data={messages} keyExtractor={item => item.id} style={{ flex: 1 }}
          contentContainerStyle={{ gap: 8, padding: 12, width: '100%', maxWidth: 860, alignSelf: 'center' }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => <View style={{ alignSelf: item.role === 'human' ? 'flex-end' : 'flex-start', maxWidth: '95%',
            padding: 12, borderRadius: 16, gap: 3, backgroundColor: item.role === 'human' ? colors.green : colors.paper }}>
            <Text style={s.strong}>{item.role === 'agent' ? 'Marco' : 'Toi'}</Text><Text selectable style={s.body}>{item.text}</Text>
            <Text style={[s.small, { fontSize: 10 }]}>{new Date(item.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              {item.role === 'human' ? item.status === 'delivered' ? ' · Transmis à la session Wake' : ' · Enregistré dans la file Wake' : ''}</Text>
          </View>}
          ListEmptyComponent={<Text style={s.small}>Le fil est prêt. Envoie ton premier message.</Text>}
          ListFooterComponent={<View style={{ gap: 12, marginTop: 12 }}>{outgoing.map(item => <View key={item.id} style={[s.card, { backgroundColor: colors.soft }]}>
            <Text style={s.body}>{item.text}</Text><Text accessibilityLiveRegion="polite" style={s.small}>{item.state === 'sending' ? 'Envoi…' : item.state === 'queued' ? 'Enregistré dans la file Wake' : item.error}</Text>
            {item.state === 'failed' ? <Button secondary title="Réessayer le même message" onPress={() => { void submit(item); }} /> : null}
          </View>)}{awaiting ? <Text style={s.small}>En attente de Marco.</Text> : null}</View>} />
        <View style={{ paddingHorizontal: 10, paddingVertical: 4, gap: 3, width: '100%', maxWidth: 860, alignSelf: 'center', borderTopWidth: 1, borderColor: colors.line }}>
          {error ? <Text accessibilityLiveRegion="polite" style={{ color: colors.danger }}>{error}</Text> : null}
          <View style={{flexDirection:'row',alignItems:'center',gap:6}}>
            <TextInput accessibilityLabel="Brouillon à Marco, éditable" style={[s.input, { flex:1,minHeight:44,maxHeight:92,paddingVertical:8,textAlignVertical:'top' }]} multiline
              value={text} onChangeText={setText} placeholder="Message…" />
            <Pressable accessibilityRole="button" accessibilityLabel="Envoyer le brouillon à Marco" accessibilityState={{disabled:!text.trim()||text.length>4000}}
              disabled={!text.trim()||text.length>4000} onPress={sendDraft}
              style={{minWidth:68,minHeight:44,paddingHorizontal:10,borderRadius:14,backgroundColor:text.trim()&&text.length<=4000?colors.dark:colors.soft,alignItems:'center',justifyContent:'center'}}>
              <Text style={{color:text.trim()&&text.length<=4000?colors.paper:colors.muted,fontWeight:'700'}}>Envoyer</Text>
            </Pressable>
          </View>
          {text.length > 4000 ? <Text accessibilityLiveRegion="polite" style={{color:colors.danger}}>Brouillon trop long : tes mots sont conservés. Raccourcis avant l’envoi.</Text> : null}
        </View>
      </>}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
