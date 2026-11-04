import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMind } from '../../state/AppState';
import { formatMind } from '../../data/logic.ts';
import { Card, EmptyState, Screen, SectionHeading } from '../../ui/Primitives';
import { colors, styles as s } from '../../ui/theme';

export default function ActivityScreen() {
  const { snapshot, drafts, mode, status } = useMind();
  const isDemo = mode === 'demo';
  const hasRead = mode === 'live' && snapshot.mode === 'live' && status === 'ready';
  const receipts = isDemo || hasRead ? snapshot.receipts : [];
  const observedAt = snapshot.observedAt && Number.isFinite(Date.parse(snapshot.observedAt))
    ? new Date(snapshot.observedAt).toLocaleString('fr-FR') : null;
  return <Screen><View style={{ gap: 9 }}><Text style={s.eyebrow}>UNE TRACE POUR CHAQUE GESTE</Text><Text style={s.heading}>Tes mouvements.</Text><Text style={s.subtitle}>Brouillons, intentions et paiements gardent chacun leur place.</Text></View>
    <SectionHeading title="Brouillons de cette session" />
    {drafts.length ? drafts.map(draft => <Card key={draft.id}><View style={s.between}><Text style={s.strong}>Pour {draft.name}</Text><View style={s.pill}><Text style={s.pillText}>Non publié</Text></View></View><Text style={s.body}>{draft.text}</Text><Text style={s.small}>Aucun paiement lancé · brouillon conservé jusqu’au rechargement de l’app.</Text></Card>) : <Text style={s.small}>Un post que tu prépares peut rester ici avant de le partager.</Text>}
    <SectionHeading title={isDemo ? 'Reçus de démonstration' : 'Tes reçus'} />
    <Text style={s.small}>{isDemo ? 'Reçus fictifs · aucun paiement effectué.' : hasRead ? `États déclarés par le service devnet${observedAt ? ` · observation du ${observedAt}` : ' · date d’observation non fournie'}.` : status === 'loading' ? 'Lecture des reçus en cours…' : 'Reçus indisponibles tant que le compte n’a pas pu être lu.'}</Text>
    {receipts.length ? receipts.map(receipt => <Card key={receipt.id}><View style={s.between}><View style={s.pill}><Text style={s.pillText}>{isDemo ? 'Exemple · ' : ''}{receipt.status === 'confirmed' ? 'Confirmé' : 'En attente'}</Text></View><Text style={s.small}>{isDemo ? 'Fictif' : 'Devnet'}</Text></View><View style={s.row}>
      <View style={{ backgroundColor: receipt.status === 'confirmed' ? colors.green : colors.soft, borderRadius: 13, padding: 11 }}><Ionicons name={receipt.status === 'confirmed' ? 'checkmark' : 'time-outline'} color={colors.ink} size={20} /></View>
      <View style={[s.grow, { gap: 5 }]}><Text style={s.strong}>{receipt.title}</Text><Text style={s.small}>{receipt.detail}</Text></View>
      <Text style={[s.body, { fontWeight: '700' }]}>{receipt.amount === null ? '—' : `${formatMind(receipt.amount)} ◈`}</Text>
    </View><Text style={s.small}>{Number.isFinite(Date.parse(receipt.at)) ? new Date(receipt.at).toLocaleString('fr-FR') : 'Date du reçu non fournie'}</Text>
      {receipt.id ? <Text style={s.small}>Référence {isDemo ? 'fictive' : 'du service'} : {receipt.id}</Text> : null}
      <Text style={s.small}>{isDemo ? 'Cet exemple ne constitue pas une preuve de paiement.' : receipt.status === 'pending' ? 'En attente de confirmation du service. Ce reçu ne confirme pas un paiement.' : 'Confirmation déclarée par le service. Aucune preuve de transaction réseau n’est fournie dans ce reçu.'}</Text>
    </Card>) : <EmptyState title={isDemo ? 'Aucun reçu de démonstration.' : status === 'loading' ? 'Lecture des reçus…' : hasRead ? 'Aucun reçu dans cette lecture.' : 'Reçus non disponibles.'} message={hasRead ? 'Le service n’a retourné aucun reçu à cette lecture.' : undefined} />}
  </Screen>;
}
