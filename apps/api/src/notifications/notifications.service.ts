import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OnlineMeetingService } from '../integrations/online';
import { PrismaService } from '../prisma/prisma.service';
import { CENTER_TZ, localDate, zonedToUtc } from '../schedule/time';
import { Address, Channel, hasAddress, isAvailable, send } from './channels';
import { DEFAULT_TEMPLATES, NOTIFICATION_TYPES, render, TypeRule } from './templates';

export const CENTER_NAME = process.env.CENTER_NAME ?? 'Deutschzentrum';

export interface Recipient extends Address {
  studentId?: string | null;
  leadId?: string | null;
  branchId?: string | null;
  locale: string;
  /** Имя получателя ({{name}}). */
  name: string;
  /** Имя студента, о котором сообщение ({{student}}), — для родителя отличается от {{name}}. */
  student?: string;
  /** Уникальная часть ключа защиты от повторов. */
  key: string;
}

export interface NotificationSettings {
  reminderHours: number;
  /** Час (по времени центра) ежедневных рассылок: дни рождения, долги, абонементы. */
  dailyHour: number;
  types: Record<string, TypeRule>;
}

const fmtDate = (d: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: CENTER_TZ, day: '2-digit', month: '2-digit' }).format(d);
const fmtTime = (d: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: CENTER_TZ, hour: '2-digit', minute: '2-digit' }).format(d);
/** Сумма для текста сообщения: обычные пробелы вместо узких неразрывных — корректно в SMS и мессенджерах. */
export const fmtSom = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, ' ')} сом`;
export const when = (d: Date) => ({ date: fmtDate(d), time: fmtTime(d) });

/** ISO-неделя для еженедельных напоминаний о долге. */
function isoWeek(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return `${d.getUTCFullYear()}-W${1 + Math.round(((+d - +first) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)}`;
}

/**
 * Уведомления (ТЗ 3.8): постановка в очередь по шаблону на языке получателя,
 * отправка по приоритету каналов, автоматические напоминания по расписанию.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Notifications');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private prisma: PrismaService,
    private online: OnlineMeetingService,
  ) {}

  onModuleInit() {
    if (process.env.NOTIFY_SCHEDULER === '0') return;
    // Раз в минуту: отправка очереди, напоминания о занятиях, ежедневные сообщения.
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error(e)), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ───── Настройки ─────

  async settings(): Promise<NotificationSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'notifications' } });
    const v = (row?.value ?? {}) as Partial<NotificationSettings>;
    const types = Object.fromEntries(
      Object.entries(NOTIFICATION_TYPES).map(([k, d]) => [k, { ...d.rule, ...(v.types?.[k] ?? {}) }]),
    );
    return { reminderHours: v.reminderHours ?? 2, dailyHour: v.dailyHour ?? 10, types };
  }

  async saveSettings(value: NotificationSettings) {
    await this.prisma.setting.upsert({ where: { key: 'notifications' }, create: { key: 'notifications', value: value as any }, update: { value: value as any } });
    return value;
  }

  async template(type: string, locale: string) {
    const rows = await this.prisma.messageTemplate.findMany({ where: { type, locale: { in: [locale, 'ru'] } } });
    const db = rows.find((r) => r.locale === locale) ?? rows.find((r) => r.locale === 'ru');
    const def = DEFAULT_TEMPLATES[type]?.[locale === 'ky' ? 'ky' : 'ru'] ?? DEFAULT_TEMPLATES[type]?.ru;
    return db ? { title: db.title, body: db.body } : def ?? { title: type, body: '' };
  }

  // ───── Получатели ─────

  /** Студенты (их учётная запись или контакты из карточки) и, по правилу типа, их родители. */
  async studentRecipients(studentIds: string[], opts: { students?: boolean; parents?: boolean } = {}): Promise<Recipient[]> {
    if (!studentIds.length) return [];
    const rows = await this.prisma.student.findMany({
      where: { id: { in: studentIds } },
      include: {
        user: { select: { id: true, phone: true, email: true, locale: true, telegramChatId: true, isActive: true } },
        parents: { include: { parent: { select: { id: true, firstName: true, phone: true, email: true, locale: true, telegramChatId: true, isActive: true } } } },
      },
    });
    const out: Recipient[] = [];
    for (const s of rows) {
      if (opts.students !== false) {
        const u = s.user?.isActive ? s.user : null;
        out.push({
          userId: u?.id,
          studentId: s.id,
          branchId: s.branchId,
          phone: u?.phone ?? s.phone,
          email: u?.email ?? s.email,
          telegramChatId: u?.telegramChatId,
          locale: u?.locale ?? 'ru',
          name: s.firstName,
          student: s.firstName,
          key: u ? `u${u.id}` : `s${s.id}`,
        });
      }
      if (opts.parents) {
        for (const p of s.parents) {
          if (!p.parent.isActive) continue;
          out.push({
            userId: p.parent.id,
            studentId: s.id,
            branchId: s.branchId,
            phone: p.parent.phone,
            email: p.parent.email,
            telegramChatId: p.parent.telegramChatId,
            locale: p.parent.locale,
            name: p.parent.firstName,
            student: s.firstName,
            key: `p${p.parent.id}:${s.id}`,
          });
        }
      }
    }
    return out;
  }

  /** Студенты и родители по правилу типа сообщения. */
  async forStudents(type: string, studentIds: string[], parentsOnly = false) {
    const s = await this.settings();
    const rule = s.types[type];
    if (!rule?.enabled) return [];
    return this.studentRecipients(studentIds, { students: !parentsOnly, parents: parentsOnly || rule.parents });
  }

  // ───── Постановка в очередь ─────

  /**
   * Сообщение каждому получателю по шаблону на его языке. dedupe — основа ключа от повторов:
   * одно и то же событие одному получателю уходит один раз.
   */
  async emit(
    type: string,
    recipients: Recipient[],
    vars: Record<string, unknown> | ((r: Recipient) => Record<string, unknown>),
    opts: { dedupe?: string; scheduledAt?: Date; broadcastId?: string; template?: { title: string; body: string } } = {},
  ) {
    if (!recipients.length) return 0;
    const s = await this.settings();
    if (!s.types[type]?.enabled) return 0;
    const cache = new Map<string, { title: string; body: string }>();
    const data: Prisma.NotificationCreateManyInput[] = [];
    for (const r of recipients) {
      let tpl = opts.template;
      if (!tpl) {
        tpl = cache.get(r.locale) ?? (await this.template(type, r.locale));
        cache.set(r.locale, tpl);
      }
      const v = { center: CENTER_NAME, name: r.name, student: r.student ?? r.name, ...(typeof vars === 'function' ? vars(r) : vars) };
      data.push({
        userId: r.userId ?? null,
        studentId: r.studentId ?? null,
        leadId: r.leadId ?? null,
        branchId: r.branchId ?? null,
        phone: r.phone ?? null,
        email: r.email ?? null,
        telegramChatId: r.telegramChatId ?? null,
        locale: r.locale,
        type,
        title: render(tpl.title, v),
        body: render(tpl.body, v),
        scheduledAt: opts.scheduledAt ?? new Date(),
        dedupeKey: opts.dedupe ? `${type}:${opts.dedupe}:${r.key}` : null,
        broadcastId: opts.broadcastId ?? null,
      });
    }
    const res = await this.prisma.notification.createMany({ data, skipDuplicates: true });
    // Отправляем сразу, не дожидаясь минутного цикла.
    setImmediate(() => this.process().catch((e) => this.log.error(e)));
    return res.count;
  }

  // ───── Отправка ─────

  /** Отправка очереди: первый доступный канал по приоритету типа; ошибки — до 3 попыток. */
  async process(limit = 200) {
    if (this.running) return { sent: 0 };
    this.running = true;
    try {
      const s = await this.settings();
      const queue = await this.prisma.notification.findMany({
        where: { status: 'queued', scheduledAt: { lte: new Date() } },
        orderBy: { scheduledAt: 'asc' },
        take: limit,
      });
      let sent = 0;
      for (const n of queue) {
        const channels = (s.types[n.type]?.channels ?? ['push']).filter((c) => hasAddress(c as Channel, n) && isAvailable(c as Channel)) as Channel[];
        if (!channels.length) {
          await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'skipped', error: 'Нет адреса получателя для каналов этого типа' } });
          continue;
        }
        const errors: string[] = [];
        let done = false;
        for (const ch of channels) {
          const r = await send(ch, n, n.title, n.body);
          if (r.ok) {
            await this.prisma.notification.update({
              where: { id: n.id },
              data: { status: r.simulated ? 'simulated' : 'sent', channel: ch, sentAt: new Date(), attempts: { increment: 1 }, error: null },
            });
            sent++;
            done = true;
            break;
          }
          errors.push(`${ch}: ${r.error}`);
        }
        if (!done) {
          const failed = n.attempts + 1 >= 3;
          await this.prisma.notification.update({
            where: { id: n.id },
            data: {
              status: failed ? 'failed' : 'queued',
              attempts: { increment: 1 },
              error: errors.join('; ').slice(0, 1000),
              scheduledAt: new Date(Date.now() + 5 * 60_000),
            },
          });
        }
      }
      return { sent, processed: queue.length };
    } finally {
      this.running = false;
    }
  }

  // ───── Автоматические сообщения ─────

  /** Напоминания о занятиях за N часов (по умолчанию 2). */
  async lessonReminders() {
    const s = await this.settings();
    if (!s.types.lesson_reminder.enabled) return 0;
    const now = new Date();
    const lessons = await this.prisma.lesson.findMany({
      where: { status: 'planned', startsAt: { gt: now, lte: new Date(+now + s.reminderHours * 3600_000) } },
      include: { group: { select: { name: true, students: { where: { leftAt: null, waitlist: false }, select: { studentId: true } } } } },
    });
    let n = 0;
    for (const l of lessons) {
      const rs = await this.forStudents('lesson_reminder', l.group.students.map((x) => x.studentId));
      if (!rs.length) continue;
      // Онлайн-занятие: ссылка создаётся заранее и приходит в напоминании.
      const url = await this.online.ensureLink(l.id).catch(() => null);
      n += await this.emit('lesson_reminder', rs, { group: l.group.name, ...when(l.startsAt), link: url ? `Ссылка на урок: ${url}` : '' }, { dedupe: l.id });
    }
    return n;
  }

  /** Ежедневно в dailyHour: дни рождения, долги (раз в неделю), заканчивающиеся абонементы. */
  async daily(force = false) {
    const s = await this.settings();
    const today = localDate(new Date(), CENTER_TZ);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: CENTER_TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (!force && hour < s.dailyHour) return 0;
    let n = 0;

    // Дни рождения: месяц и день совпадают (по времени центра).
    const md = today.slice(5);
    const bday = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Student" WHERE status = 'active' AND "birthDate" IS NOT NULL
      AND to_char("birthDate" AT TIME ZONE 'UTC' AT TIME ZONE ${CENTER_TZ}, 'MM-DD') = ${md}`;
    if (bday.length) {
      const rs = await this.forStudents('birthday', bday.map((b) => b.id));
      n += await this.emit('birthday', rs, {}, { dedupe: today.slice(0, 4) });
    }

    // Задолженность: раз в неделю каждому должнику.
    const debtors = await this.prisma.student.findMany({ where: { status: 'active', balance: { lt: 0 } }, select: { id: true, balance: true } });
    if (debtors.length) {
      const rs = await this.forStudents('debt_reminder', debtors.map((d) => d.id));
      const amount = new Map(debtors.map((d) => [d.id, fmtSom(-Number(d.balance))]));
      n += await this.emit('debt_reminder', rs, (r) => ({ amount: amount.get(r.studentId!) }), { dedupe: isoWeek(today) });
    }

    // Абонемент: осталось 2 занятия или меньше — один раз на абонемент.
    const subs = await this.prisma.subscription.findMany({
      where: { status: 'active' },
      include: { group: { select: { name: true } }, _count: { select: { attendance: true } } },
    });
    for (const sub of subs.filter((x) => x.lessonsTotal - x._count.attendance <= 2)) {
      const rs = await this.forStudents('subscription_ending', [sub.studentId]);
      n += await this.emit('subscription_ending', rs, { group: sub.group?.name ?? '', remaining: sub.lessonsTotal - sub._count.attendance }, { dedupe: sub.id });
    }
    return n;
  }

  async tick(forceDaily = false) {
    const reminders = await this.lessonReminders();
    const daily = await this.daily(forceDaily);
    const r = await this.process();
    return { reminders, daily, ...r };
  }

  /** Начало суток по времени центра (для фильтров журнала). */
  static dayStart(date: string) {
    return zonedToUtc(date, '00:00', CENTER_TZ);
  }
}
