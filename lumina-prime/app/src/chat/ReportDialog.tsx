import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput } from 'react-native';
import * as Crypto from 'expo-crypto';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '../ui/Primitives';
import { styles as s } from '../ui/theme';
import type { ChatMessage, ChatSession } from './client.ts';
import { draftReport, reportError, reportReasons, sendReport } from './report.ts';

export function ReportDialog({ message, session, visible, onClose }: { message: ChatMessage; session: ChatSession | null; visible: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState(() => draftReport(message, `report-${Crypto.randomUUID()}`));
  const [step, setStep] = useState<'edit' | 'review' | 'sending' | 'failed' | 'sent'>('edit');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const busy = useRef(false);
  async function submit() {
    if (busy.current) return;
    if (!session) { setError('Session expirée : attends la reconnexion puis réessaie ce signalement.'); setStep('failed'); return; }
    busy.current = true; setStep('sending'); setError('');
    try { const result = await sendReport(session, draft); setReceipt(String(result.at)); setStep('sent'); }
    catch (reason) { setError(reportError(reason)); setStep('failed'); }
    finally { busy.current = false; }
  }
  const close = () => { if (!busy.current) onClose(); };
  return <Modal visible={visible} animationType="slide" onRequestClose={close}>
    <SafeAreaView style={s.page}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 14 }}>
          <Text accessibilityRole="header" style={s.title}>Signaler cette réponse</Text>
          <Text style={s.body}>Destination : boîte locale du Wake appairé, sur ton PC. Aucun envoi à une équipe externe. Seuls la réponse ci-dessous, son identifiant/version, le motif et ton commentaire seront déposés.</Text>
          <Text style={s.small}>Réponse {draft.messageId} · version {draft.version}</Text>
          {message.text.length > 12000 ? <Text style={s.small}>Réponse longue : seuls les 12 000 premiers caractères ci-dessous seront déposés.</Text> : null}
          <Text selectable style={s.body}>{draft.text}</Text>
          {step === 'edit' ? <>
            <Text style={s.strong}>Motif</Text>
            {(Object.keys(reportReasons) as (keyof typeof reportReasons)[]).map(reason =>
              <Button key={reason} secondary={draft.reason !== reason} title={`${draft.reason === reason ? '✓ ' : ''}${reportReasons[reason]}`}
                onPress={() => setDraft(value => ({ ...value, reason }))} />)}
            <TextInput accessibilityLabel="Commentaire facultatif du signalement" style={s.input} multiline maxLength={1000}
              placeholder="Commentaire facultatif — évite les données personnelles" value={draft.comment}
              onChangeText={comment => setDraft(value => ({ ...value, comment }))} />
            <Button title="Vérifier avant envoi" onPress={() => setStep('review')} />
          </> : <>
            <Text style={s.strong}>Motif : {reportReasons[draft.reason]}</Text>
            <Text selectable style={s.body}>Commentaire : {draft.comment || '(aucun)'}</Text>
            {step === 'review' ? <>
              <Button title="Confirmer le dépôt local" onPress={() => { void submit(); }} />
              <Button secondary title="Modifier" onPress={() => setStep('edit')} />
            </> : null}
            {step === 'sending' ? <Text accessibilityLiveRegion="polite" style={s.body}>Dépôt en cours…</Text> : null}
            {step === 'failed' ? <>
              <Text accessibilityRole="alert" style={s.body}>{error}</Text>
              <Text style={s.small}>Le dépôt peut avoir eu lieu si l’accusé a été perdu. Cette reprise conserve exactement les mêmes données et le même identifiant.</Text>
              <Button title="Réessayer le même signalement" onPress={() => { void submit(); }} />
            </> : null}
            {step === 'sent' ? <Text accessibilityLiveRegion="polite" style={s.body}>Signalement enregistré dans la boîte locale du Wake à {receipt}. Aucune lecture ni prise en charge par une équipe n’est confirmée. Référence : {draft.id}</Text> : null}
          </>}
          <Button secondary disabled={step === 'sending'} title={step === 'edit' || step === 'review' ? 'Annuler sans envoyer' : 'Fermer'} onPress={close} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
