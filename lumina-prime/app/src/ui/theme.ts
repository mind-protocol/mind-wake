import { StyleSheet } from 'react-native';

export const colors = {
  canvas: '#F5F3ED', paper: '#FFFDF7', ink: '#1B3532', muted: '#697874',
  line: '#DFE3D9', green: '#D6F37A', dark: '#1D3B36', lavender: '#DED8EF',
  peach: '#F2BD9C', soft: '#E9EDE3', white: '#FFFFFF', danger: '#9E402E',
};
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.canvas },
  content: { width: '100%', maxWidth: 1040, alignSelf: 'center', paddingHorizontal: 22, paddingTop: 20, paddingBottom: 36, gap: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  grow: { flex: 1 },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  heading: { fontSize: 36, lineHeight: 40, letterSpacing: -1.6, fontWeight: '700', color: colors.ink },
  title: { fontSize: 23, lineHeight: 28, letterSpacing: -0.6, fontWeight: '700', color: colors.ink },
  subtitle: { fontSize: 15, lineHeight: 23, color: colors.muted },
  body: { color: colors.ink, fontSize: 14, lineHeight: 22 },
  small: { fontSize: 12, lineHeight: 18, color: colors.muted },
  strong: { color: colors.ink, fontWeight: '700' },
  card: { backgroundColor: colors.paper, borderColor: colors.line, borderWidth: 1, borderRadius: 24, padding: 20, gap: 14 },
  pill: { backgroundColor: colors.soft, borderRadius: 24, paddingVertical: 7, paddingHorizontal: 12 },
  pillText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  button: { backgroundColor: colors.dark, borderRadius: 18, paddingVertical: 15, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  buttonText: { color: colors.paper, fontWeight: '700', fontSize: 14 },
  secondary: { backgroundColor: colors.soft, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 18, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  secondaryText: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  divider: { height: 1, backgroundColor: colors.line },
  input: { color: colors.ink, borderColor: colors.line, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 13, backgroundColor: colors.paper, fontSize: 15, minHeight: 48 },
  badge: { backgroundColor: colors.green, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  badgeText: { color: colors.ink, fontWeight: '700', fontSize: 11 },
  amount: { color: colors.ink, fontSize: 31, fontWeight: '700', letterSpacing: -1 },
});
