import { AndroidImportance, getExpoPushTokenAsync, requestPermissionsAsync, setNotificationChannelAsync } from 'expo-notifications';
import { Platform, NativeModules } from 'react-native';
import Constants from 'expo-constants';
import {verifiedRingtoneKeys} from './ringtone-native-proof';
export async function phoneRingtoneKeys(): Promise<string[]> {
  // Expo Go ou ancien binaire/OTA sans ce module : son commun.
  return Platform.OS === 'android'
    ? verifiedRingtoneKeys(NativeModules.MindRingtoneCapabilities, Constants.executionEnvironment === 'storeClient' || Constants.appOwnership === 'expo') : [];
}

export async function phoneToken(): Promise<string | null> {
  if (Platform.OS === 'android') await setNotificationChannelAsync('appel-agent', {
    name: 'Appels des agents', importance: AndroidImportance.MAX,
    sound: 'ring.wav', vibrationPattern: [0,350,180,350],
  });
  if (Platform.OS === 'android') await setNotificationChannelAsync('appel-marco-v1', {
    name: 'Appels marco', importance: AndroidImportance.MAX,
    sound: 'ring_marco.wav', vibrationPattern: [0,350,180,350],
  });
  if (Platform.OS === 'android') await setNotificationChannelAsync('appel-vox-v1', {
    name: 'Appels vox', importance: AndroidImportance.MAX,
    sound: 'ring_vox.wav', vibrationPattern: [0,350,180,350],
  });
  if (Platform.OS === 'android') await setNotificationChannelAsync('appel-equerre-v1', {
    name: 'Appels equerre', importance: AndroidImportance.MAX,
    sound: 'ring_equerre.wav', vibrationPattern: [0,350,180,350],
  });
  if (Platform.OS === 'android') await setNotificationChannelAsync('appel-rose_des_vents-v1', {
    name: 'Appels rose_des_vents', importance: AndroidImportance.MAX,
    sound: 'ring_rose_des_vents.wav', vibrationPattern: [0,350,180,350],
  });
  if (Platform.OS === 'android') await setNotificationChannelAsync('appel-medicis-v1', {
    name: 'Appels medicis', importance: AndroidImportance.MAX,
    sound: 'ring_medicis.wav', vibrationPattern: [0,350,180,350],
  });
  const permission = await requestPermissionsAsync();
  if (!permission.granted) return null;
  return (await getExpoPushTokenAsync({ projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID })).data;
}
