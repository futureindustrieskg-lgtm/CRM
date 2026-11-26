/**
 * Push в мобильное приложение через Expo Push Service (ТЗ 3.8, этап 4).
 * Expo доставляет сообщение через FCM (Android) и APNs (iOS); ключи FCM/APNs загружаются
 * в проект Expo (EAS) при сборке приложения, серверу ключ не нужен.
 * EXPO_ACCESS_TOKEN — необязательно, если в проекте Expo включена «Enhanced push security».
 * В режиме имитации (NOTIFY_DRY_RUN ≠ 0) наружу ничего не уходит.
 */
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const log = new Logger('ExpoPush');

export const isExpoToken = (t: string) => /^Expo(nent)?PushToken\[[\w-]+\]$/.test(t);
const dryRun = () => (process.env.NOTIFY_DRY_RUN?.trim() || '') !== '0';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Отправляет push на все устройства пользователя. Возвращает число устройств, принявших сообщение.
 * Токены, которые Expo признал недействительными (приложение удалено), удаляются.
 */
export async function pushToUser(prisma: PrismaService, userId: string, msg: PushMessage): Promise<number> {
  const devices = await prisma.pushDevice.findMany({ where: { userId }, select: { token: true } });
  if (!devices.length) return 0;
  if (dryRun()) return devices.length;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN?.trim()) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN.trim()}`;
  try {
    const r = await fetch(EXPO_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(devices.map((d) => ({ to: d.token, title: msg.title, body: msg.body, data: msg.data ?? {}, sound: 'default' }))),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      log.warn(`Expo push HTTP ${r.status}`);
      return 0;
    }
    const res = (await r.json()) as { data?: { status: string; details?: { error?: string } }[] };
    let ok = 0;
    const dead: string[] = [];
    (res.data ?? []).forEach((t, i) => {
      if (t.status === 'ok') ok++;
      else if (t.details?.error === 'DeviceNotRegistered') dead.push(devices[i].token);
    });
    if (dead.length) await prisma.pushDevice.deleteMany({ where: { token: { in: dead } } });
    return ok;
  } catch (e) {
    log.warn(e instanceof Error ? e.message : String(e));
    return 0;
  }
}
