import React from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMind } from '../../state/AppState';
import { formatMind } from '../../data/logic.ts';
import { Button, Card, EmptyState, Screen, SectionHeading } from '../../ui/Primitives';
import { colors, styles as s } from '../../ui/theme';

export default function SupportsScreen() {
  const { snapshot, mode } = useMind(); const router = useRouter();
  return <Screen><View style={{ gap: 9 }}><Text style={s.eyebrow}>LES PERSONNES QUE TU FAIS GRANDIR</Text><Text style={s.heading}>Tes soutiens.</Text><Text style={s.subtitle}>Le principal d’abord. Puis les primes effectivement réglées.</Text></View>
    <Card style={{ backgroundColor: colors.dark, borderColor: colors.dark }}><Text style={{ color: colors.green, fontSize: 10, letterSpacing: 1.5, fontWeight: '700' }}>LE RYTHME DES ROUNDS</Text><Text style={{ color: colors.paper, fontSize: 27, fontWeight: '600' }}>24 heures pour voir un élan.</Text><Text style={{ color: '#C4D4CB', lineHeight: 21, fontSize: 13 }}>Activation, achat, nouveaux dons : trois événements distincts. Les règles et montants restent à valider avant un round payant.</Text></Card>
    <Card><Text style={s.strong}>Tu as vu « +10 MIND @… » quelque part ?</Text><Text style={s.small}>Lis une capture ou colle un texte : l’app repère la commande et ouvre un brouillon à relire. Rien n’est payé sans toi.</Text>
      <Button title="Lire une capture" icon="scan-outline" secondary onPress={() => router.push('/scan')} /></Card>
    <SectionHeading title="Suivre les mouvements" />
    {snapshot.positions.length ? snapshot.positions.map(position => <Card key={position.id}>
      <View style={s.between}><View style={{ gap: 4 }}><Text style={s.title}>{position.name}</Text><Text style={s.small}>@{position.username}</Text></View><View style={[s.pill, { backgroundColor: position.status === 'settled' ? colors.green : colors.lavender }]}><Text style={s.pillText}>{position.status === 'settled' ? mode === 'demo' ? 'Réglé · exemple' : 'Réglé' : 'En attente'}</Text></View></View>
      <View style={s.row}><View style={[s.grow, { gap: 3 }]}><Text style={s.small}>Mise</Text><Text style={s.amount}>◈ {formatMind(position.principal)}</Text></View><View style={[s.grow, { gap: 3 }]}><Text style={s.small}>Principal rendu</Text><Text style={s.amount}>◈ {formatMind(position.returned)}</Text></View></View>
      <View style={s.divider} /><Text style={s.eyebrow}>LES TROIS PRIMES</Text>
      {[['Activation', position.activation], ['Achat', position.purchase], ['Dons reçus', position.donations]].map(([name, value]) => <View style={s.between} key={name}><Text style={s.body}>{name}</Text><Text style={s.small}>{value === null ? 'À constater' : `◈ ${formatMind(value)}`}</Text></View>)}
      <Text style={s.small}>{position.proof ?? 'Aucun règlement confirmé pour ce round d’exemple.'}</Text>
    </Card>) : <EmptyState title="Tes premiers soutiens apparaîtront ici." />}
  </Screen>;
}
