/**
 * Ссылки на онлайн-занятия (ТЗ 3.3, 5): создаются автоматически.
 * Zoom — при заданных ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (Server-to-Server OAuth);
 * без ключей — Jitsi Meet (бесплатно, без регистрации). Постоянная ссылка группы (Group.onlineUrl) имеет приоритет.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CENTER_TZ } from '../schedule/time';

const env = (k: string) => process.env[k]?.trim() || '';
export const zoomConfigured = () => !!(env('ZOOM_ACCOUNT_ID') && env('ZOOM_CLIENT_ID') && env('ZOOM_CLIENT_SECRET'));
export const onlineProvider = () => (zoomConfigured() ? 'zoom' : 'jitsi');

@Injectable()
export class OnlineMeetingService {
  private log = new Logger('OnlineMeetings');
  private zoomToken?: { value: string; expires: number };

  constructor(private prisma: PrismaService) {}

  /** Занятие онлайн: кабинет «онлайн», курс в формате online или у группы задана ссылка. */
  isOnline(l: { room: { isOnline: boolean } | null; group: { onlineUrl: string | null; course: { format: string } } }) {
    return !!l.room?.isOnline || l.group.course.format === 'online' || !!l.group.onlineUrl;
  }

  /** Ссылка занятия: существующая, постоянная ссылка группы или новая (Zoom / Jitsi). force — создать даже для очного. */
  async ensureLink(lessonId: string, force = false): Promise<string | null> {
    const l = await this.prisma.lesson.findUniqueOrThrow({
      where: { id: lessonId },
      include: { room: { select: { isOnline: true } }, group: { select: { name: true, onlineUrl: true, course: { select: { format: true } } } } },
    });
    if (l.onlineUrl) return l.onlineUrl;
    if (!force && !this.isOnline(l)) return null;
    let url = l.group.onlineUrl;
    if (!url) {
      try {
        url = zoomConfigured() ? await this.zoomMeeting(l.group.name, l.startsAt, l.endsAt) : this.jitsi(l.group.name);
      } catch (e) {
        // Zoom недоступен — не оставляем занятие без ссылки.
        this.log.error(e);
        url = this.jitsi(l.group.name);
      }
    }
    await this.prisma.lesson.update({ where: { id: lessonId }, data: { onlineUrl: url } });
    return url;
  }

  /** Комната Jitsi с непредсказуемым именем (посторонние не угадают). */
  private jitsi(group: string) {
    const slug = (process.env.CENTER_NAME ?? 'Deutschzentrum').replace(/[^A-Za-z0-9]/g, '') || 'CRM';
    const g = group.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    return `https://meet.jit.si/${slug}-${g}-${randomBytes(8).toString('hex')}`;
  }

  private async token() {
    if (this.zoomToken && this.zoomToken.expires > Date.now() + 60_000) return this.zoomToken.value;
    const auth = Buffer.from(`${env('ZOOM_CLIENT_ID')}:${env('ZOOM_CLIENT_SECRET')}`).toString('base64');
    const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(env('ZOOM_ACCOUNT_ID'))}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Zoom OAuth: HTTP ${r.status}`);
    const d = (await r.json()) as { access_token: string; expires_in: number };
    this.zoomToken = { value: d.access_token, expires: Date.now() + d.expires_in * 1000 };
    return d.access_token;
  }

  private async zoomMeeting(topic: string, start: Date, end: Date) {
    const r = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(env('ZOOM_USER_ID') || 'me')}/meetings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        type: 2,
        start_time: start.toISOString(),
        duration: Math.round((+end - +start) / 60_000),
        timezone: CENTER_TZ,
        settings: { join_before_host: false, waiting_room: true },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Zoom: HTTP ${r.status}`);
    return ((await r.json()) as { join_url: string }).join_url;
  }
}
