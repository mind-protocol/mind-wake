import React, { useMemo, useState } from 'react';
import { Linking, Pressable, Share, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as ExpoLinking from 'expo-linking';
import { Ionicons } from '@expo/vector-icons';
import { useMind } from '../../state/AppState';
import { buildGiftDraft, parseAmount, xDraftUrl } from '../../data/logic.ts';
import { preparePaymentCommand } from '../../domain/payment-command.ts';
import { composeLinkParts, issuesSummary, readComposeParams, shareMessage } from '../../intake/links.ts';
import { Avatar, Button, Card, EmptyState, Screen } from '../../ui/Primitives';
import { colors, styles as s } from '../../ui/theme';

export default function ComposeScreen() {
  const params = useLocalSearchParams<{ username: string; amount?: string; note?: string; via?: string }>(); const { snapshot, keepDraft, mode } = useMind(); const router = useRouter();
  const username = params.username;
  // Link/capture parameters only pre-fill the draft: invalid ones are ignored and listed.
  const [prefill] = useState(() => readComposeParams(params));
  const person = snapshot.creators.find(item => item.username === username);
  const [amount, setAmount] = useState(prefill.amount ?? '10'); const [edited, setEdited] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const calculated = useMemo(() => {
    if (!person) return { text: '', error: null };
    try { return { text: buildGiftDraft(prefill.note ? { ...person, title: prefill.note } : person, amount), error: null }; }
    catch (error) { return { text: '', error: error instanceof Error ? error.message : 'Montant invalide.' }; }
  }, [person, amount, prefill.note]);
  const text = edited ?? calculated.text;
  async function copy() { try { await Clipboard.setStringAsync(text); setNotice('Post copié. Tu peux le modifier avant de le publier.'); } catch { setNotice('La copie n’est pas disponible ici. Sélectionne le texte pour le copier.'); } }
  async function shareLink() {
    if (!person) return;
    const { path, queryParams } = composeLinkParts(person.username, { amount: calculated.error ? null : amount });
    const url = ExpoLinking.createURL(path, { queryParams });
    const message = shareMessage(person.name, person.username, url, queryParams.amount);
    try { await Share.share({ message }); setNotice('Partage demandé. Le lien ouvre un brouillon à relire, sans paiement.'); }
    catch {
      try { await Clipboard.setStringAsync(url); setNotice(`Partage indisponible ici : lien copié (${url}).`); }
      catch { setNotice(`Partage indisponible ici. Lien : ${url}`); }
    }
  }
  async function openX() { try { await Linking.openURL(xDraftUrl(text)); setNotice('Le compositeur X a été demandé. Aucun envoi n’est confirmé.'); } catch { setNotice('Impossible d’ouvrir X. Tu peux copier ton brouillon.'); } }
  const command = useMemo(() => {
    if (!person || calculated.error) return { error: null, preview: null };
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^(?:\+|◈|\$MIND\b)/.test(line));
    if (lines.length !== 1) return { error: 'Garde une seule commande de don dans ce brouillon.', preview: null };
    const result = preparePaymentCommand(lines[0], 'owner_direct');
    if (!result.ok) return { error: 'Corrige la commande : par exemple +10 MIND @alice.', preview: null };
    if (result.payment.recipientUsername !== person.username) return { error: 'Le destinataire du texte doit correspondre à la personne choisie.', preview: null };
    if (result.payment.amountAtomic !== parseAmount(amount).raw) return { error: 'Le montant du texte doit correspondre au montant choisi.', preview: null };
    return { error: null, preview: result.payment };
  }, [person, calculated.error, text, amount]);
  const valid = !!command.preview && !calculated.error && !command.error;
  return <Screen>
    <Pressable accessibilityRole="button" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={s.row}><Ionicons name="close" size={21} color={colors.ink} /><Text style={s.small}>Fermer le brouillon</Text></Pressable>
    {person ? <>
      <View style={{ gap: 9 }}><Text style={s.eyebrow}>TON GESTE, TES MOTS</Text><Text style={s.heading}>Donne de l’élan.</Text><Text style={s.subtitle}>Un post prêt à personnaliser, pour partager une découverte.</Text></View>
      <Card><View style={s.row}><Avatar person={person} /><View style={s.grow}><Text style={s.strong}>{person.name}</Text><Text style={s.small}>@{person.username}</Text></View><View style={s.badge}><Text style={s.badgeText}>Brouillon</Text></View></View>
        <View style={s.divider} /><Text style={s.eyebrow}>TYPE DE SOUTIEN</Text><View style={s.row}><View style={[s.pill, { backgroundColor: colors.green }]}><Text style={s.pillText}>Don</Text></View><View style={s.pill}><Text style={s.small}>Mise 24 h : à définir</Text></View></View>
        <Text style={s.small}>Le texte « +10 MIND » reste une proposition de syntaxe. Ce brouillon ne crée ni don, ni mise, ni paiement.</Text>
      </Card>
      {prefill.via ? <View accessibilityRole="alert" style={[s.card, { backgroundColor: colors.lavender, borderColor: colors.lavender, gap: 6 }]}>
        <Text style={s.strong}>{`Pré-rempli depuis ${prefill.via === 'capture' ? 'une capture' : prefill.via === 'collage' ? 'un texte collé' : 'un lien reçu'}`}</Text>
        <Text style={s.small}>C’est une intention repérée, pas une autorisation. Relis le montant et le destinataire : rien n’est envoyé sans ton action.</Text>
      </View> : null}
      {prefill.issues.length ? <Text accessibilityRole="alert" style={[s.small, { color: colors.danger }]}>{issuesSummary(prefill.issues)}</Text> : null}
      <Card><Text style={s.eyebrow}>MONTANT DU BROUILLON</Text><View style={s.row}><Text style={{ color: colors.ink, fontSize: 33 }}>◈</Text>
          <TextInput accessibilityLabel="Montant du soutien" value={amount} onChangeText={value => { setAmount(value); setNotice(null); }} keyboardType="decimal-pad" style={{ flex: 1, color: colors.ink, fontSize: 38, fontWeight: '600', minHeight: 55 }} /></View>
        <View style={s.row}>{['5', '10', '20'].map(value => <Pressable accessibilityRole="button" key={value} onPress={() => { setAmount(value); setNotice(null); }} style={[s.pill, amount === value ? { backgroundColor: colors.green } : {}]}><Text style={s.pillText}>{value} ◈</Text></Pressable>)}</View>
        {calculated.error ? <Text style={{ color: colors.danger }}>{calculated.error}</Text> : null}
      </Card>
      <View style={{ gap: 10 }}><Text style={s.eyebrow}>LE POST, À TA MANIÈRE</Text>
        <TextInput accessibilityLabel="Texte du post à personnaliser" multiline value={text} onChangeText={value => { setEdited(value); setNotice(null); }}
          style={[s.input, { minHeight: 180, textAlignVertical: 'top', fontSize: 16, lineHeight: 25, padding: 20 }]} />
        {command.error ? <Text style={{ color: colors.danger }}>{command.error}</Text> : null}
      </View>
      <View style={[s.card, { backgroundColor: colors.soft, borderColor: colors.soft, gap: 7 }]}>
        <Text style={s.strong}>Avant de partager</Text><Text style={s.small}>Destinataire : @{person.username} · Montant prévu : {calculated.error ? 'à corriger' : `${parseAmount(amount).decimal} ◈`} · Nature : don.</Text>
        {command.preview ? <Text style={s.small}>Commande reconnue : {command.preview.canonicalCommand}</Text> : <Text style={s.small}>Le montant et le destinataire du texte doivent correspondre à cet aperçu avant de le partager.</Text>}
        <Text style={s.small}>Un don sans contrepartie. Il n’ouvre aucune mise ni droit aux primes.</Text>
        <Text style={s.small}>Aucun fonds n’est engagé ici. Le paiement signé et la connexion à X ne sont pas raccordés dans ce prototype.{mode === 'demo' ? ' Profil fictif de démonstration.' : ''}</Text>
      </View>
      <Button title="Copier le post" icon="copy-outline" onPress={copy} disabled={!valid} />
      <Button title="Ouvrir le brouillon dans X" icon="open-outline" secondary onPress={openX} disabled={!valid} />
      <Button title="Garder dans mes brouillons" secondary disabled={!valid} onPress={() => { keepDraft({ username: person.username, name: person.name, amount: parseAmount(amount).decimal, text, kind: 'gift' }); setNotice('Ajouté aux brouillons de cette session.'); }} />
      <Button title="Partager le lien" icon="share-social-outline" secondary onPress={shareLink} />
      {notice ? <Text accessibilityLiveRegion="polite" style={[s.body, { padding: 14, backgroundColor: colors.green, borderRadius: 12 }]}>{notice}</Text> : null}
    </> : <EmptyState title="Choisis d’abord une personne." />}
  </Screen>;
}
