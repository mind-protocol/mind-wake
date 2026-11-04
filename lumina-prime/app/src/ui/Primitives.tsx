import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMind } from '../state/AppState';
import type { Creator } from '../data/types.ts';
import { colors, styles as s } from './theme';

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
