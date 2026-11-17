import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { chatUrl, type ChatSession } from './client.ts';
const key = 'mind.wake.chat.v1';
let memory: ChatSession | null = null;
export async function saveChatSession(session: ChatSession) {
  memory = session;
  if (Platform.OS === 'web') localStorage.setItem(key, JSON.stringify(session));
  if (Platform.OS !== 'web' && await SecureStore.isAvailableAsync())
    await SecureStore.setItemAsync(key, JSON.stringify(session));
}
export async function clearChatSession() {
  memory = null;
  if (Platform.OS === 'web') { try { localStorage.removeItem(key); } catch { /* Browser storage may be disabled. */ } }
  if (Platform.OS !== 'web') { try { await SecureStore.deleteItemAsync(key); } catch { /* Session server is separately revoked. */ } }
}
export async function loadChatSession(): Promise<ChatSession | null> {
  try {
    const raw = Platform.OS === 'web' ? localStorage.getItem(key) : await SecureStore.getItemAsync(key);
    const value: ChatSession | null = raw ? JSON.parse(raw) : memory;
    if (!value || value.expiresAt <= Date.now() || !/^[a-f0-9]{64}$/.test(value.token)
      || chatUrl(value.url) !== value.url) { await clearChatSession(); return null; }
    return value;
  } catch { await clearChatSession(); return null; }
}

/** Mode Appel : réponses lues à voix haute ou non (NLR, 16 nov. : off par défaut, la voix Windows ralentit tout). */
const callVoiceKey = 'mind.wake.call.voice.v1';
export async function loadCallVoice(): Promise<boolean> {
  try {
    const raw = Platform.OS === 'web' ? localStorage.getItem(callVoiceKey)
      : (await SecureStore.isAvailableAsync()) ? await SecureStore.getItemAsync(callVoiceKey) : null;
    return raw === 'on';
  } catch { return false; }
}
export async function saveCallVoice(on: boolean) {
  try {
    if (Platform.OS === 'web') localStorage.setItem(callVoiceKey, on ? 'on' : 'off');
    else if (await SecureStore.isAvailableAsync()) await SecureStore.setItemAsync(callVoiceKey, on ? 'on' : 'off');
  } catch { /* Préférence perdue au redémarrage : voix off par défaut. */ }
}

/** Réglages d'appel (NLR, 17 nov. : modifiables pendant l'appel, conservés d'un appel à l'autre). */
export type StoredCallTuning = { silence: number; bargeMode: 'sensible' | 'normal' | 'off'; floorDb: number };
const callTuningKey = 'mind.wake.call.tuning.v1';
export async function loadCallTuning(): Promise<Partial<StoredCallTuning>> {
  try {
    const raw = Platform.OS === 'web' ? localStorage.getItem(callTuningKey)
      : (await SecureStore.isAvailableAsync()) ? await SecureStore.getItemAsync(callTuningKey) : null;
    const value = raw ? JSON.parse(raw) : {};
    const out: Partial<StoredCallTuning> = {};
    if ([2, 3, 5, 8].includes(value?.silence)) out.silence = value.silence;
    if (['sensible', 'normal', 'off'].includes(value?.bargeMode)) out.bargeMode = value.bargeMode;
    if (typeof value?.floorDb === 'number' && Number.isFinite(value.floorDb)) out.floorDb = value.floorDb;
    return out;
  } catch { return {}; }
}
export async function saveCallTuning(value: StoredCallTuning) {
  try {
    const raw = JSON.stringify(value);
    if (Platform.OS === 'web') localStorage.setItem(callTuningKey, raw);
    else if (await SecureStore.isAvailableAsync()) await SecureStore.setItemAsync(callTuningKey, raw);
  } catch { /* Réglage perdu au redémarrage : valeurs par défaut. */ }
}
