import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../ui/theme';
export const unstable_settings = { initialRouteName: 'chat' };

export default function TabLayout() {
  return <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.ink,
    tabBarInactiveTintColor: colors.muted, tabBarStyle: { backgroundColor: colors.paper, borderTopColor: colors.line, height: 58, paddingTop: 4, paddingBottom: 6 },
    tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginTop: 4 } }}>
    <Tabs.Screen name="chat" options={{ title: 'Chat', tabBarIcon: ({focused,size}) => <Ionicons name="chatbubble-outline" color={focused?colors.ink:colors.muted} size={size} /> }} />
    <Tabs.Screen name="index" options={{ title: 'Radar', tabBarIcon: ({ focused, size }) => <Ionicons name="planet-outline" color={focused ? colors.ink : colors.muted} size={size} /> }} />
    <Tabs.Screen name="supports" options={{ title: 'Soutiens', tabBarIcon: ({ focused, size }) => <Ionicons name="sparkles-outline" color={focused ? colors.ink : colors.muted} size={size} /> }} />
    <Tabs.Screen name="activity" options={{ title: 'Activité', tabBarIcon: ({ focused, size }) => <Ionicons name="receipt-outline" color={focused ? colors.ink : colors.muted} size={size} /> }} />
    <Tabs.Screen name="account" options={{ title: 'Mon espace', tabBarIcon: ({ focused, size }) => <Ionicons name="person-circle-outline" color={focused ? colors.ink : colors.muted} size={size} /> }} />
  </Tabs>;
}
