import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../../auth/useAuth.ts';
import { PROVIDER_LABELS } from '../../auth/providers.ts';
import { useMind } from '../../state/AppState';
import { formatMind } from '../../data/logic.ts';
import { Button, Card, Screen, SectionHeading } from '../../ui/Primitives';
import { colors, styles as s } from '../../ui/theme';

export default function AccountScreen() {
  const { snapshot, mode, status, error, reload, setMode } = useMind();
  const auth = useAuth(); const router = useRouter();
  const linked = auth.session.status === 'signed_in' ? auth.session.session.identity : null;
  const linkedX = auth.session.status === 'signed_in' ? (auth.session.session.identities ?? [auth.session.session.identity]).find(item => item.provider === 'x') : undefined;
  const isDemo = mode === 'demo';
  const hasRead = mode === 'live' && snapshot.mode === 'live' && status === 'ready';
  const balance = isDemo || hasRead ? snapshot.balance : null;
  const observedAt = snapshot.observedAt && Number.isFinite(Date.parse(snapshot.observedAt))
    ? new Date(snapshot.observedAt).toLocaleString('fr-FR') : null;
  const balanceLabel = isDemo ? 'SOLDE D’EXEMPLE' : status === 'loading' ? 'LECTURE EN COURS' : balance === null ? 'SOLDE INCONNU' : 'SOLDE LU · DEVNET';
  const balanceDetail = isDemo ? 'Montant fictif pour explorer le parcours. Aucun fonds disponible.'
    : status === 'loading' ? 'Lecture du compte en cours. Aucun montant n’est présumé disponible.'
      : balance === null ? 'Solde inconnu. Aucun montant n’est présumé disponible.'
        : observedAt ? `Observé le ${observedAt} · jetons de test devnet.` : 'Montant reçu du service en lecture seule · date d’observation non fournie.';
  return <Screen><View style={{ gap: 9 }}><Text style={s.eyebrow}>TES DÉCISIONS, TES MOUVEMENTS</Text><Text style={s.heading}>Mon espace.</Text><Text style={s.subtitle}>L’argent et les autorisations, à ta portée.</Text></View>
    <Card style={{ backgroundColor: colors.dark, borderColor: colors.dark, padding: 25 }}>
      <View style={{ gap: 9 }}><Text style={{ color: '#BACBBF', fontSize: 12 }}>@{snapshot.username}</Text><Text style={{ color: colors.green, fontSize: 11 }}>{balanceLabel}</Text></View>
      <Text adjustsFontSizeToFit numberOfLines={1} style={{ color: colors.paper, fontSize: 55, fontWeight: '600', letterSpacing: -2 }}>◈ {formatMind(balance)}</Text>
      <Text style={{ color: '#BACBBF', fontSize: 12, lineHeight: 20 }}>{balanceDetail}</Text>
    </Card>
    <View style={s.row}><View style={s.grow}><Button title="Déposer" secondary disabled onPress={() => {}} icon="add-outline" /></View><View style={s.grow}><Button title="Retirer" secondary disabled onPress={() => {}} icon="arrow-up-outline" /></View></View>
    <Text style={s.small}>Dépôts et retraits seront disponibles après le raccordement au contrat. Aucune opération n’est effectuée dans ce prototype.</Text>
    <SectionHeading title="Connexion" />
    <Card><View style={s.row}><Ionicons name={linked ? 'person-circle-outline' : 'log-in-outline'} size={23} color={colors.ink} /><View style={[s.grow, { gap: 5 }]}><Text style={s.strong}>{linked ? `${PROVIDER_LABELS[linked.provider]} · ${linked.provider === 'whatsapp' ? linked.handle : `@${linked.handle}`}` : 'Se connecter'}</Text><Text style={s.small}>{auth.session.status === 'restoring' ? 'Lecture de la session…' : linked ? 'Identité vérifiée par le serveur MIND. Aucun paiement autorisé par cette connexion.' : 'X, Telegram ou WhatsApp, pour relier ton @username à MIND.'}</Text></View><View style={[s.pill, linked ? { backgroundColor: colors.green } : null]}><Text style={s.small}>{linked ? 'Connecté' : 'Non connecté'}</Text></View></View>
      <Button title={linked ? 'Gérer la connexion' : 'Se connecter'} secondary={!!linked} icon="log-in-outline" onPress={() => router.push('/login')} /></Card>
    <SectionHeading title="Tes autorisations" />
    <Card><View style={s.row}><Ionicons name="shield-checkmark-outline" size={23} color={colors.ink} /><View style={[s.grow, { gap: 5 }]}><Text style={s.strong}>Paiements</Text><Text style={s.small}>Aucun mandat de paiement actif. Une connexion sociale ne donne pas le droit de dépenser.</Text></View><View style={s.pill}><Text style={s.small}>Non autorisé</Text></View></View></Card>
    <Card><View style={s.row}><Ionicons name="logo-twitter" size={23} color={colors.ink} /><View style={[s.grow, { gap: 5 }]}><Text style={s.strong}>Compte X</Text><Text style={s.small}>{linkedX ? `Compte @${linkedX.handle} relié. Les posts restent des brouillons.` : 'Aucun compte X relié. Les posts restent des brouillons.'}</Text></View><View style={s.pill}><Text style={s.small}>{linkedX ? 'Relié' : 'Non connecté'}</Text></View></View></Card>
    <Card><View style={s.row}><Ionicons name="scan-outline" size={23} color={colors.ink} /><View style={[s.grow, { gap: 5 }]}><Text style={s.strong}>Capture & texte</Text><Text style={s.small}>Choisis une capture ou colle un texte pour repérer une commande. L’écran indique si l’OCR est disponible sur ton appareil. Rien n’est payé automatiquement.</Text></View></View><Button title="Lire une capture" secondary onPress={() => router.push('/scan')} /></Card>
    <Card><Text style={s.strong}>Avec Marco</Text><Text style={s.small}>Retrouve la conversation et les réponses de ton Wake.</Text><Button title="Discuter avec Marco" secondary icon="chatbubble-outline" onPress={() => router.push('/chat')} /></Card>
    <SectionHeading title="D’où viennent les données ?" />
    <Card><Text style={s.body}>{isDemo ? 'Tu explores un scénario fictif. Les personnes, signaux, soutiens et reçus sont des exemples clairement séparés de ton compte.' : status === 'loading' ? 'Lecture du compte en cours…' : hasRead ? 'Ces informations ont été reçues du service relié à ton compte, en lecture seule sur devnet. Un solde absent reste inconnu.' : error ?? 'La connexion à ton compte n’est pas encore configurée.'}</Text>
      <Button title={isDemo ? 'Lire mon compte' : status === 'loading' ? 'Lecture en cours…' : 'Actualiser'} secondary disabled={!isDemo && status === 'loading'} onPress={isDemo ? () => setMode('live') : reload} />
      <Text style={s.small}>Les adresses et clés des wallets ne sont jamais affichées par l’app.</Text>
    </Card>
  </Screen>;
}
