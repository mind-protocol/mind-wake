import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Card, RichText } from '../ui/Primitives';
import { colors, styles as s } from '../ui/theme';
import type { ChatMessage } from './client.ts';
import { MessageRow } from './MessageRow';
import { useWakeChat } from './WakeChatProvider';
import { ReportDialog } from './ReportDialog';
import { tintOf } from './client.ts';
import { createScrollFollow } from './scroll-follow';
import { createWebScrollFollow } from './scroll-follow-web';
export default function WakeChatScreen() {
  const {url,setUrl,session,connecting,error,messages,text,setText,outgoing,online,restoring,connect,submit,disconnect,sendDraft}=useWakeChat();
  const [editingUrl, setEditingUrl] = useState(false);
  const list=useRef<FlatList<ChatMessage>>(null);
  const [following, setFollowing] = useState(true);
  const [scrollFollow] = useState(() => createScrollFollow(() => {}, setFollowing));
  const [webFollow] = useState(() => createWebScrollFollow(scrollFollow));
  const web = Platform.OS === 'web';
  useLayoutEffect(() => {
    scrollFollow.setScrollToEnd(() => list.current?.scrollToEnd({ animated: false }));
  }, [scrollFollow]);
  useEffect(() => { if (!session) scrollFollow.reset(); }, [session, scrollFollow]);
  useLayoutEffect(() => { scrollFollow.contentChanged(); webFollow.invalidate(); }, [messages, outgoing, scrollFollow, webFollow]);
  const [reported, setReported] = useState<{ message: ChatMessage; url: string } | null>(null);
  const [reportVisible, setReportVisible] = useState(false);
  const lastHuman = messages.filter(message => message.role === 'human').at(-1);
  const lastAgent = messages.filter(message => message.role === 'agent').at(-1);
  const awaiting = lastHuman && (!lastAgent || lastHuman.at > lastAgent.at);
  return <SafeAreaView style={s.page} edges={['top', 'left', 'right']}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 4, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={s.strong}>Marco <Text style={s.small}>{restoring ? '…' : session ? online ? '· connecté' : '· reconnexion' : connecting ? '· connexion…' : '· hors ligne'}</Text></Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Changer l’adresse de la passerelle Wake" hitSlop={10}
          onPress={() => { if (session) void disconnect(); setEditingUrl(value => !session || !value); }} style={{ minHeight:44,justifyContent:'center' }}>
          <Text style={s.small}>Changer d’adresse</Text></Pressable>
      </View>
      {!session ? <View style={{ padding: 20, gap: 16, maxWidth: 620, width: '100%', alignSelf: 'center' }}>
        <Card><Text style={s.body}>{restoring || connecting ? 'Connexion à ton Wake…' : 'Ton Wake ne répond pas. Le téléphone doit être sur le Wi-Fi du PC ou sur Tailscale.'}</Text>
          {editingUrl ? <TextInput accessibilityLabel="Adresse de la passerelle Wake" style={s.input} autoCapitalize="none" autoCorrect={false} value={url} onChangeText={setUrl} keyboardType="url" /> : null}
          <Button title={connecting ? 'Connexion…' : editingUrl ? 'Se connecter à cette adresse' : 'Réessayer'} disabled={connecting || restoring}
            onPress={() => { void connect(editingUrl ? url : undefined).then(() => setEditingUrl(false)); }} />
        </Card>
        {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
      </View> : <>
        {!online && error ? <Text accessibilityRole="alert" style={{ color: colors.danger, paddingHorizontal: 12 }}>{error}</Text> : null}
        <View style={{ flex: 1 }} {...(web ? webFollow.inputHandlers : {})}>
        <FlatList ref={list} data={messages} keyExtractor={item => item.id} style={{ flex: 1 }}
          contentContainerStyle={{ gap: 8, padding: 12, width: '100%', maxWidth: 860, alignSelf: 'center' }}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onLayout={event => { webFollow.invalidate(); scrollFollow.onLayout(event); }}
          onContentSizeChange={(width, height) => { webFollow.invalidate(); scrollFollow.onContentSizeChange(width, height); }}
          onScroll={web ? webFollow.onScroll : undefined}
          scrollEventThrottle={web ? 16 : undefined}
          onScrollBeginDrag={scrollFollow.onScrollBeginDrag}
          onScrollEndDrag={scrollFollow.onScrollEndDrag}
          onMomentumScrollEnd={scrollFollow.onMomentumScrollEnd}
          onScrollToTop={scrollFollow.suspend}
          renderItem={({ item }) => <MessageRow name={item.speaker ?? (item.role === 'agent' ? 'Marco' : 'Toi')} mine={item.role === 'human'}>
            <Text style={[s.small, s.strong, { alignSelf: item.role === 'human' ? 'flex-end' : 'flex-start', paddingHorizontal: 4 }]}>{item.speaker ?? (item.role === 'agent' ? 'Marco' : 'Toi')}</Text>
            <View style={{ padding: 12, borderRadius: 16, gap: 3, backgroundColor: item.role === 'human' ? colors.green : tintOf('Marco') }}>
            <RichText text={item.text} />
            {item.role === 'agent' ? <>
              <Button secondary title="Signaler cette réponse"
                onPress={() => {
                  webFollow.invalidate();
                  scrollFollow.suspend();
                  if (!reported || reported.message.id !== item.id || reported.message.version !== item.version || reported.url !== session.url)
                    setReported({ message: { ...item }, url: session.url });
                  setReportVisible(true);
                }} />
            </> : null}
            <Text style={[s.small, { fontSize: 10 }]}>{item.corpus ? 'Conversation éditable' : new Date(item.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              {item.role === 'human' ? item.status === 'delivered' ? ' · reçu' : ' · envoyé' : ''}</Text>
            </View>
          </MessageRow>}
          ListEmptyComponent={<Text style={s.small}>Le fil est prêt. Envoie ton premier message.</Text>}
          ListFooterComponent={<View style={{ gap: 12, marginTop: 12 }}>{outgoing.map(item => <MessageRow key={item.id} name="Toi" mine><View style={[s.card, { backgroundColor: colors.soft }]}>
            <Text style={s.body}>{item.text}</Text><Text accessibilityLiveRegion="polite" style={s.small}>{item.state === 'sending' ? 'Envoi…' : item.state === 'queued' ? 'Envoyé' : item.error}</Text>
            {item.state === 'failed' ? <Button secondary title="Réessayer le même message" onPress={() => { void submit(item); }} /> : null}
          </View></MessageRow>)}{awaiting ? <Text style={s.small}>En attente de Marco.</Text> : null}</View>} />
        {!following ? <View style={{ position: 'absolute', bottom: 8, alignSelf: 'center' }}>
          <Button secondary title="Messages récents ↓" onPress={() => { webFollow.invalidate(); scrollFollow.recent(); }} />
        </View> : null}
        </View>
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
      {reported ? <ReportDialog key={reported.message.id + ':' + reported.message.version + reported.url}
        message={reported.message} session={session?.url === reported.url ? session : null}
        visible={reportVisible} onClose={() => setReportVisible(false)} /> : null}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
