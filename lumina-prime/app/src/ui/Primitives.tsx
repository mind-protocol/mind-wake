import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMind } from '../state/AppState';
import type { Creator } from '../data/types.ts';
import { colors, styles as s } from './theme';
import { parseRich, type Inline } from '../chat/client.ts';

export function Button({ title, onPress, secondary = false, disabled = false, icon }: {
  title: string; onPress: () => void; secondary?: boolean; disabled?: boolean; icon?: keyof typeof Ionicons.glyphMap;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [secondary ? s.secondary : s.button, { opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}>
    <View style={s.row}>{icon ? <Ionicons name={icon} size={17} color={secondary ? colors.ink : colors.paper} /> : null}
      <Text style={secondary ? s.secondaryText : s.buttonText}>{title}</Text></View>
  </Pressable>;
}

export function Header() {
  const { mode, setMode } = useMind();
  return <View style={[s.between, { marginBottom: 2 }]}>
    <View style={s.row}><View style={{ width: 38, height: 38, borderRadius: 13, backgroundColor: colors.dark, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: 25, color: colors.green }}>◈</Text></View><View><Text style={{ color: colors.ink, fontSize: 19, fontWeight: '800', letterSpacing: 1 }}>MIND</Text><Text style={{ color: colors.muted, fontSize: 10 }}>DÉCOUVRIR · SOUTENIR</Text></View></View>
    <View style={{ backgroundColor: colors.soft, padding: 3, borderRadius: 20, flexDirection: 'row' }} accessibilityRole="radiogroup">
      {(['demo', 'live'] as const).map(value => <Pressable key={value} onPress={() => setMode(value)} accessibilityRole="radio" accessibilityState={{ checked: mode === value }}
        style={{ backgroundColor: mode === value ? colors.paper : 'transparent', borderRadius: 17, paddingVertical: 8, paddingHorizontal: 12 }}>
        <Text style={{ color: mode === value ? colors.ink : colors.muted, fontWeight: '600', fontSize: 11 }}>{value === 'demo' ? 'Démo' : 'Réel'}</Text>
      </Pressable>)}
    </View>
  </View>;
}

export function DemoNotice() {
  const { mode, status } = useMind();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 11, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: mode === 'demo' ? '#EBE7DA' : '#E2ECDD' }}>
    <Ionicons name={mode === 'demo' ? 'flask-outline' : 'radio-outline'} size={13} color={colors.muted} />
    <Text style={{ color: colors.muted, fontSize: 10, flex: 1 }}>{mode === 'demo' ? 'DÉMONSTRATION · profils et montants fictifs · aucun paiement' : status === 'ready' ? 'DEVNET · données reçues du compte connecté' : 'DEVNET · compte non connecté · soldes inconnus'}</Text>
  </View>;
}

export function Screen({ children }: { children: React.ReactNode }) {
  return <SafeAreaView edges={['top', 'left', 'right']} style={s.page}>
    <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <Header /><DemoNotice />{children}
    </ScrollView>
  </SafeAreaView>;
}

export function Avatar({ person, size = 52 }: { person: Pick<Creator, 'initials' | 'color'>; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size * 0.36, backgroundColor: person.color, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
    <View style={{ position: 'absolute', width: size * 0.85, height: size * 0.85, borderRadius: size, backgroundColor: '#FFFFFF55', top: -size * 0.3, right: -size * 0.25 }} />
    <Text style={{ color: colors.ink, fontSize: size * 0.46, fontWeight: '600' }}>{person.initials}</Text>
  </View>;
}

export function Sparkline({ values, height = 35, color = colors.dark }: { values: number[]; height?: number; color?: string }) {
  const max = Math.max(...values, 1);
  return <View accessibilityLabel="Illustration de la progression des signaux" style={{ height, flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
    {values.map((value, index) => <View key={index} style={{ width: 5, height: Math.max(4, value / max * height), borderRadius: 3, backgroundColor: color, opacity: 0.28 + 0.72 * index / values.length }} />)}
  </View>;
}

export function SectionHeading({ eyebrow, title, action, onAction }: { eyebrow?: string; title: string; action?: string; onAction?: () => void }) {
  return <View style={s.between}><View style={{ gap: 5, flex: 1 }}>{eyebrow ? <Text style={s.eyebrow}>{eyebrow}</Text> : null}<Text style={s.title}>{title}</Text></View>
    {action && onAction ? <Pressable accessibilityRole="button" onPress={onAction} hitSlop={10}><Text style={{ color: colors.ink, fontSize: 12, fontWeight: '700' }}>{action} ↗</Text></Pressable> : null}
  </View>;
}

export function EmptyState({ title = 'Ton radar se prépare.', message }: { title?: string; message?: string }) {
  const { status, error, reload } = useMind();
  return <View style={[s.card, { paddingVertical: 30, alignItems: 'center' }]}>
    {status === 'loading' ? <ActivityIndicator color={colors.ink} /> : <Ionicons name="planet-outline" size={38} color={colors.muted} />}
    <Text style={[s.title, { textAlign: 'center' }]}>{title}</Text>
    <Text style={[s.subtitle, { textAlign: 'center' }]}>{message ?? error ?? 'Les signaux et soldes apparaîtront une fois ton compte relié.'}</Text>
    {status === 'unavailable' ? <Button title="Réessayer" onPress={reload} secondary /> : null}
  </View>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) { return <View style={[s.card, style]}>{children}</View>; }

const open = (url: string) => { void Linking.openURL(url).catch(() => {}); };

function Span({ item, onLinkPress }: { item: Inline; onLinkPress?: (url: string) => void }) {
  if (item.kind === 'bold') return <Text style={{ fontWeight: '700' }}>{item.text}</Text>;
  if (item.kind === 'italic') return <Text style={{ fontStyle: 'italic' }}>{item.text}</Text>;
  if (item.kind === 'code') return <Text style={{ fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    backgroundColor: 'rgba(0,0,0,0.07)', fontSize: 13 }}>{item.text}</Text>;
  if (item.kind === 'link') return <Text accessibilityRole="link" onPress={() => (onLinkPress ?? open)(item.url!)}
    style={{ color: '#1F5FA8', textDecorationLine: 'underline' }}>{item.text}</Text>;
  return <>{item.text}</>;
}

function InlineImage({ url, alt, onPress }: { url: string; alt: string; onPress?: (url: string) => void }) {
  const [ratio, setRatio] = useState(4 / 3);
  const [failed, setFailed] = useState(false);
  useEffect(() => { Image.getSize(url, (w, h) => { if (w > 0 && h > 0) setRatio(w / h); }, () => {}); }, [url]);
  if (failed) return <Text style={s.small} onPress={() => open(url)}>🖼 {alt || url}</Text>;
  return <Pressable accessibilityRole="imagebutton" accessibilityLabel={alt || 'Image'} onPress={() => (onPress ?? open)(url)}>
    <Image source={{ uri: url }} onError={() => setFailed(true)} resizeMode="contain"
      style={{ width: 260, maxWidth: '100%', aspectRatio: ratio, borderRadius: 10, backgroundColor: colors.soft }} />
  </Pressable>;
}

/** Fichier partagé par un agent : carte touchable → lecteur (.md dans l'app, .pdf dans la visionneuse du téléphone). */
function FileCard({ path, name, type }: { path: string; name: string; type: 'md' | 'pdf' | 'other' }) {
  const viewable = type !== 'other';
  return <Pressable accessibilityRole="button" accessibilityLabel={`Ouvrir ${name}`} disabled={!viewable}
    onPress={() => router.push({ pathname: '/file', params: { path } })}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1,
      borderColor: colors.line, backgroundColor: pressed ? colors.soft : 'rgba(255,255,255,0.75)', maxWidth: 300 })}>
    <Ionicons name={type === 'pdf' ? 'document-attach-outline' : 'document-text-outline'} size={24} color={colors.ink} />
    <View style={{ flexShrink: 1 }}>
      <Text numberOfLines={2} style={{ color: colors.ink, fontWeight: '700', fontSize: 13 }}>{name}</Text>
      <Text style={s.small}>{type === 'md' ? 'Document · toucher pour lire' : type === 'pdf' ? 'PDF · toucher pour ouvrir' : 'Fichier · aperçu indisponible'}</Text>
    </View>
  </Pressable>;
}

/** Texte de bulle (Chat et Appel) : markdown simple (gras, italique, code, liens, sauts de ligne) et images en ligne ; sélectionnable. */
/** `onImagePress` : ouvrir l'image en grand dans l'écran (Appel) plutôt que dans le navigateur. */
export function RichText({ text, onImagePress, onLinkPress }: { text: string; onImagePress?: (url: string) => void; onLinkPress?: (url: string) => void }) {
  const blocks = useMemo(() => parseRich(text), [text]);
  if (!blocks.length) return <Text selectable style={s.body}>{text}</Text>;
  return <View style={{ gap: 6 }}>
    {blocks.map((block, index) => block.kind === 'image'
      ? <InlineImage key={index} url={block.url} alt={block.alt} onPress={onImagePress} />
      : block.kind === 'file' ? <FileCard key={index} path={block.path} name={block.name} type={block.type} />
      : <Text key={index} selectable style={s.body}>{block.inlines.map((item, i) => <Span key={i} item={item} onLinkPress={onLinkPress} />)}</Text>)}
  </View>;
}
