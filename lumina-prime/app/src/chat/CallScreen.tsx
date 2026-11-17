import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated, Image, Linking, Platform, Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, styles as s } from '../ui/theme';
import { MessageRow } from './MessageRow';
import { useIncomingPhone } from './IncomingPhone';
import { useWakeChat } from './WakeChatProvider';
import { callTargets, endCall, type CallTarget } from './call-client.ts';
import { callRecovery, type CallRecovery } from './call-recovery.ts';
import { createCallEngine, type CallLine, type CallPhase } from './call-engine';
import { clampFloorDb, FLOOR_DB_DEFAULT, FLOOR_DB_MAX, FLOOR_DB_MIN, SILENCE_S_DEFAULT, type BargeMode } from './call-vad.ts';
import { ChatClientError, chatErrorMessage, tintOf } from './client.ts';
import { loadCallTuning, loadCallVoice, saveCallTuning, saveCallVoice } from './storage.ts';
import { RichText } from '../ui/Primitives';
import { createCallToneTransitions } from './call-tone-transitions';
import { createCallTonePlayer } from './call-tone-player';
import { canModifyCallParticipants } from './call-engine-capabilities';
import { useReportedError } from './app-error-report.ts';
import { createScrollFollow } from './scroll-follow';
import { createWebScrollFollow } from './scroll-follow-web';
import { captureLines, type CallCapture } from './call-frames.ts';
import { pinScrollToEnd, observeTranscriptGrowth, PIN_WINDOW_MS } from './call-scroll.ts';
import { CallPeers } from './CallPeers';
import { openCallLink } from './call-links.ts';
type ScrollViewInstance = React.ComponentRef<typeof ScrollView>;

const PHASES: Record<CallPhase, string> = { connecting: 'Connexion…', listening: 'À l’écoute', speaking: 'Tu parles…',
  playing: 'Ils répondent', ended: 'Raccroché' };
const GROUPS: { title: string; kinds: CallTarget['kind'][] }[] = [
  { title: 'Marco', kinds: ['main'] }, { title: 'Agents', kinds: ['agent', 'holder'] }, { title: 'Rooms', kinds: ['room'] }, { title: 'Autres PC', kinds: ['remote'] }];
/** Espacement entre deux réponses arrivées ensemble dans la transcription (NLR, 16 nov. 2026). */
// NLR, 16 nov. 2026, 21:38 : apparition trois fois plus lente.
const REVEAL_SPACING_MS = 2100;
const FADE_IN_MS = 780;
const Chip = ({ label, on, disabled, small, onPress }: { label: string; on: boolean; disabled?: boolean; small?: boolean; onPress: () => void }) =>
  <Pressable accessibilityRole="radio" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={onPress}
    style={{ paddingVertical: small ? 4 : 8, paddingHorizontal: small ? 10 : 12, borderRadius: 16, minHeight: small ? 30 : 40, justifyContent: 'center',
      backgroundColor: on ? colors.dark : colors.soft, opacity: disabled && !on ? 0.5 : 1 }}>
    <Text style={{ color: on ? colors.paper : colors.ink, fontWeight: '600', fontSize: 13 }}>{label}</Text>
  </Pressable>;

/** Page Appel (NLR, 16 nov. 2026) : un vrai appel vocal avec MIND ou n'importe quel agent. */
export default function CallScreen() {
  const { session, online, error: connectionError } = useWakeChat();
  const [targets, setTargets] = useState<CallTarget[]>([{ handle: 'mind', label: 'Marco', kind: 'main' }]);
  // Participants de l'appel (NLR : « room 1 + vox ») ; Marco seul par défaut.
  const [selected, setSelected] = useState<string[]>(['mind']);
  const [inviteHumans,setInviteHumans]=useState(false);
  const [humanGuest,setHumanGuest]=useState(false);
  const [adding, setAdding] = useState(false);
  const [joining, setJoining] = useState(false);
  const [silence, setSilence] = useState(SILENCE_S_DEFAULT);
  const [bargeMode, setBargeMode] = useState<BargeMode>('normal');
  // Seuil de bruit de fond (NLR, 17 nov.) : en dessous, le micro compte comme silence.
  const [floorDb, setFloorDb] = useState(FLOOR_DB_DEFAULT);
  const tuningLoaded = useRef(false);
  const [phase, setPhase] = useState<CallPhase>('ended');
  const [level, setLevel] = useState<{ db: number; threshold: number }>({ db: -120, threshold: -50 });
  const [lines, setLines] = useState<CallLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Micro coupé (NLR, 17 nov. 2026, pendant un appel) : rien n'est capté ni envoyé.
  const [muted, setMuted] = useState(false);
  useReportedError('appel', error);
  // Voix des réponses : off par défaut (NLR, 16 nov. : la voix Windows fait laguer, il lit les messages).
  const [voice, setVoice] = useState(false);
  const voiceRef = useRef(false);
  const transcript = useRef<ScrollViewInstance | null>(null);
  const engine = useRef<ReturnType<typeof createCallEngine> | null>(null);
  const [recovery] = useState(() => {
    try { return typeof window !== 'undefined' && window.parent !== window && window.location.pathname === '/desktop-call'
      ? callRecovery(window.localStorage) : null; } catch { return null; }
  });
  const leavingPage = useRef(false);
  const recoveryAttempted = useRef(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const cancelling = useRef(new Set<string>());
  const [cancelled, setCancelled] = useState<Set<string>>(() => new Set());
  const [cancelPending, setCancelPending] = useState<Set<string>>(() => new Set());
  async function cancelMessage(item: CallLine) {
    const current = engine.current;
    if (!current || !('cancelMessage' in current) || cancelling.current.has(item.key) || cancelled.has(item.key)) return;
    cancelling.current.add(item.key);
    setCancelPending(previous => new Set(previous).add(item.key));
    try {
      await current.cancelMessage(item.key, item.text);
      if (engine.current === current) setCancelled(previous => new Set(previous).add(item.key));
    } catch (reason) {
      if (engine.current === current) setError(chatErrorMessage(reason));
    } finally {
      cancelling.current.delete(item.key);
      setCancelPending(previous => { const next = new Set(previous); next.delete(item.key); return next; });
    }
  }
  const active = phase !== 'ended';
  const canModifyParticipants = canModifyCallParticipants(engine.current, phase);
  const canMute = active && typeof (engine.current as { setMuted?: unknown } | null)?.setMuted === 'function';
  function toggleMute() {
    const current = engine.current as { setMuted?: (next: boolean) => boolean } | null;
    if (typeof current?.setMuted === 'function') setMuted(current.setMuted(!muted));
  }
  const tones = useRef<ReturnType<typeof createCallTonePlayer> | null>(null);
  if (!tones.current) tones.current = createCallTonePlayer();
  const toneTransitions = useRef<ReturnType<typeof createCallToneTransitions> | null>(null);
  if (!toneTransitions.current) toneTransitions.current = createCallToneTransitions(tone => tones.current?.play(tone));
  const [settings, setSettings] = useState(false);
  // Défilement auto vers la dernière bulle à chaque message (NLR : plus de bandeau).
  // NLR, 17 nov. 2026, 16:05 : même suivi que le chat (scroll-follow) ; l'ancien calcul sur onScroll
  // décrochait pendant le défilement animé et la liste ne descendait plus vers les derniers messages.
  const [following, setFollowing] = useState(true);
  const [scrollFollow] = useState(() => createScrollFollow(() => {}, setFollowing));
  const [webFollow] = useState(() => createWebScrollFollow(scrollFollow));
  const web = Platform.OS === 'web';
  const openLink = (url: string) => { if (!openCallLink(url, web && typeof window !== 'undefined' ? { parent: window.parent, self: window, open: u => { window.open(u, '_blank', 'noopener,noreferrer'); } } : { open: u => { void Linking.openURL(u).catch(() => {}); } })) return; };
  // Nouveau message : défilement animé (NLR, 17 nov.) ; recalage après une image/ASCII tardive : instantané.
  const pinUntil = useRef(0); const smoothNext = useRef(false); const animatingUntil = useRef(0);
  useLayoutEffect(() => { scrollFollow.setScrollToEnd(() => {
    const animated = pinScrollToEnd(smoothNext, animatingUntil, Date.now());
    transcript.current?.scrollToEnd({ animated });
  }); }, [scrollFollow]);
  const onTranscriptScroll = (event: Parameters<typeof webFollow.onScroll>[0]) => {
    // Pendant un défilement animé lancé par l'écran, les positions intermédiaires ne sont pas un geste de NLR.
    if (Date.now() < animatingUntil.current) return;
    webFollow.onScroll(event);
  };
  // Agrandissement d'une image ou d'une capture ASCII (NLR, 17 nov. 16:20) ; ferme au clic ou Échap.
  const [lightbox, setLightbox] = useState<CallCapture | null>(null);
  useEffect(() => {
    if (!lightbox || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [lightbox]);
  // Captures relayées par le desktop : dans le fil de l'appel, à leur place (NLR, 17 nov. 16:18).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function' || window.location?.pathname !== '/desktop-call') return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const added = captureLines(event.data, (engine.current as { callId?: string } | null)?.callId);
      if (added.length) setLines(previous => [...previous.filter(item => !added.some(line => line.key === item.key)), ...added].slice(-40));
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, []);
  const inCall = useRef<string[]>(['mind']);
  // Révélation échelonnée : une bulle nouvelle apparaît tout de suite, les suivantes à REVEAL_SPACING_MS d'intervalle.
  const [visible, setVisible] = useState<Set<string>>(() => new Set());
  const known = useRef<Set<string>>(new Set());
  const queue = useRef<string[]>([]);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function pump() {
    if (revealTimer.current || !queue.current.length) return;
    const key = queue.current.shift()!;
    setVisible(previous => new Set(previous).add(key));
    revealTimer.current = setTimeout(() => { revealTimer.current = null; pump(); }, REVEAL_SPACING_MS);
  }
  useEffect(() => {
    for (const item of lines) if (!known.current.has(item.key)) { known.current.add(item.key); queue.current.push(item.key); }
    pump();
  }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);

  useEffect(() => {
    if (!session) return; const controller = new AbortController();
    callTargets(session, controller.signal).then(setTargets).catch(reason => { if (!controller.signal.aborted) setError(chatErrorMessage(reason)); });
    return () => controller.abort();
  }, [session]);
  useEffect(() => {
    if (!session) return;
    const leave = () => {
      if (!engine.current) return;
      engine.current.stop();
      engine.current = null;
      return; // The engine owns its scoped remote hang-up, including pagehide.
    };
    const closeDesktopCall = (event: MessageEvent) => {
      if (window.location?.pathname !== '/desktop-call' || event.source !== window.parent || event.data !== 'mind.call.leave') return;
      recovery?.clear();
      void Promise.resolve(leave()).finally(() => window.parent.postMessage('mind.call.closed', event.origin));
    };
    const unloading = () => { leavingPage.current = true; leave(); };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', unloading);
      window.addEventListener('message', closeDesktopCall);
    }
    return () => {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.removeEventListener('pagehide', unloading);
        window.removeEventListener('message', closeDesktopCall);
      }
      leavingPage.current = true; leave(); leavingPage.current = false;
    };
  }, [session, recovery]);
  useEffect(() => { void Promise.all([loadCallTuning(), loadCallVoice()]).then(([saved, on]) => {
    voiceRef.current = on; setVoice(on);
    if (saved.silence) setSilence(saved.silence);
    if (saved.bargeMode) setBargeMode(saved.bargeMode);
    if (saved.floorDb !== undefined) setFloorDb(clampFloorDb(saved.floorDb));
    tuningLoaded.current = true;
    setPreferencesReady(true);
  }); }, []);
  // Réglages appliqués à l'appel en cours sans raccrocher (NLR, 17 nov.), puis conservés.
  useEffect(() => {
    const current = engine.current as { configure?: (next: { silenceMs: number; bargeMode: BargeMode; floorDb: number }) => void } | null;
    current?.configure?.({ silenceMs: silence * 1000, bargeMode, floorDb });
    if (tuningLoaded.current) void saveCallTuning({ silence, bargeMode, floorDb });
  }, [silence, bargeMode, floorDb]);
  function switchVoice(on: boolean) { voiceRef.current = on; setVoice(on); void saveCallVoice(on); }

  const phone = useIncomingPhone();
  const setPhoneBusy = phone?.busy;
  useEffect(() => {
    setPhoneBusy?.(active);
    return () => setPhoneBusy?.(false);
  }, [active, setPhoneBusy]);
  useEffect(() => {
    if (!phone?.accepted || !session || engine.current) return;
    const invitation=phone.accepted;
    const handles = invitation.kind==='peer-human'?[]:[invitation.caller];
    phone.consume(); setSelected(handles); start(handles,invitation.kind==='peer-human'?invitation:undefined);
  }, [phone, session]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!recovery || !session || !online || !preferencesReady || recoveryAttempted.current || engine.current) return;
    recoveryAttempted.current = true;
    const saved = recovery.load();
    if (!saved) return;
    let cancelled = false, launched = false;
    window.parent.postMessage('mind.call.recovering', '*');
    // Close the abandoned session before redialling, including after a hard crash.
    // A gateway restart may already have forgotten it.
    void endCall(session, saved.handles, undefined, false, { id: saved.callId, epoch: 1 })
      .catch(() => {}).then(() => {
        if (cancelled || leavingPage.current || engine.current || !recovery.load()) return;
        setSelected(saved.handles); setInviteHumans(saved.inviteHumans);
        launched = true;
        start(saved.handles, undefined, saved);
      });
    return () => { cancelled = true; if (!launched) recoveryAttempted.current = false; };
  }, [session, online, preferencesReady, recovery]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!recovery || !active || humanGuest || !engine.current || phase === 'connecting') return;
    const save = () => { if (engine.current) recovery.save({ handles: inCall.current, muted: engine.current.muted, inviteHumans, callId: engine.current.callId }); };
    save(); const timer = setInterval(save, 5000);
    return () => clearInterval(timer);
  }, [recovery, active, phase, selected, muted, inviteHumans, humanGuest]);

  function start(handles = selected, humanInvite?:{id:string;label:string}, resumed?: CallRecovery) {
    if (!session || engine.current) return;
    recoveryAttempted.current = true;
    if (!resumed) recovery?.clear();
    setError(null); setLines([]); setAdding(false); setSettings(false); setMuted(false);
    setHumanGuest(Boolean(humanInvite));
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = null; queue.current = []; known.current = new Set(); setVisible(new Set()); scrollFollow.reset(); pinUntil.current = Date.now() + PIN_WINDOW_MS;
    inCall.current = handles;
    toneTransitions.current?.reset();
    const call = createCallEngine({ session, targets: handles, humanInvite, inviteHumans:resumed?.inviteHumans ?? (inviteHumans&&handles.some(h=>targets.find(t=>t.handle===h)?.kind==='remote')),
      announce: false /* NLR 16 nov. 2026 : ne pas lire à voix haute qui envoie le message */, voice: () => voiceRef.current, silenceMs: silence * 1000, bargeMode, floorDb,
      onPhase: next => {
        if (engine.current !== call) return;
        toneTransitions.current?.phase(next);
        if (next === 'ended') {
          if (!leavingPage.current) recovery?.clear();
          engine.current = null; setMuted(false);
          if (typeof window !== 'undefined' && window.location?.pathname === '/desktop-call')
            window.parent.postMessage('mind.phone.ended', '*');
        }
        setPhase(next);
      }, onLevel: (db, threshold) => setLevel({ db, threshold }),
      onLine: value => setLines(previous => [...previous.filter(item => item.key !== value.key), ...(value.drop ? [] : [value])].slice(-40)) });
    engine.current = call;
    if (resumed?.muted) { call.setMuted(true); setMuted(true); }
    // Appel synchrone dans le geste : déverrouillage du son et demande du micro.
    call.start().catch(reason => {
      if (engine.current !== call) return;
      setError(reason instanceof ChatClientError ? chatErrorMessage(reason) : String(reason?.message ?? reason)); call.stop();
    });
  }
  function hangUp() {
    recovery?.clear();
    engine.current?.stop(); engine.current = null; setPhase('ended'); setMuted(false);
    // onPhase ignore ce moteur une fois détaché : prévenir le bureau (toast, appel entrant suivant).
    if (typeof window !== 'undefined' && window.location?.pathname === '/desktop-call') window.parent.postMessage('mind.phone.ended', '*');
    // The engine ends only its own call_id/epoch.
  }
  const labelOf = (handle: string) => targets.find(t => t.handle === handle)?.label ?? handle;
  const label = selected.map(labelOf).join(' + ');
  const toggle = (handle: string) => setSelected(previous => previous.includes(handle)
    ? (previous.length > 1 ? previous.filter(h => h !== handle) : previous) : [...previous, handle].slice(0, 8));
  async function addParticipant(handle: string) {
    const current = engine.current;
    if (!current) { toggle(handle); setAdding(false); return; }
    if (joining) return;
    if (!canModifyCallParticipants(current, phase)) {setError('Cet appel a commencé avant la mise à jour. Raccroche puis rappelle pour modifier ses participants.');return;}
    setJoining(true); setError(null);
    try {
      const handles = await current.addTargets([handle]);
      if (engine.current !== current) return;
      inCall.current = handles; setSelected(handles); setAdding(false);
    } catch (reason) { if (engine.current === current) setError(chatErrorMessage(reason)); }
    finally { setJoining(false); }
  }
  async function removeParticipant(handle: string) {
    const current=engine.current;if(!current){toggle(handle);return;}if(joining)return;
    if(!canModifyCallParticipants(current,phase)){setError('Cet appel a commencé avant la mise à jour. Raccroche puis rappelle pour modifier ses participants.');return;}
    setJoining(true);setError(null);
    try {
      const handles=await current.removeTargets([handle]);
      // Last participant closes the engine; still reflect the empty selection.
      if(engine.current!==current&&handles.length)return;
      inCall.current=handles;setSelected(handles);
    }catch(reason){if(engine.current===current)setError(chatErrorMessage(reason));}
    finally{setJoining(false);}
  }
  const meter = Math.max(0, Math.min(100, (level.db + 80) * 1.4));

  const shownLines = lines.filter(item => visible.has(item.key));
  const transcriptRevision = JSON.stringify(shownLines.map(item => [item.key, item.text]));
  // Follow each revealed/updated message, even when the capped list keeps the
  // same length and height. Wait for its layout rather than only arming a flag.
  // NLR, 17 nov. 2026 : défilement automatique à chaque nouveau message, aucun bandeau.
  // Un nouveau message recolle toujours en bas ; ensuite, pendant PIN_WINDOW_MS, toute croissance du fil
  // (image, capture ASCII) recolle aussi (observers ci-dessous).
  useLayoutEffect(() => {
    if (transcriptRevision === '[]') return;
    scrollFollow.contentChanged(); webFollow.invalidate();
    pinUntil.current = Date.now() + PIN_WINDOW_MS;
    const frame = requestAnimationFrame(() => { smoothNext.current = true; scrollFollow.recent(); });
    return () => cancelAnimationFrame(frame);
  }, [transcriptRevision, scrollFollow, webFollow]);
  // Ouverture de l'écran d'appel et croissance tardive du contenu : recoller en bas.
  const followingRef = useRef(true); followingRef.current = following;
  useEffect(() => {
    if (!session || !web) return;
    pinUntil.current = Date.now() + PIN_WINDOW_MS;
    const node = (transcript.current as { getScrollableNode?: () => unknown } | null)?.getScrollableNode?.() as HTMLElement | null | undefined;
    if (node) node.scrollTop = node.scrollHeight;
    return observeTranscriptGrowth(node,
      () => followingRef.current || Date.now() < pinUntil.current,
      () => { if (node) node.scrollTop = node.scrollHeight; });
  }, [session, web]);
  // Nom de l'expéditeur au-dessus de la bulle, avec son emoji s'il est fourni par la passerelle.
  const senderOf = (item: CallLine) => {
    if (item.who === 'me') return 'Toi';
    if (item.who !== 'them') return '';
    const name = item.speaker ?? (selected.length === 1 ? labelOf(selected[0]) : '');
    // Les libellés de holders portent déjà leur emoji (« 🤍 Gardien de VOX ») ; le speaker arrive sans.
    const bare = (value: string) => value.replace(/^\p{Extended_Pictographic}[️‍]*\s*/u, '').replace(/\s*\((?:Room \d+|fil principal)\)\s*$/, '').trim();
    const target = targets.find(t => t.label === name || t.handle === name || bare(t.label) === bare(name));
    const shown = target ? target.label : name;
    return target?.emoji && !shown.includes(target.emoji) ? `${target.emoji} ${shown}` : shown;
  };
  // NLR, 16 nov. 2026, 21:39 : l'émotion de chacun à côté de son nom. Les participants ouvrent leur
  // réponse par un emoji (consigne d'appel, renvoyée avec chaque message) ; on le déplace du texte vers le nom.
  const moodOf = (item: CallLine) => {
    if (item.who !== 'them') return null;
    const m = item.text.match(/^\s*(\p{Extended_Pictographic}(?:[\u{FE0F}\u{200D}]|\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s+/u);
    if (!m) return null;
    const rest = item.text.slice(m[0].length);
    // « 🦅 Altaïr · … » : emoji de persona suivi du nom, pas une émotion.
    if (/^[^\n]{1,40}?\s[·:]\s/u.test(rest) && senderOf(item).includes(m[1])) return null;
    return { emoji: m[1], rest };
  };
  const bubbleOf = (item: CallLine, name: string) => item.who === 'me' ? colors.green
    : item.who === 'them' ? (name ? tintOf(name.replace(/^\p{Extended_Pictographic}[️‍]*\s*/u, '')) : colors.paper) : colors.soft;

  if (!session) return <SafeAreaView style={s.page}><View style={{ padding: 20 }}>
    <Text style={s.body}>{connectionError ?? 'Connexion à la passerelle…'}</Text>
  </View></SafeAreaView>;
  return <SafeAreaView style={[s.page, { overflow: 'hidden' }]} edges={['top', 'left', 'right', 'bottom']}>
    <View style={{ flex: 1, minHeight: 0, padding: 10, gap: 8, maxWidth: 720, width: '100%', alignSelf: 'center' }}>
      {/* Rangée du haut : participants, « + », phase, réglages. Micro et raccrocher : barre fixe du bas. */}
      <View style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 1, flexShrink: 1 }}
          contentContainerStyle={{ gap: 4, alignItems: 'center' }}>
          {selected.map(handle => <Chip key={handle} small label={(active ? canModifyParticipants : selected.length > 1) ? `${labelOf(handle)} ✕` : labelOf(handle)} on
            disabled={joining || (active && !canModifyParticipants)} onPress={() => {if(active)void removeParticipant(handle);else toggle(handle);}} />)}
          {selected.length < 8 && (!active || canModifyParticipants) ? <Chip small label={joining ? "…" : "+"} disabled={joining} on={false} onPress={() => { setSettings(false); setAdding(true); }} /> : null}
        </ScrollView>
        <Text numberOfLines={1} style={[s.small, { flexShrink: 1, maxWidth: active ? 140 : 110 }]}>
          {active ? (muted ? '🔇 Micro coupé' : PHASES[phase]) : online ? 'connectée' : 'hors ligne'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Réglages" onPress={() => { setAdding(false); setSettings(value => !value); }}
          style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: settings ? colors.dark : colors.soft }}>
          <Text style={{ fontSize: 15, color: settings ? colors.paper : colors.ink }}>⚙</Text>
        </Pressable>
      </View>
      {active ? <View style={{ flexShrink: 0, height: 3, borderRadius: 2, backgroundColor: colors.soft, overflow: 'hidden' }}>
        <View style={{ width: muted ? '100%' : `${meter}%`, height: 3, backgroundColor: muted ? colors.danger : level.db > level.threshold ? colors.green : colors.muted }} />
      </View> : <Pressable accessibilityRole="button" accessibilityLabel={`Appeler ${label}`}
        onPress={() => start()} disabled={!online || !selected.length}
        style={{ minHeight: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center',
          backgroundColor: colors.dark, opacity: !online ? 0.5 : 1 }}>
        <Text style={{ color: colors.paper, fontSize: 22, fontWeight: '800' }}>📞 Appeler</Text>
        <Text numberOfLines={1} style={{ color: colors.paper, fontSize: 12 }}>{label}</Text>
      </Pressable>}
      {!active&&web&&selected.some(h=>targets.find(t=>t.handle===h)?.kind==='remote')?<Pressable accessibilityRole="checkbox" accessibilityState={{checked:inviteHumans}}
        onPress={()=>setInviteHumans(value=>!value)} style={{padding:8,backgroundColor:colors.soft,borderRadius:10}}>
        <Text style={s.body}>{inviteHumans?'☑':'☐'} Inviter aussi l’humain de chaque PC distant</Text>
      </Pressable>:null}
      {active&&humanGuest?<Text style={s.small}>Tu participes à l’appel. Ton micro et ton raccrochage sont indépendants. La voix des agents suit le réglage de l’appelant.</Text>:null}
      {active && !humanGuest && phase !== 'connecting' && !canModifyParticipants ? <Text style={s.small}>Pour modifier les participants de cet ancien appel, raccroche puis rappelle.</Text> : null}
      {error ? <Text accessibilityRole="alert" numberOfLines={3} style={{ color: colors.danger, fontSize: 12 }}>{error}</Text> : null}
      <View style={{ flex: 1, minHeight: 0 }} {...(web ? webFollow.inputHandlers : {})}>
      <ScrollView ref={transcript} style={{ flex: 1, minHeight: 0, borderRadius: 14, backgroundColor: colors.soft }} scrollEventThrottle={16}
        contentContainerStyle={{ gap: 8, padding: 8 }}
        onLayout={event => { webFollow.invalidate(); scrollFollow.onLayout(event); }}
        onContentSizeChange={(width, height) => { webFollow.invalidate(); scrollFollow.onContentSizeChange(width, height); }}
        onScroll={web ? onTranscriptScroll : undefined}
        onScrollBeginDrag={scrollFollow.onScrollBeginDrag} onScrollEndDrag={scrollFollow.onScrollEndDrag}
        onMomentumScrollEnd={scrollFollow.onMomentumScrollEnd} onScrollToTop={scrollFollow.suspend}>
        {!shownLines.length ? <Text style={s.small}>{active ? 'La conversation s’affiche ici.' : 'Appuie sur Appeler pour commencer.'}</Text> : null}
        {shownLines.map(item => { const name = senderOf(item); const mood = moodOf(item); const body = mood ? mood.rest : item.text;
          const canCancel = active && engine.current && 'cancelMessage' in engine.current && item.who === 'me' && !item.capture && !item.error && item.text !== '…' && item.text.trim() && /^chat-[a-f0-9-]{36}$/.test(item.key);
          const bubble = <View style={{ padding: 10, paddingRight: canCancel ? 34 : 10, borderRadius: 14, backgroundColor: bubbleOf(item, name) }}>
            {canCancel ? <Pressable accessibilityRole="button" accessibilityLabel={cancelled.has(item.key) ? 'Message annulé' : 'Annuler ce message'}
              accessibilityState={{ disabled: cancelled.has(item.key) || cancelPending.has(item.key) }}
              disabled={cancelled.has(item.key) || cancelPending.has(item.key)} onPress={() => { void cancelMessage(item); }}
              hitSlop={4} style={{ position: 'absolute', top: 3, right: 3, width: 26, height: 26, alignItems: 'center', justifyContent: 'center', opacity: cancelled.has(item.key) ? 0.3 : 0.6 }}>
              <Text style={{ color: colors.ink, fontSize: 14 }}>{cancelPending.has(item.key) ? '·' : '×'}</Text>
            </Pressable> : null}
            {item.capture ? <Capture capture={item.capture} onOpen={setLightbox} /> : <RichText text={body} onLinkPress={openLink} onImagePress={url => setLightbox({ image: url, caption: '' })} />}
            {item.error && item.detail && item.detail !== item.text ? <Text style={[s.small, { fontSize: 11, color: item.error ? colors.danger : colors.muted }]}>{item.detail}</Text> : null}
          </View>;
          return <FadeIn key={item.key}
          style={{ alignSelf: 'stretch' }}>
          {item.who === 'me' || item.who === 'them' ? <MessageRow name={name} handle={targets.find(target => target.label === name || target.handle === item.speaker)?.handle} mine={item.who === 'me'}>
          {name ? <Text numberOfLines={1} style={[s.small, { fontWeight: '700', color: colors.ink, alignSelf: item.who === 'me' ? 'flex-end' : 'flex-start', paddingHorizontal: 4 }]}>{mood ? `${name}  ${mood.emoji}` : name}</Text> : null}
          {bubble}
          </MessageRow> : <View style={{ alignSelf: 'flex-start', maxWidth: '95%' }}>{bubble}</View>}
        </FadeIn>; })}
      </ScrollView>
      </View>
      {/* NLR, 17 nov. 2026 : barre fixe hors de la liste, toujours visible même dans l'iframe courte du desktop. */}
      {active ? <View accessibilityLabel="Commandes de l’appel" style={{ flexShrink: 0, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        {canMute ? <Pressable accessibilityRole="switch" accessibilityState={{ checked: muted }} aria-checked={muted}
          accessibilityLabel={muted ? 'Réactiver le micro' : 'Couper le micro'} onPress={toggleMute}
          style={{ flex: 1, height: 44, borderRadius: 22, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center',
            backgroundColor: muted ? colors.danger : colors.soft }}>
          <Text style={{ fontSize: 17, color: muted ? colors.paper : colors.ink }}>{muted ? '🔇' : '🎙'}</Text>
          <Text style={{ color: muted ? colors.paper : colors.ink, fontWeight: '800', fontSize: 13 }}>{muted ? 'Micro coupé' : 'Micro ouvert'}</Text>
        </Pressable> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Raccrocher" onPress={hangUp}
          style={{ flex: 1, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.danger }}>
          <Text style={{ color: colors.paper, fontWeight: '800', fontSize: 14 }}>✕ Raccrocher</Text>
        </Pressable>
      </View> : null}
    </View>
    {adding && (!active || canModifyParticipants) ? <Overlay onClose={() => setAdding(false)} title="Ajouter un participant">
      <ScrollView style={{ maxHeight: '100%' }} contentContainerStyle={{ gap: 8 }}>
        {GROUPS.map(group => {
          const items = targets.filter(t => group.kinds.includes(t.kind) && !selected.includes(t.handle));
          return items.length ? <View key={group.title} style={{ gap: 4 }}>
            <Text style={s.small}>{group.title}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {items.map(t => <Chip key={t.handle} label={t.label} on={false} disabled={joining} onPress={() => { void addParticipant(t.handle); }} />)}
            </View>
          </View> : null;
        })}
      </ScrollView>
    </Overlay> : null}
    {lightbox ? <Lightbox capture={lightbox} onClose={() => setLightbox(null)} /> : null}
    {settings ? <Overlay onClose={() => setSettings(false)} title="Réglages">
      <ScrollView contentContainerStyle={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={s.small}>Fin de phrase après</Text>
          {[2, 3, 5, 8].map(value => <Chip key={value} small label={`${value} s`} on={silence === value} onPress={() => setSilence(value)} />)}
          <Text style={s.small}>de silence</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={s.small}>Interruption</Text>
          {(['sensible', 'normal', 'off'] as const).map(value => <Chip key={value} small label={value} on={bargeMode === value} onPress={() => setBargeMode(value)} />)}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={s.small}>Voix :</Text>
          <Chip small label="off" on={!voice} onPress={() => switchVoice(false)} />
          <Chip small label="on" on={voice} onPress={() => switchVoice(true)} />
          <Text style={s.small}>{voice ? 'réponses lues à voix haute' : 'réponses affichées en texte'}</Text>
        </View>
        <View style={{ gap: 4 }}>
          <Text style={s.small}>Seuil du bruit de fond : {floorDb} dB{floorDb === FLOOR_DB_DEFAULT ? ' (défaut)' : ''}</Text>
          <ThresholdSlider value={floorDb} level={active ? level.db : null} onChange={setFloorDb} />
          <Text style={s.small}>Plus à droite : le bruit de fond est ignoré et tes messages partent ; trop à droite, ta voix n’est plus entendue.{active ? ' Le trait montre ton micro.' : ''}</Text>
        </View>
        {active ? <Text style={s.small}>Les réglages s’appliquent tout de suite à l’appel en cours.</Text> : null}
        {web && typeof window !== 'undefined' && window.location?.pathname === '/desktop-call' ? <CallPeers session={session}
          onChanged={() => { void callTargets(session).then(setTargets).catch(reason => setError(chatErrorMessage(reason))); }} /> : null}
      </ScrollView>
    </Overlay> : null}
  </SafeAreaView>;
}

/** Curseur du seuil (dBFS) : toucher ou glisser sur la piste, ou −/+ par 2 dB. Le trait vert montre le niveau du micro. */
function ThresholdSlider({ value, level, onChange }: { value: number; level: number | null; onChange: (value: number) => void }) {
  const width = useRef(1);
  const span = FLOOR_DB_MAX - FLOOR_DB_MIN;
  const pct = (db: number) => `${Math.max(0, Math.min(100, ((db - FLOOR_DB_MIN) / span) * 100))}%` as const;
  const pick = (x: number) => onChange(clampFloorDb(FLOOR_DB_MIN + (Math.max(0, Math.min(width.current, x)) / width.current) * span));
  const step = (delta: number) => onChange(clampFloorDb(value + delta));
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <Chip small label="−" on={false} onPress={() => step(-2)} />
    <View accessibilityRole="adjustable" accessibilityLabel="Seuil du bruit de fond" accessibilityValue={{ min: FLOOR_DB_MIN, max: FLOOR_DB_MAX, now: value, text: `${value} dB` }}
      onLayout={e => { width.current = Math.max(1, e.nativeEvent.layout.width); }}
      onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
      onResponderGrant={e => pick(e.nativeEvent.locationX)} onResponderMove={e => pick(e.nativeEvent.locationX)}
      style={{ flex: 1, height: 30, justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ height: 6, borderRadius: 3, backgroundColor: colors.soft }}>
        <View style={{ width: pct(value), height: 6, borderRadius: 3, backgroundColor: colors.dark }} />
      </View>
      {level !== null ? <View pointerEvents="none" style={{ position: 'absolute', left: pct(level), width: 2, height: 18, marginLeft: -1, backgroundColor: level > value ? colors.green : colors.muted }} /> : null}
      <View pointerEvents="none" style={{ position: 'absolute', left: pct(value), width: 16, height: 16, marginLeft: -8, borderRadius: 8, backgroundColor: colors.dark }} />
    </View>
    <Chip small label="+" on={false} onPress={() => step(2)} />
  </View>;
}

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Consolas, monospace' });
/** Capture dans la bulle : image à largeur de bulle, ASCII en police normale et défilement horizontal ; toucher pour agrandir. */
function Capture({ capture, onOpen }: { capture: CallCapture; onOpen: (capture: CallCapture) => void }) {
  const [ratio, setRatio] = useState(16 / 9);
  return <View style={{ gap: 6 }}>
    <Text style={[s.small, { fontSize: 11 }]}>{capture.caption}</Text>
    {capture.image ? <Pressable accessibilityRole="imagebutton" accessibilityLabel="Agrandir la capture" onPress={() => onOpen({ image: capture.image, caption: capture.caption })}>
      <Image source={{ uri: capture.image }} resizeMode="contain" onLoad={e => { const src = e.nativeEvent?.source; if (src?.width && src?.height) setRatio(src.width / src.height); }}
        style={{ width: '100%', aspectRatio: ratio, borderRadius: 8, backgroundColor: colors.soft }} />
    </Pressable> : null}
    {capture.ascii ? <Pressable accessibilityRole="button" accessibilityLabel="Agrandir la capture ASCII" onPress={() => onOpen({ ascii: capture.ascii, caption: capture.caption })}>
      <ScrollView horizontal style={{ borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.06)' }} contentContainerStyle={{ padding: 8 }}>
        <Text style={{ fontFamily: MONO, fontSize: 12, lineHeight: 16, color: colors.ink }}>{capture.ascii}</Text>
      </ScrollView>
    </Pressable> : null}
  </View>;
}

/** Agrandissement plein écran : image ajustée à l'écran, ASCII pleine largeur défilable ; ferme au clic ou Échap. */
function Lightbox({ capture, onClose }: { capture: CallCapture; onClose: () => void }) {
  return <View accessibilityViewIsModal style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.88)', padding: 10, gap: 6 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Fermer l’agrandissement" onPress={onClose}
      style={{ alignSelf: 'flex-end', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.15)' }}>
      <Text style={{ color: '#fff', fontWeight: '700' }}>✕ Fermer</Text>
    </Pressable>
    {capture.image ? <Pressable accessibilityLabel="Fermer" onPress={onClose} style={{ flex: 1 }}>
      <Image source={{ uri: capture.image }} resizeMode="contain" style={{ flex: 1, width: '100%' }} />
    </Pressable> : <ScrollView style={{ flex: 1, borderRadius: 8, backgroundColor: '#111' }}>
      <ScrollView horizontal contentContainerStyle={{ padding: 10 }}>
        <Pressable onPress={onClose}><Text selectable style={{ fontFamily: MONO, fontSize: 13, lineHeight: 17, color: '#eee' }}>{capture.ascii}</Text></Pressable>
      </ScrollView>
    </ScrollView>}
  </View>;
}

/** Feuille posée par-dessus l'écran : ne pousse jamais la transcription. */
function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
    <Pressable accessibilityLabel="Fermer" onPress={onClose} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' }} />
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '50%', padding: 14, gap: 10,
      borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.paper }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={s.strong}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Fermer" onPress={onClose} style={{ padding: 6 }}>
          <Text style={{ fontSize: 16, color: colors.ink }}>✕</Text>
        </Pressable>
      </View>
      <View style={{ flexShrink: 1 }}>{children}</View>
    </View>
  </View>;
}

/** Apparition douce (fondu + léger glissement) d'une bulle de transcription. */
function FadeIn({ style, children }: { style: ViewStyle; children: React.ReactNode }) {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => { Animated.timing(progress, { toValue: 1, duration: FADE_IN_MS, useNativeDriver: true }).start(); }, [progress]);
  return <Animated.View style={[style, { opacity: progress,
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>{children}</Animated.View>;
}
