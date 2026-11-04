import React, { useState } from 'react';
import { Pressable, Share, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';
import { useMind } from '../../state/AppState';
import { demoInvitationText, demoInvitePath, referralOffer } from '../../referrals/offers.ts';
import { Avatar, Button, Card, EmptyState, Screen } from '../../ui/Primitives';
import { colors, styles as s } from '../../ui/theme';

export default function InviteScreen() {
  const { username } = useLocalSearchParams<{ username: string }>(); const router = useRouter();
  const { snapshot, mode } = useMind(); const [notice, setNotice] = useState<string | null>(null);
  const person = snapshot.creators.find(item => item.username === username);
  const offer = person ? referralOffer(person.username, mode) : null;
  const enabled = !!person && offer?.status === 'example';
  const url = enabled && person ? Linking.createURL(demoInvitePath(person.username)) : '';
  const message = person && url ? demoInvitationText(person.name, url) : '';
  async function share() {
    if (!enabled) return;
    try {
      const result = await Share.share({ message });
      setNotice(result.action === Share.dismissedAction ? 'Partage annulé. Aucune arrivée attribuée.' : 'Partage demandé. Aucun envoi reçu, gain ou arrivée n’est confirmé.');
    } catch { setNotice('Le partage n’est pas disponible. Tu peux copier le lien.'); }
  }
  async function copy() {
    if (!enabled) return;
    try { await Clipboard.setStringAsync(url); setNotice('Lien copié. Il n’est pas envoyé et ne crée aucune attribution.'); }
    catch { setNotice('La copie n’est pas disponible ici.'); }
  }
  return <Screen>
    <Pressable accessibilityRole="button" onPress={() => router.canGoBack() ? router.back() : router.replace('/')}><Text style={s.small}>← Retour aux offres</Text></Pressable>
    {person ? <>
      <Text style={s.eyebrow}>INVITATION · DÉMONSTRATION</Text><Text style={s.heading}>Invite {person.name}.</Text>
      <Card><View style={s.row}><Avatar person={person} size={58} /><View style={s.grow}><Text style={s.title}>{person.name}</Text><Text style={s.small}>@{person.username}</Text></View></View>
        <Text style={s.eyebrow}>POUR TOI, LE PARRAIN · EXEMPLE</Text>
        <Text style={{ color: colors.ink, fontSize: 42, fontWeight: '700' }}>{enabled ? `+${offer?.potentialTokens} ◈` : 'Aucune offre configurée'}</Text>
        <Text style={s.body}>{enabled ? `Après l’arrivée vérifiée de ${person.name} · exemple non financé.` : 'Aucune invitation rémunérée disponible.'}</Text>
      </Card>
      {message ? <Card><Text style={s.strong}>Le message à partager</Text><Text selectable style={s.body}>{message}</Text></Card> : null}
      <Button title="Préparer le partage" icon="share-outline" disabled={!enabled} onPress={() => { void share(); }} />
      <Button title="Copier le lien d’invitation" secondary disabled={!enabled} onPress={() => { void copy(); }} />
      <Text style={s.small}>Inviter ne débite rien. Le partage ne confirme ni arrivée ni prime.</Text>
      {notice ? <Text accessibilityLiveRegion="polite" style={s.body}>{notice}</Text> : null}
    </> : <EmptyState title="Cette invitation n’est pas disponible." />}
  </Screen>;
}
