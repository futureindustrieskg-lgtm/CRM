/**
 * Push-уведомления: разрешение, Expo push token, регистрация телефона на сервере.
 * В Expo Go на Android push не работает (нужна сборка EAS с FCM), в веб-сборке — не поддерживается.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true }),
});

let token: string | null = null;

/** Возвращает причину, если push недоступен (для экрана профиля), иначе null. */
export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === 'web') return 'web';
  if (!Device.isDevice) return 'emulator';
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Уведомления', importance: Notifications.AndroidImportance.HIGH });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'denied';
  const projectId = (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) || Constants.easConfig?.projectId;
  try {
    token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  } catch {
    return 'no-project';
  }
  await api('/me/devices', { method: 'POST', body: { token, platform: Platform.OS } });
  return null;
}

/** При выходе: сервер больше не шлёт push на этот телефон. */
export async function unregisterPush() {
  if (!token) return;
  await api('/me/devices/remove', { method: 'POST', body: { token } }).catch(() => {});
  token = null;
}
