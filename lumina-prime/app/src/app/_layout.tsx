import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppStateProvider } from '../state/AppState';
import { IncomingPhone } from '../chat/IncomingPhone';
import { WakeChatProvider } from '../chat/WakeChatProvider';
import { colors } from '../ui/theme';

export default function RootLayout() {
  return <SafeAreaProvider><AppStateProvider><WakeChatProvider><IncomingPhone><StatusBar style="dark" />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="creator/[username]" />
      <Stack.Screen name="compose/[username]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="login" />
    </Stack>
  </IncomingPhone></WakeChatProvider></AppStateProvider></SafeAreaProvider>;
}
