import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { Button, Card, Screen, SectionHeading } from '../ui/Primitives';
import { colors, styles as s } from '../ui/theme';
import type { AuthProviderId, FlowPhase } from '../auth/types.ts';
import { AUTH_PROVIDERS } from '../auth/types.ts';
import { PROVIDER_LABELS } from '../auth/providers.ts';
import { isBusy, providerView, type ProviderView } from '../auth/session.ts';
import { completeOAuthFromParams, hasPendingOAuth, providerConfig, resetFlow, signInWithOAuth, signOut, startWhatsApp, useAuth, verifyWhatsApp } from '../auth/useAuth.ts';
import { isPersistentStorage } from '../auth/storage.ts';

// Web : ferme la fenêtre popup d'auth et renvoie l'URL à la fenêtre parente.
WebBrowser.maybeCompleteAuthSession();

const ICONS: Record<AuthProviderId, keyof typeof Ionicons.glyphMap> = { x: 'logo-twitter', telegram: 'paper-plane-outline', whatsapp: 'logo-whatsapp' };
const VIEW_LABEL: Record<ProviderView, string> = { unconfigured: 'Non configuré', idle: 'Disponible', pending: 'En cours…', error: 'Erreur', connected: 'Connecté' };
const DESCRIPTIONS: Record<AuthProviderId, string> = {
  x: 'Relie ton @username X via la page d’autorisation officielle de X (lecture du profil uniquement).',
  telegram: 'Relie ton compte Telegram via la connexion officielle Telegram (OpenID Connect).',
  whatsapp: 'Prouve que tu contrôles ton numéro WhatsApp avec un code à usage unique.',
};

export default function LoginScreen() {
  const auth = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string }>();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');

  // Retour par lien profond (mindlumina://login?code=…&state=…) quand la session navigateur ne l'a pas capturé.
  useEffect(() => {
    if ((params.code || params.error) && hasPendingOAuth()) {
      const flat: Record<string, string> = {};
      for (const key of ['code', 'state', 'error'] as const) { const value = params[key]; if (typeof value === 'string') flat[key] = value; }
      void completeOAuthFromParams(flat);
    }
  }, [params.code, params.state, params.error]); // eslint-disable-line react-hooks/exhaustive-deps

  const signedIn = auth.session.status === 'signed_in' ? auth.session.session : null;
  const identities = signedIn ? signedIn.identities ?? [signedIn.identity] : [];
  const busy = isBusy(auth.flow);
  const flow = auth.flow;

  return <Screen>
    <Pressable accessibilityRole="button" onPress={() => (router.canGoBack() ? router.back() : router.replace('/account'))} hitSlop={10} style={s.row}>
      <Ionicons name="chevron-back" size={18} color={colors.ink} /><Text style={s.strong}>Mon espace</Text>
    </Pressable>
    <View style={{ gap: 9 }}>
      <Text style={s.eyebrow}>CONNEXION · INSCRIPTION</Text>
      <Text style={s.heading}>{signedIn ? 'Tes comptes, une identité.' : 'Relie ton compte.'}</Text>
      <Text style={s.subtitle}>Ton identité X, Telegram ou WhatsApp sert à recevoir et préparer des soutiens. Se connecter n’autorise aucun paiement.</Text>
    </View>

    {auth.session.status === 'restoring' ? <Card><View style={s.row}><ActivityIndicator color={colors.ink} /><Text style={s.body}>Lecture de la session enregistrée…</Text></View></Card> : null}

    {signedIn ? <Card style={{ backgroundColor: colors.dark, borderColor: colors.dark }}>
      <Text style={{ color: colors.green, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 }}>{signedIn.mindUserId ? 'TON IDENTITÉ MIND' : 'COMPTE CONNECTÉ'}</Text>
      {identities.map(item => <View key={`${item.provider}:${item.providerUserId}`} style={{ gap: 4 }}><Text style={{ color: colors.paper, fontSize: 23, fontWeight: '700' }}>{PROVIDER_LABELS[item.provider]} · {item.provider === 'whatsapp' ? item.handle : `@${item.handle}`}</Text>{item.displayName ? <Text style={{ color: '#BACBBF', fontSize: 13 }}>{item.displayName}</Text> : null}</View>)}
      <Text style={{ color: '#BACBBF', fontSize: 12, lineHeight: 18 }}>Vérifié par le serveur MIND le {new Date(signedIn.identity.verifiedAt).toLocaleString('fr-FR')}. Session valable jusqu’au {new Date(signedIn.expiresAt).toLocaleString('fr-FR')}.{isPersistentStorage() ? '' : ' Sur le web, la session n’est pas conservée après rechargement.'}</Text>
      <View style={s.row}>
        <View style={s.grow}><Button title="Retour à mon espace" onPress={() => (router.canGoBack() ? router.back() : router.replace('/account'))} /></View>
        <View style={s.grow}><Button title="Se déconnecter" secondary onPress={() => { void signOut(); }} icon="log-out-outline" /></View>
      </View>
    </Card> : null}

    <SectionHeading title={signedIn ? 'Relier un autre compte' : 'Choisis un fournisseur'} />
    {AUTH_PROVIDERS.map(provider => {
      const config = providerConfig(provider);
      const view = providerView(auth, provider, config.configured);
      const errorMessage = flow.phase === 'error' && flow.provider === provider ? flow.message : null;
      return <Card key={provider}>
        <View style={s.row}>
          <Ionicons name={ICONS[provider]} size={24} color={colors.ink} />
          <View style={[s.grow, { gap: 4 }]}><Text style={s.strong}>{PROVIDER_LABELS[provider]}</Text><Text style={s.small}>{DESCRIPTIONS[provider]}</Text></View>
          <View style={[s.pill, view === 'connected' ? { backgroundColor: colors.green } : view === 'error' ? { backgroundColor: '#F4D9D2' } : null]}><Text style={s.pillText}>{VIEW_LABEL[view]}</Text></View>
        </View>

        {!config.configured ? <Text accessibilityRole="alert" style={s.small}>Cette connexion n’est pas encore activée. Tu peux explorer l’app sans relier de compte.</Text> : null}
        {errorMessage ? <Text accessibilityRole="alert" style={[s.small, { color: colors.danger }]}>{errorMessage}</Text> : null}
        {view === 'pending' && flow.phase !== 'awaiting_code' && flow.phase !== 'awaiting_wa_message' ? <View style={s.row}><ActivityIndicator color={colors.ink} /><Text style={s.small}>{flow.phase === 'opening' ? 'Page de connexion ouverte…' : flow.phase === 'exchanging' ? 'Vérification par le serveur MIND…' : 'Vérification en cours…'}</Text></View> : null}

        {config.configured && provider !== 'whatsapp' && view !== 'pending' ? <Button title={view === 'connected' ? `Vérifier ${PROVIDER_LABELS[provider]}` : view === 'error' ? 'Réessayer' : signedIn ? `Relier ${PROVIDER_LABELS[provider]} à MIND` : `Continuer avec ${PROVIDER_LABELS[provider]}`} secondary={view === 'connected'} disabled={busy} icon={ICONS[provider]} onPress={() => { void signInWithOAuth(provider, { link: !!signedIn }); }} /> : null}

        {config.configured && provider === 'whatsapp' && view !== 'connected' ? <WhatsAppBlock flow={flow} phone={phone} setPhone={setPhone} otp={otp} setOtp={setOtp} busy={busy} linking={!!signedIn} /> : null}
      </Card>;
    })}

    <Text style={s.small}>Aucun mot de passe ni secret n’est stocké dans l’app : le code d’autorisation est vérifié par le serveur MIND, qui renvoie une session. Les messages détectés sur X, Telegram ou WhatsApp ne valent jamais autorisation de paiement.</Text>
  </Screen>;

}

function WhatsAppBlock({ flow, phone: value, setPhone: set, otp: code, setOtp: setCode, busy: disabled, linking }: { flow: FlowPhase; phone: string; setPhone: (v: string) => void; otp: string; setOtp: (v: string) => void; busy: boolean; linking: boolean }) {
  if (flow.phase === 'awaiting_code') return <View style={{ gap: 10 }}>
    <Text style={s.body}>Code envoyé sur WhatsApp au {flow.maskedPhone}. Il expire à {new Date(flow.expiresAt).toLocaleTimeString('fr-FR')}.</Text>
    {flow.notice ? <Text accessibilityRole="alert" style={[s.small, { color: colors.danger }]}>{flow.notice}</Text> : null}
    <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} placeholder="6 chiffres" accessibilityLabel="Code WhatsApp" style={inputStyle} />
    <View style={s.row}><View style={s.grow}><Button title="Valider le code" disabled={disabled || code.trim().length !== 6} onPress={() => { void verifyWhatsApp(code); }} /></View>
      <Pressable accessibilityRole="button" onPress={() => { setCode(''); resetFlow(); }} hitSlop={10}><Text style={s.small}>Changer de numéro</Text></Pressable></View>
  </View>;
  if (flow.phase === 'awaiting_wa_message') return <View style={{ gap: 10 }}>
    <Text style={s.body}>Envoie le message « MIND {flow.userCode} » au compte WhatsApp de MIND depuis ton numéro, puis reviens ici.</Text>
    {flow.notice ? <Text accessibilityRole="alert" style={[s.small, { color: colors.danger }]}>{flow.notice}</Text> : null}
    <Button title="Ouvrir WhatsApp" icon="logo-whatsapp" onPress={() => { Linking.openURL(flow.waLink).catch(() => undefined); }} />
    <Button title="J’ai envoyé le message" secondary disabled={disabled} onPress={() => { void verifyWhatsApp(); }} />
  </View>;
  return <View style={{ gap: 10 }}>
    <TextInput value={value} onChangeText={set} keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" placeholder="+33 6 12 34 56 78" accessibilityLabel="Numéro WhatsApp" style={inputStyle} />
    <Button title={flow.phase === 'error' && flow.provider === 'whatsapp' ? 'Renvoyer un code' : linking ? 'Relier mon WhatsApp' : 'Recevoir un code WhatsApp'} icon="logo-whatsapp" disabled={disabled || value.trim().length < 8} onPress={() => { void startWhatsApp(value, { link: linking }); }} />
  </View>;
}

const inputStyle = { borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: colors.ink, backgroundColor: colors.paper } as const;
