import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { Ionicons } from '@expo/vector-icons';
import { useMind } from '../../state/AppState';
import { Avatar, Button, Card, EmptyState, Screen, SectionHeading, Sparkline } from '../../ui/Primitives';
import { colors, styles as s } from '../../ui/theme';

function sourceUrl(source: string): string | null {
  try {
    const url = new URL(source.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function observedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date non fournie' : date.toLocaleString('fr-FR');
}

export default function CreatorScreen() {
  const { username } = useLocalSearchParams<{ username: string }>(); const { snapshot, mode } = useMind(); const router = useRouter();
  const person = snapshot.creators.find(item => item.username === username);
  const [linkError, setLinkError] = useState<string | null>(null);
  const openSource = async (url: string) => {
    setLinkError(null);
    try { await Linking.openURL(url); }
    catch { setLinkError('Le lien n’a pas pu être ouvert. Tu peux réessayer depuis sa source ci-dessous.'); }
  };
  return <Screen>
    <Pressable accessibilityRole="button" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={s.row}><Ionicons name="arrow-back" size={18} color={colors.ink} /><Text style={s.small}>Retour au radar</Text></Pressable>
    {person ? <>
      <Card style={{ backgroundColor: person.color, borderColor: person.color, padding: 25 }}>
        <View style={s.between}><Avatar person={person} size={80} /><Sparkline values={person.spark} height={55} /></View>
        <View style={{ gap: 4 }}><Text style={[s.heading, { fontSize: 39 }]}>{person.name}</Text><Text style={s.body}>@{person.username} · {person.role}</Text></View>
        <Text style={[s.title, { marginTop: 12 }]}>{person.title}</Text><Text style={s.body}>{person.description}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{person.tags.map(tag => <View key={tag} style={[s.pill, { backgroundColor: '#FFFFFF66' }]}><Text style={s.pillText}>{tag}</Text></View>)}</View>
        <Button title={`Préparer un soutien à ${person.name}`} icon="create-outline" onPress={() => router.push({ pathname: '/compose/[username]', params: { username: person.username } })} />
        <Text style={s.small}>Tu choisis ensuite ton montant et ton texte. Ce bouton ouvre un brouillon, sans publier ni payer.</Text>
      </Card>
      <SectionHeading eyebrow={mode === 'demo' ? 'PROJET DE DÉMONSTRATION' : 'SON TRAVAIL'} title="À découvrir" />
      <Card><Text style={s.strong}>{person.title}</Text><Text style={s.body}>{mode === 'demo' ? 'Ce projet illustre le parcours. Aucune œuvre réelle n’est associée à ce profil fictif.' : 'Aucun lien direct vers une œuvre ou un projet n’a été fourni pour ce profil.'}</Text><Text style={s.small}>Les sources des signaux, lorsqu’elles comportent une adresse web, sont accessibles ci-dessous.</Text></Card>
      <SectionHeading eyebrow="LES SIGNAUX, PAS UNE PROMESSE" title={`Pourquoi ${person.name} ?`} />
      {person.reasons.map((reason, index) => <View key={reason} style={[s.row, { gap: 14 }]}><View style={{ width: 29, height: 29, borderRadius: 15, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }}><Text style={s.strong}>{index + 1}</Text></View><Text style={[s.body, { flex: 1 }]}>{reason}</Text></View>)}
      <SectionHeading title="Regarder les preuves" />
      {!person.signals.length ? <Card><Text style={s.body}>Aucun signal documenté pour le moment.</Text><Text style={s.small}>Une source et une date permettront de situer les prochaines informations partagées.</Text></Card> : null}
      {person.signals.map((signal, index) => {
        const url = sourceUrl(signal.source);
        return <Card key={`${signal.label}-${index}`}><View style={s.between}><Text style={[s.strong, { flex: 1 }]}>{signal.label}</Text><Text style={[s.title, { fontSize: 25 }]}>{signal.value}</Text></View>
          <Text style={s.body}>{signal.detail}</Text><View style={s.divider} /><Text selectable style={s.small}>Source : {signal.source || 'Non fournie'}</Text><Text style={[s.small, { fontSize: 10 }]}>Observation : {observedDate(signal.observedAt)}</Text>
          {url ? <Button secondary title="Ouvrir la source" icon="open-outline" onPress={() => { void openSource(url); }} /> : <Text style={[s.small, { fontSize: 10 }]}>Lien vers la source non fourni.</Text>}
        </Card>;
      })}
      {linkError ? <Text accessibilityRole="alert" style={[s.small, { color: colors.danger }]}>{linkError}</Text> : null}
      {mode === 'demo' ? <Text style={s.small}>Ce profil et ses signaux sont fictifs. Ils servent à explorer l’app ; aucune création ni recette réelle n’est attribuée à cette personne.</Text> : null}
    </> : <EmptyState title="Ce profil n’est pas disponible." />}
  </Screen>;
}
