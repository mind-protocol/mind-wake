import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { chatUrl, type ChatSession } from './client.ts';
const key = 'mind.wake.chat.v1';
let memory: ChatSession | null = null;
export async function saveChatSession(session: ChatSession) {
  memory = session;
  if (Platform.OS !== 'web' && await SecureStore.isAvailableAsync())
    await SecureStore.setItemAsync(key, JSON.stringify(session));
}
export async function clearChatSession() {
  memory = null;
  if (Platform.OS !== 'web') { try { await SecureStore.deleteItemAsync(key); } catch { /* Session server is separately revoked. */ } }
}
export async function loadChatSession(): Promise<ChatSession | null> {
  try {
    const raw = Platform.OS === 'web' ? null : await SecureStore.getItemAsync(key);
    const value: ChatSession | null = raw ? JSON.parse(raw) : memory;
    if (!value || value.expiresAt <= Date.now() || !/^[a-f0-9]{64}$/.test(value.token)
      || chatUrl(value.url) !== value.url) { await clearChatSession(); return null; }
    return value;
  } catch { await clearChatSession(); return null; }
}
