import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useWakeChat } from './WakeChatProvider';
import { ChatClientError, fileBlock, fileDownloadError, fileErrorMessage, fileUrl, parseInline, parseMarkdownDoc, readChatFile, resolveDocLink, type ChatSession, type DocBlock, type Inline } from './client.ts';
import { colors, styles as s } from '../ui/theme';
import { useReportedError } from './app-error-report.ts';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Lien d'un document : autre .md/.pdf (relatif au fichier ouvert) → ce lecteur ; lien web → navigateur. */
function openLink(base: string, url: string) {
  const local = resolveDocLink(base, url);
  if (local) { router.push({ pathname: '/file', params: { path: local } }); return; }
  if (/^https?:\/\//i.test(url)) void Linking.openURL(url).catch(() => {});
}

function Inlines({ text, style, base = '' }: { text: string; style?: object; base?: string }) {
  const items = useMemo(() => parseInline(text), [text]);
  return <Text selectable style={[s.body, style]}>{items.map((item: Inline, i) => item.kind === 'bold' ? <Text key={i} style={{ fontWeight: '700' }}>{item.text}</Text>
    : item.kind === 'italic' ? <Text key={i} style={{ fontStyle: 'italic' }}>{item.text}</Text>
    : item.kind === 'code' ? <Text key={i} style={{ fontFamily: mono, backgroundColor: 'rgba(0,0,0,0.07)', fontSize: 13 }}>{item.text}</Text>
    : item.kind === 'link' ? <Text key={i} accessibilityRole="link" onPress={() => openLink(base, item.url!)} style={{ color: '#1F5FA8', textDecorationLine: 'underline' }}>{item.text}</Text>
    : <React.Fragment key={i}>{item.text}</React.Fragment>)}</Text>;
}

/** Tableau markdown : grille à défilement horizontal, en-tête en gras, cellules avec markdown léger. */
function Table({ header, rows, base }: { header: string[]; rows: string[][]; base: string }) {
  const columns = Math.max(header.length, ...rows.map(row => row.length));
  const line = (cells: string[], head: boolean, key: number) => <View key={key} style={{ flexDirection: 'row', borderTopWidth: key ? 1 : 0, borderTopColor: colors.line,
    backgroundColor: head ? colors.soft : 'transparent' }}>
    {Array.from({ length: columns }, (_, c) => <View key={c} style={{ width: 150, padding: 8, borderLeftWidth: c ? 1 : 0, borderLeftColor: colors.line }}>
      <Inlines text={cells[c] ?? ''} base={base} style={{ fontSize: 13, lineHeight: 18, ...(head ? { fontWeight: '700' } : {}) }} /></View>)}
  </View>;
  return <ScrollView horizontal style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10 }}>
    <View>{header.length ? line(header, true, 0) : null}{rows.map((row, r) => line(row, false, r + (header.length ? 1 : 0)))}</View>
  </ScrollView>;
}

function Markdown({ source, base }: { source: string; base: string }) {
  const blocks = useMemo(() => parseMarkdownDoc(source), [source]);
  return <View style={{ gap: 10 }}>{blocks.map((block: DocBlock, i) => {
    if (block.kind === 'table') return <Table key={i} header={block.header} rows={block.rows} base={base} />;
    if (block.kind === 'heading') return <Inlines key={i} base={base} text={block.text} style={{ fontWeight: '800', marginTop: i ? 8 : 0,
      fontSize: [24, 20, 17, 15, 14, 14][block.level - 1], lineHeight: [30, 26, 23, 21, 20, 20][block.level - 1] }} />;
    if (block.kind === 'bullet') return <View key={i} style={{ flexDirection: 'row', gap: 8, paddingLeft: 4 + block.depth * 16 }}>
      <Text style={[s.body, { minWidth: 14 }]}>{block.marker}</Text><View style={{ flex: 1 }}><Inlines base={base} text={block.text} /></View></View>;
    if (block.kind === 'quote') return <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: colors.line, paddingLeft: 10 }}>
      <Inlines base={base} text={block.text} style={{ color: colors.muted }} /></View>;
    if (block.kind === 'code') return <ScrollView key={i} horizontal style={{ backgroundColor: colors.soft, borderRadius: 10 }} contentContainerStyle={{ padding: 10 }}>
      <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: colors.ink }}>{block.text}</Text></ScrollView>;
    if (block.kind === 'rule') return <View key={i} style={s.divider} />;
    return <Inlines key={i} base={base} text={block.text} />;
  })}</View>;
}

/** PDF : téléchargé (authentifié) dans le cache, puis aperçu natif (Quick Look / visionneuse Android) ou feuille de partage. */
async function openPdf(session: ChatSession, path: string, name: string) {
  const url = fileUrl(session, path);
  if (Platform.OS === 'web') {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` } });
    if (!response.ok) { let code = 'connection_lost'; try { code = (await response.json()).error ?? code; } catch { /* */ } throw new ChatClientError(code, response.status); }
    window.open(URL.createObjectURL(await response.blob()), '_blank'); return;
  }
  const target = new File(Paths.cache, `wake-${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`);
  let file: File;
  try { file = await File.downloadFileAsync(url, target, { headers: { Authorization: `Bearer ${session.token}` }, idempotent: true }); }
  catch (reason) { throw await fileDownloadError(session, path, reason); }
  const head = await file.slice(0, 5).text();
  if (head !== '%PDF-') {
    let code = 'connection_lost'; try { code = JSON.parse(await file.text()).error ?? code; } catch { /* */ }
    try { file.delete(); } catch { /* */ } throw new ChatClientError(code);
  }
  const preview = (file as unknown as { preview?: (options?: { mimeType?: string; title?: string }) => Promise<void>; canPreview?: (options?: { mimeType?: string }) => Promise<boolean> });
  try { if (preview.preview && (!preview.canPreview || await preview.canPreview({ mimeType: 'application/pdf' }))) { await preview.preview({ mimeType: 'application/pdf', title: name }); return; } } catch { /* aperçu absent de ce build : partage */ }
  if (!(await Sharing.isAvailableAsync())) throw new ChatClientError('share_unavailable');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: name });
}

export default function FileViewer() {
  const params = useLocalSearchParams<{ path?: string }>();
  const path = typeof params.path === 'string' ? params.path : '';
  const block = fileBlock(path);
  const name = block.kind === 'file' ? block.name : path;
  const type = block.kind === 'file' ? block.type : 'other';
  const { session } = useWakeChat();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useReportedError('fichier', error);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!session) { setError('Connexion au Chat Wake en cours… réessaie dans un instant.'); return; }
    setBusy(true); setError(null);
    try {
      if (type === 'md') setText(await readChatFile(session, path, signal));
      else if (type === 'pdf') await openPdf(session, path, name);
      else setError('Seuls les fichiers .md et .pdf s’ouvrent dans l’app.');
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof ChatClientError && reason.code === 'share_unavailable'
      ? 'Ce téléphone ne propose pas d’ouvrir ce PDF.' : fileErrorMessage(reason)); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, [session, path, type, name]);
  useEffect(() => { const controller = new AbortController(); const timer = setTimeout(() => { void load(controller.signal); }, 0);
    return () => { clearTimeout(timer); controller.abort(); }; }, [load]);
  return <SafeAreaView edges={['top', 'left', 'right']} style={s.page}>
    <View style={[s.row, { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Retour" hitSlop={12} onPress={() => router.canGoBack() ? router.back() : router.replace('/chat')}>
        <Ionicons name="chevron-back" size={24} color={colors.ink} /></Pressable>
      <Ionicons name={type === 'pdf' ? 'document-attach-outline' : 'document-text-outline'} size={18} color={colors.muted} />
      <Text numberOfLines={1} style={[s.strong, { flex: 1, fontSize: 15 }]}>{name}</Text>
    </View>
    <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 48, gap: 14 }}>
      {busy ? <ActivityIndicator color={colors.ink} /> : null}
      {error ? <View style={{ gap: 10 }}><Text style={[s.body, { color: colors.danger }]}>{error}</Text>
        <Pressable accessibilityRole="button" onPress={() => void load()} style={s.secondary}><Text style={s.secondaryText}>Réessayer</Text></Pressable></View> : null}
      {type === 'md' && text !== null ? <Markdown source={text} base={path} /> : null}
      {type === 'pdf' && !busy && !error ? <View style={{ gap: 10 }}><Text style={s.body}>Le PDF s’est ouvert dans la visionneuse du téléphone.</Text>
        <Pressable accessibilityRole="button" onPress={() => void load()} style={s.secondary}><Text style={s.secondaryText}>Rouvrir le PDF</Text></Pressable></View> : null}
      <Text selectable style={[s.small, { fontSize: 10 }]}>{path}</Text>
    </ScrollView>
  </SafeAreaView>;
}
