import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMind } from '../../state/AppState';
import { filterCreators } from '../../data/logic.ts';
import { referralOffer } from '../../referrals/offers.ts';
import { Avatar, Button, Card, EmptyState, Screen } from '../../ui/Primitives';
import { colors, styles as s } from '../../ui/theme';

function observedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date non fournie' : date.toLocaleString('fr-FR');
}

export default function RadarScreen() {
  const { snapshot, mode, status } = useMind(); const router = useRouter(); const { width } = useWindowDimensions();
  const [category, setCategory] = useState('Tout'); const [query, setQuery] = useState('');
  const people = filterCreators(snapshot.creators, category, query);
  return <Screen>
    <View style={{ gap: 10, paddingTop: 8 }}>
      <Text style={s.eyebrow}>INVITE UNE PERSONNE. FAIS GRANDIR TON RÉSEAU.</Text>
      <Text style={[s.heading, { fontSize: width > 700 ? 52 : 39, lineHeight: width > 700 ? 57 : 43 }]}>Ce que tu peux gagner.</Text>
      <Text style={[s.subtitle, { maxWidth: 540 }]}>Repère qui inviter et vois ta prime potentielle, personne par personne.</Text>
    </View>
    {mode === 'live' ? <Text style={s.small}>Aucune campagne rémunérée n’est encore disponible.</Text> : null}
    <View style={[s.input, s.row, { paddingVertical: 3 }]}><Ionicons name="search-outline" color={colors.muted} size={18} />
      <TextInput accessibilityLabel="Rechercher une personne ou une idée" placeholder="Qui voudrais-tu inviter ?" placeholderTextColor={colors.muted}
        value={query} onChangeText={setQuery} style={{ flex: 1, minHeight: 42, fontSize: 14, color: colors.ink }} autoCorrect={false} />
      {query ? <Pressable accessibilityRole="button" accessibilityLabel="Effacer la recherche" onPress={() => setQuery('')} hitSlop={10}><Ionicons name="close-circle" size={18} color={colors.muted} /></Pressable> : null}
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {['Tout', 'Créateurs', 'Bâtisseurs', 'Explorateurs'].map(item => <Pressable accessibilityRole="button" accessibilityState={{ selected: item === category }} key={item} onPress={() => setCategory(item)}
        style={{ paddingVertical: 10, paddingHorizontal: 16, backgroundColor: category === item ? colors.dark : 'transparent', borderWidth: 1, borderColor: category === item ? colors.dark : colors.line, borderRadius: 24 }}>
        <Text style={{ color: category === item ? colors.paper : colors.muted, fontSize: 12, fontWeight: '600' }}>{item}</Text>
      </Pressable>)}
    </ScrollView>
    {people.length ? <View style={{ flexDirection: width > 760 ? 'row' : 'column', flexWrap: 'wrap', gap: 16 }}>
      {people.map(person => {
        const offer = referralOffer(person.username, mode); const example = offer.status === 'example';
        return <Card key={person.username} style={{ flexGrow: 1, flexBasis: width > 760 ? '44%' : '100%', gap: 16, padding: 23 }}>
          <View style={s.row}><Avatar person={person} size={58} /><View style={[s.grow, { gap: 3 }]}>
            <Text style={[s.title, { fontSize: 24 }]}>{person.name}</Text><Text style={s.small}>@{person.username} · {person.role}</Text>
          </View></View>
          <View style={{ backgroundColor: example ? colors.green : colors.soft, borderRadius: 20, padding: 18, gap: 5 }}>
            <Text style={s.eyebrow}>{example ? 'POUR TOI, LE PARRAIN · EXEMPLE' : 'PRIME DE PARRAINAGE'}</Text>
            <Text style={{ color: colors.ink, fontSize: example ? 42 : 23, fontWeight: '700', letterSpacing: -1 }}>{example ? `+${offer.potentialTokens} ◈` : 'Montant non configuré'}</Text>
            <Text style={s.small}>{example ? `Après l’arrivée vérifiée de ${person.name}.` : 'Aucune offre financée disponible.'}</Text>
          </View>
          <Button title={`Inviter ${person.name}`} icon="person-add-outline" disabled={!example}
            onPress={() => router.push({ pathname: '/invite/[username]', params: { username: person.username, demo: '1' } })} />
          <View style={s.divider} /><Text style={s.strong}>{person.title}</Text>
          {person.signals[0] ? <View style={{ gap: 3 }}><Text style={s.small}>{person.signals[0].value} · {person.signals[0].label}</Text>
            <Text style={[s.small, { fontSize: 10 }]}>Source : {person.signals[0].source || 'Non fournie'}</Text>
            <Text style={[s.small, { fontSize: 10 }]}>{observedDate(person.signals[0].observedAt)}</Text></View> : <Text style={s.small}>Aucun signal documenté.</Text>}
          <Button secondary title={`Découvrir ${person.name}`} onPress={() => router.push({ pathname: '/creator/[username]', params: { username: person.username } })} icon="arrow-forward" />
        </Card>;
      })}
    </View> : snapshot.creators.length ? <EmptyState title="Une autre piste ?" message="Aucun profil ne correspond à cette recherche." />
      : <EmptyState title={status === 'loading' ? 'Lecture du radar…' : 'Aucun profil à inviter pour le moment.'} message={status === 'ready' ? 'La source connectée n’a transmis aucun profil. Aucune offre ne peut être proposée.' : undefined} />}
    <Text style={[s.small, { textAlign: 'center', fontSize: 10 }]}>{mode === 'demo' ? 'Source des offres : scénario de démonstration du 04/11/2026 · aucun budget réservé. Conditions réelles à fixer.' : 'Les signaux décrivent la source connectée. Ils ne prouvent ni prime disponible ni revenu futur.'}</Text>
  </Screen>;
}
