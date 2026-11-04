import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { MindSession } from './types.ts';
import { parseSessionResponse } from './providers.ts';

// Stockage de la session MIND. Natif : Keychain / Keystore via expo-secure-store.
// Web : expo-secure-store n'est pas disponible ; la session reste en mémoire
// (jamais dans localStorage) et se perd au rechargement de la page.

const KEY = 'mind.auth.session.v1';
let memory: string | null = null;

async function secureAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try { return await SecureStore.isAvailableAsync(); } catch { return false; }
}

export async function saveSession(session: MindSession): Promise<void> {
  const value = JSON.stringify(session);
  if (await secureAvailable()) await SecureStore.setItemAsync(KEY, value);
  else memory = value;
}

export async function loadSession(now: number): Promise<MindSession | null> {
  let raw: string | null = null;
  try { raw = (await secureAvailable()) ? await SecureStore.getItemAsync(KEY) : memory; } catch { raw = null; }
  if (!raw) return null;
  try {
    const session = parseSessionResponse(JSON.parse(raw), null, now);
    if (!session) await clearSession();
    return session;
  } catch {
    await clearSession();
    return null;
  }
}

export async function clearSession(): Promise<void> {
  memory = null;
  try { if (await secureAvailable()) await SecureStore.deleteItemAsync(KEY); } catch { /* rien à effacer */ }
}

export function isPersistentStorage(): boolean {
  return Platform.OS !== 'web';
}
