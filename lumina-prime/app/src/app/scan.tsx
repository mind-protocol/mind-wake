import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useMind } from '../state/AppState';
import { detectPaymentCandidates, REPAIR_LABELS, type Candidate } from '../intake/detect.ts';
import { getOcrEngine } from '../intake/ocr-engine.ts';
import { Button, Card, Screen } from '../ui/Primitives';
import { colors, styles as s } from '../ui/theme';

type Source = 'capture' | 'collage';

export default function ScanScreen() {
  const router = useRouter(); const { snapshot } = useMind();
  const engine = useMemo(() => getOcrEngine(), []);
  const [text, setText] = useState(''); const [source, setSource] = useState<Source>('collage');
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<string | null>(null);
  const known = useMemo(() => new Set(snapshot.creators.map(person => person.username)), [snapshot.creators]);
  const detection = useMemo(() => detectPaymentCandidates(text, source === 'capture' ? 'ocr' : 'unknown'), [text, source]);

  async function pickAndRead() {
    setNotice(null);
    let picked: ImagePicker.ImagePickerResult;
    try { picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 1 }); }
    catch { setNotice('La galerie n’a pas pu s’ouvrir ici. Colle le texte de la capture ci-dessous.'); return; }
    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0] as ImagePicker.ImagePickerAsset & { file?: Blob };
    setBusy(true);
    try {
      const read = await engine.recognize({ uri: asset.uri, file: asset.file ?? null, mimeType: asset.mimeType ?? null });
      setText(read); setSource('capture');
      setNotice(read.trim() ? 'Texte lu. Vérifie-le et corrige-le si besoin : la lecture peut se tromper.' : 'Aucun texte lisible dans cette image.');
    } catch (error) {
      setNotice(`Lecture impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}. Tu peux coller le texte ci-dessous.`);
    } finally { setBusy(false); }
  }

  function prepare(candidate: Candidate) {
    router.push({ pathname: '/compose/[username]', params: { username: candidate.recipientUsername, amount: candidate.amount, via: source } });
  }

  return <Screen>
    <Pressable accessibilityRole="button" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={s.row}><Ionicons name="close" size={21} color={colors.ink} /><Text style={s.small}>Fermer</Text></Pressable>
    <View style={{ gap: 9 }}><Text style={s.eyebrow}>LIRE UNE CAPTURE</Text><Text style={s.heading}>Repère un soutien.</Text>
      <Text style={s.subtitle}>Une capture ou un texte collé peut contenir « +10 MIND @alice ». L’app te propose de préparer ce soutien ; elle ne paie jamais à ta place.</Text></View>

    <Card><Text style={s.eyebrow}>DEPUIS UNE IMAGE</Text>
      {engine.available ? <>
        <Text style={s.small}>Moteur : {engine.label}. L’image est lue sur ton appareil.</Text>
        <Button title={busy ? 'Lecture en cours…' : 'Choisir une capture'} icon="image-outline" onPress={pickAndRead} disabled={busy} />
        {busy ? <ActivityIndicator color={colors.ink} /> : null}
      </> : <Text accessibilityRole="alert" style={[s.small, { color: colors.danger }]}>{engine.reason}</Text>}
    </Card>

    <View style={{ gap: 10 }}><Text style={s.eyebrow}>TEXTE LU OU COLLÉ</Text>
      <TextInput accessibilityLabel="Texte de la capture" multiline value={text} placeholder="Colle ici le texte d’un post, par exemple : +10 MIND @alice"
        onChangeText={value => { setText(value); if (!value) setSource('collage'); setNotice(null); }}
        style={[s.input, { minHeight: 140, textAlignVertical: 'top', fontSize: 15, lineHeight: 22, padding: 16 }]} />
      {detection.truncated ? <Text style={s.small}>Texte très long : seuls les 20 000 premiers caractères sont analysés.</Text> : null}
    </View>
    {notice ? <Text accessibilityLiveRegion="polite" style={[s.body, { padding: 14, backgroundColor: colors.soft, borderRadius: 12 }]}>{notice}</Text> : null}

    {text.trim() ? <View style={{ gap: 10 }}>
      <Text style={s.eyebrow}>{detection.candidates.length ? `COMMANDE${detection.candidates.length > 1 ? 'S' : ''} REPÉRÉE${detection.candidates.length > 1 ? 'S' : ''}` : 'AUCUNE COMMANDE REPÉRÉE'}</Text>
      {detection.candidates.map(candidate => <Card key={candidate.key}>
        <View style={s.between}><Text style={s.amount}>{candidate.amount} ◈</Text><Text style={s.strong}>@{candidate.recipientUsername}</Text></View>
        <Text style={s.small}>Lu : « {candidate.excerpt} »{candidate.occurrences > 1 ? ` (×${candidate.occurrences})` : ''}</Text>
        {candidate.repairs.map(repair => <Text key={repair} style={[s.small, { color: colors.danger }]}>À vérifier : {REPAIR_LABELS[repair]}</Text>)}
        {known.has(candidate.recipientUsername) ? <Button title="Préparer ce soutien" icon="create-outline" onPress={() => prepare(candidate)} />
          : <Text style={s.small}>@{candidate.recipientUsername} ne fait pas partie des profils disponibles : le compositeur ne peut pas encore le préparer.</Text>}
      </Card>)}
      {detection.rejected.map((fragment, index) => <Text key={`${fragment.excerpt}-${index}`} style={s.small}>Ignoré : « {fragment.excerpt} » — {fragment.reason}</Text>)}
      <Text style={s.small}>Une commande repérée est une intention, pas une autorisation. Le compositeur s’ouvre pré-rempli : tu relis montant et destinataire, puis tu décides.</Text>
    </View> : null}
  </Screen>;
}
