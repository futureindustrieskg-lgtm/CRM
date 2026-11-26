import { BadRequestException, Body, Controller, ForbiddenException, Get, Module, Param, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { IsNumber, IsString, Matches, Min } from 'class-validator';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { hasPermission } from '../common/permissions';
import { FinanceService } from '../finance/finance.service';
import { toPercent } from '../learning/settings';
import { PrismaService } from '../prisma/prisma.service';
import { CENTER_TZ, localDate, zonedToUtc } from '../schedule/time';

/** Колонка отчёта: тип влияет на формат в интерфейсе и в Excel. */
interface Col {
  key: string;
  title: string;
  type?: 'text' | 'int' | 'money' | 'percent' | 'date';
}
interface Section {
  title: string;
  columns: Col[];
  rows: Record<string, unknown>[];
  /** Итоговая строка. */
  total?: Record<string, unknown>;
}
interface Report {
  title: string;
  from: string;
  to: string;
  kpis?: { label: string; value: number | string; type?: Col['type'] }[];
  sections: Section[];
}

export const REPORTS = ['funnel', 'revenue', 'debts', 'load', 'retention', 'performance', 'payroll'] as const;
type ReportName = (typeof REPORTS)[number];

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (a: number, b: number) => (b ? round((a / b) * 100, 1) : null);
const ym = (d: Date) => localDate(d, CENTER_TZ).slice(0, 7);

/** Полночь даты по времени центра. */
const z = (date: string) => zonedToUtc(date, '00:00', CENTER_TZ);

/** Период: по умолчанию текущий месяц по времени центра; to — не включительно. */
function period(from?: string, to?: string) {
  const today = localDate(new Date(), CENTER_TZ);
  const f = from ? z(from.slice(0, 10)) : z(`${today.slice(0, 8)}01`);
  let t: Date;
  if (to) t = z(to.slice(0, 10));
  else {
    const [y, m] = localDate(f, CENTER_TZ).split('-').map(Number);
    t = z(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`);
  }
  if (!(t > f)) throw new BadRequestException('Неверный период');
  if (+t - +f > 731 * 86_400_000) throw new BadRequestException('Период не больше двух лет');
  return { from: f, to: t, fromStr: localDate(f, CENTER_TZ), toStr: localDate(new Date(+t - 1), CENTER_TZ) };
}

class PlanDto {
  @ApiProperty({ example: '2026-11' }) @IsString() @Matches(/^\d{4}-\d{2}$/) month: string;
  @ApiProperty() @IsNumber() @Min(0) amount: number;
}

/**
 * Отчёты (ТЗ 3.10): фильтр по периоду и филиалу, выгрузка в Excel (?format=xlsx).
 * PDF — печать страницы отчёта из браузера («Печать → Сохранить как PDF»).
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private finance: FinanceService) {}

  /** Ключевые показатели для дашборда директора. */
  @Get('kpi')
  @RequirePermissions('reports.read')
  async kpi(@Ctx() ctx: RequestContext, @Query('branchId') branchId?: string) {
    const scope = branchScope(ctx, branchId);
    const p = period();
    const month = ym(p.from);
    const [paid, debt, groups, marks, plan] = await Promise.all([
      this.prisma.payment.aggregate({ where: { ...scope, deletedAt: null, type: { not: 'opening' }, paidAt: { gte: p.from, lt: p.to } }, _sum: { amount: true } }),
      this.prisma.student.aggregate({ where: { ...scope, balance: { lt: 0 } }, _sum: { balance: true }, _count: true }),
      this.prisma.group.findMany({
        where: { ...scope, status: { not: 'finished' } },
        select: { maxStudents: true, _count: { select: { students: { where: { leftAt: null, waitlist: false } } } } },
      }),
      this.prisma.attendance.groupBy({ by: ['status'], where: { lesson: { startsAt: { gte: p.from, lt: p.to }, group: scope } }, _count: true }),
      this.plan(),
    ]);
    const places = groups.reduce((s, g) => s + g.maxStudents, 0);
    const taken = groups.reduce((s, g) => s + g._count.students, 0);
    const total = marks.reduce((s, m) => s + m._count, 0);
    const attended = marks.filter((m) => m.status === 'present' || m.status === 'late').reduce((s, m) => s + m._count, 0);
    const revenue = Number(paid._sum.amount ?? 0);
    return {
      month,
      revenue,
      plan: scope.branchId ? null : plan[month] ?? null,
      planPercent: !scope.branchId && plan[month] ? pct(revenue, plan[month]) : null,
      debtTotal: -Number(debt._sum.balance ?? 0),
      debtors: debt._count,
      groupLoad: pct(taken, places),
      attendance: pct(attended, total),
    };
  }

  private async plan(): Promise<Record<string, number>> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'revenuePlan' } });
    return (row?.value ?? {}) as Record<string, number>;
  }

  /** План выручки на месяц (по центру) — для отчёта «план/факт». */
  @Put('revenue-plan')
  @RequirePermissions('finance.update')
  async setPlan(@Ctx() ctx: RequestContext, @Body() dto: PlanDto) {
    if (ctx.branchId) throw new ForbiddenException('План выручки задаёт администрация центра');
    const plan = { ...(await this.plan()), [dto.month]: dto.amount };
    await this.prisma.setting.upsert({ where: { key: 'revenuePlan' }, create: { key: 'revenuePlan', value: plan }, update: { value: plan } });
    await this.audit.log({ userId: ctx.userId, entity: 'settings', entityId: 'revenuePlan', action: 'update', after: dto });
    return plan;
  }

  @Get(':name')
  @RequirePermissions('reports.read')
  async report(
    @Ctx() ctx: RequestContext,
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('format') format?: string,
  ) {
    if (!REPORTS.includes(name as ReportName)) throw new BadRequestException('Неизвестный отчёт');
    if (name === 'payroll' && !hasPermission(ctx.permissions, 'finance.salaries')) throw new ForbiddenException('Нужен доступ к зарплатам');
    const p = period(from, to);
    const scope = branchScope(ctx, branchId);
    const r = await this.build(name as ReportName, ctx, p, scope);
    if (format !== 'xlsx') return r;
    if (!hasPermission(ctx.permissions, 'reports.export')) throw new ForbiddenException('Нет права на выгрузку отчётов');
    const buf = await toXlsx(r);
    await this.audit.log({ userId: ctx.userId, entity: 'report', entityId: name, action: 'export', after: { from: p.fromStr, to: p.toStr, branchId: scope.branchId } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${r.title} ${p.fromStr}—${p.toStr}.xlsx`)}`);
    res.end(buf);
  }

  private build(name: ReportName, ctx: RequestContext, p: ReturnType<typeof period>, scope: { branchId?: string }): Promise<Report> {
    switch (name) {
      case 'funnel':
        return this.funnel(ctx, p, scope);
      case 'revenue':
        return this.revenue(p, scope);
      case 'debts':
        return this.debts(ctx, p, scope);
      case 'load':
        return this.load(p, scope);
      case 'retention':
        return this.retention(p, scope);
      case 'performance':
        return this.performance(p, scope);
      case 'payroll':
        return this.payroll(p, scope);
    }
  }

  // ───── Воронка продаж ─────
  private async funnel(ctx: RequestContext, p: ReturnType<typeof period>, scope: { branchId?: string }): Promise<Report> {
    const where: Prisma.LeadWhereInput = {
      ...scope,
      mergedIntoId: null,
      createdAt: { gte: p.from, lt: p.to },
      ...(hasPermission(ctx.permissions, 'leads.read_all') ? {} : { managerId: ctx.userId }),
    };
    const [stages, leads] = await Promise.all([
      this.prisma.pipelineStage.findMany({ orderBy: { sort: 'asc' } }),
      this.prisma.lead.findMany({ where, select: { source: true, stageId: true, lostReason: true, manager: { select: { firstName: true, lastName: true } } } }),
    ]);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const won = (l: (typeof leads)[number]) => stageById.get(l.stageId)?.isWon;
    const lost = (l: (typeof leads)[number]) => stageById.get(l.stageId)?.isLost;
    // Сколько лидов дошло до этапа или дальше (без отказов) — классическая воронка.
    const reached = stages
      .filter((s) => !s.isLost)
      .map((s) => {
        const n = leads.filter((l) => !lost(l) && (stageById.get(l.stageId)?.sort ?? 0) >= s.sort).length;
        return { stage: s.name, now: leads.filter((l) => l.stageId === s.id).length, reached: n, conversion: pct(n, leads.length) };
      });
    const group = (key: (l: (typeof leads)[number]) => string) => {
      const m = new Map<string, { total: number; won: number; lost: number }>();
      for (const l of leads) {
        const k = key(l);
        const x = m.get(k) ?? { total: 0, won: 0, lost: 0 };
        x.total++;
        if (won(l)) x.won++;
        if (lost(l)) x.lost++;
        m.set(k, x);
      }
      return [...m].map(([k, v]) => ({ name: k, ...v, inWork: v.total - v.won - v.lost, conversion: pct(v.won, v.total) })).sort((a, b) => b.total - a.total);
    };
    const reasons = new Map<string, number>();
    for (const l of leads.filter(lost)) reasons.set(l.lostReason || '—', (reasons.get(l.lostReason || '—') ?? 0) + 1);
    const cols: Col[] = [
      { key: 'name', title: 'Название' },
      { key: 'total', title: 'Лидов', type: 'int' },
      { key: 'inWork', title: 'В работе', type: 'int' },
      { key: 'won', title: 'Зачислены', type: 'int' },
      { key: 'lost', title: 'Отказ', type: 'int' },
      { key: 'conversion', title: 'Конверсия', type: 'percent' },
    ];
    const totalWon = leads.filter(won).length;
    return {
      title: 'Воронка продаж',
      from: p.fromStr,
      to: p.toStr,
      kpis: [
        { label: 'Новых лидов', value: leads.length, type: 'int' },
        { label: 'Зачислено', value: totalWon, type: 'int' },
        { label: 'Конверсия', value: pct(totalWon, leads.length) ?? 0, type: 'percent' },
        { label: 'Отказов', value: leads.filter(lost).length, type: 'int' },
      ],
      sections: [
        {
          title: 'По этапам',
          columns: [
            { key: 'stage', title: 'Этап' },
            { key: 'now', title: 'Сейчас на этапе', type: 'int' },
            { key: 'reached', title: 'Дошли до этапа', type: 'int' },
            { key: 'conversion', title: '% от всех лидов', type: 'percent' },
          ],
          rows: reached,
        },
        { title: 'По источникам', columns: cols, rows: group((l) => l.source) },
        { title: 'По менеджерам', columns: cols, rows: group((l) => (l.manager ? `${l.manager.lastName} ${l.manager.firstName}` : 'Не назначен')) },
        {
          title: 'Причины отказов',
          columns: [
            { key: 'reason', title: 'Причина' },
            { key: 'count', title: 'Количество', type: 'int' },
          ],
          rows: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
        },
      ],
    };
  }

  // ───── Выручка ─────
  private async revenue(p: ReturnType<typeof period>, scope: { branchId?: string }): Promise<Report> {
    const rows = await this.prisma.payment.findMany({
      // Начальные остатки при переносе данных (type opening) в выручку не входят.
      where: { ...scope, deletedAt: null, type: { not: 'opening' }, paidAt: { gte: p.from, lt: p.to } },
      select: { amount: true, type: true, method: true, paidAt: true, branch: { select: { name: true } }, subscription: { select: { course: { select: { name: true } } } } },
    });
    const plan = scope.branchId ? {} : await this.plan();
    const sum = (xs: typeof rows) => round(xs.reduce((s, r) => s + Number(r.amount), 0));
    const by = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, typeof rows>();
      for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
      return [...m].map(([name, xs]) => ({ name, income: sum(xs.filter((x) => x.type === 'payment')), refunds: -sum(xs.filter((x) => x.type === 'refund')), net: sum(xs), count: xs.length }));
    };
    const months = by((r) => ym(r.paidAt))
      .map((m) => ({ ...m, plan: plan[m.name] ?? null, planPercent: plan[m.name] ? pct(m.net, plan[m.name]) : null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const cols: Col[] = [
      { key: 'name', title: 'Название' },
      { key: 'count', title: 'Операций', type: 'int' },
      { key: 'income', title: 'Поступления', type: 'money' },
      { key: 'refunds', title: 'Возвраты', type: 'money' },
      { key: 'net', title: 'Итого', type: 'money' },
    ];
    const METHODS: Record<string, string> = { cash: 'Наличные', transfer: 'Перевод', qr: 'QR', card_online: 'Онлайн-карта' };
    const net = sum(rows);
    return {
      title: 'Выручка',
      from: p.fromStr,
      to: p.toStr,
      kpis: [
        { label: 'Поступления', value: sum(rows.filter((r) => r.type === 'payment')), type: 'money' },
        { label: 'Возвраты', value: -sum(rows.filter((r) => r.type === 'refund')), type: 'money' },
        { label: 'Итого', value: net, type: 'money' },
      ],
      sections: [
        {
          title: 'План / факт по месяцам',
          columns: [
            { key: 'name', title: 'Месяц' },
            { key: 'plan', title: 'План', type: 'money' },
            { key: 'net', title: 'Факт', type: 'money' },
            { key: 'planPercent', title: 'Выполнение', type: 'percent' },
          ],
          rows: months,
        },
        { title: 'По филиалам', columns: cols, rows: by((r) => r.branch.name), total: { name: 'Итого', count: rows.length, income: sum(rows.filter((r) => r.type === 'payment')), refunds: -sum(rows.filter((r) => r.type === 'refund')), net } },
        { title: 'По курсам', columns: cols, rows: by((r) => r.subscription?.course.name ?? 'Без абонемента') },
        { title: 'По способам оплаты', columns: cols, rows: by((r) => METHODS[r.method] ?? r.method) },
      ],
    };
  }

  // ───── Задолженность ─────
  private async debts(ctx: RequestContext, p: ReturnType<typeof period>, scope: { branchId?: string }): Promise<Report> {
    const students = await this.prisma.student.findMany({
      where: { ...scope, balance: { lt: 0 } },
      include: {
        branch: { select: { name: true } },
        payments: { where: { deletedAt: null, type: 'payment' }, orderBy: { paidAt: 'desc' }, take: 1, select: { paidAt: true } },
        subscriptions: { orderBy: { startDate: 'asc' }, take: 1, select: { startDate: true } },
        attendance: { where: { charged: true, subscriptionId: null }, select: { lessonId: true } },
      },
      orderBy: { balance: 'asc' },
    });
    const contacts = hasPermission(ctx.permissions, 'students.contacts');
    const now = Date.now();
    // Срок долга: с последней оплаты, а если оплат не было — с начала первого абонемента.
    const rows = students.map((s) => {
      const since = s.payments[0]?.paidAt ?? s.subscriptions[0]?.startDate ?? s.createdAt;
      return {
        name: `${s.lastName} ${s.firstName}`,
        branch: s.branch.name,
        phone: contacts && s.phone ? `+${s.phone}` : '',
        status: s.status,
        debt: -Number(s.balance),
        lastPayment: s.payments[0]?.paidAt ?? null,
        days: Math.max(0, Math.floor((now - +since) / 86_400_000)),
        unpaidLessons: s.attendance.length,
      };
    });
    const total = round(rows.reduce((x, r) => x + r.debt, 0));
    return {
      title: 'Задолженность',
      from: p.fromStr,
      to: p.toStr,
      kpis: [
        { label: 'Должников', value: rows.length, type: 'int' },
        { label: 'Сумма долга', value: total, type: 'money' },
        { label: 'Долг больше 30 дней', value: rows.filter((r) => r.days > 30).length, type: 'int' },
      ],
      sections: [
        {
          title: 'Студенты с отрицательным балансом (на сегодня)',
          columns: [
            { key: 'name', title: 'Студент' },
            { key: 'branch', title: 'Филиал' },
            { key: 'phone', title: 'Телефон' },
            { key: 'debt', title: 'Долг', type: 'money' },
            { key: 'days', title: 'Дней долга', type: 'int' },
            { key: 'lastPayment', title: 'Последняя оплата', type: 'date' },
            { key: 'unpaidLessons', title: 'Занятий без абонемента', type: 'int' },
          ],
          rows,
          total: { name: 'Итого', debt: total },
        },
      ],
    };
  }

  // ───── Загрузка ─────
  private async load(p: ReturnType<typeof period>, scope: { branchId?: string }): Promise<Report> {
    const [groups, rooms, lessons] = await Promise.all([
      this.prisma.group.findMany({
        where: { ...scope, status: { not: 'finished' } },
        include: {
          branch: { select: { name: true } },
          teacher: { select: { firstName: true, lastName: true } },
          _count: { select: { students: { where: { leftAt: null, waitlist: false } } } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.room.findMany({ where: { ...scope, isOnline: false }, include: { branch: { select: { name: true } } } }),
      this.prisma.lesson.findMany({
        where: { status: { not: 'cancelled' }, startsAt: { gte: p.from, lt: p.to }, group: scope },
        select: { startsAt: true, endsAt: true, roomId: true, teacherId: true, teacher: { select: { firstName: true, lastName: true } } },
      }),
    ]);
    const hours = (l: { startsAt: Date; endsAt: Date }) => (+l.endsAt - +l.startsAt) / 3_600_000;
    // Доступное время кабинета: 12 часов в день (9:00–21:00), все дни периода, кроме воскресенья.
    let workDays = 0;
    for (let t = +p.from; t < +p.to; t += 86_400_000) if (new Date(t + 6 * 3_600_000).getUTCDay() !== 0) workDays++;
    const available = workDays * 12;
    const teacherMap = new Map<string, { name: string; lessons: number; hours: number }>();
    for (const l of lessons) {
      if (!l.teacherId || !l.teacher) continue;
      const x = teacherMap.get(l.teacherId) ?? { name: `${l.teacher.lastName} ${l.teacher.firstName}`, lessons: 0, hours: 0 };
      x.lessons++;
      x.hours += hours(l);
      teacherMap.set(l.teacherId, x);
    }
    const places = groups.reduce((s, g) => s + g.maxStudents, 0);
    const taken = groups.reduce((s, g) => s + g._count.students, 0);
    return {
      title: 'Загрузка',
      from: p.fromStr,
      to: p.toStr,
      kpis: [
        { label: 'Заполненность групп', value: pct(taken, places) ?? 0, type: 'percent' },
        { label: 'Занятий в периоде', value: lessons.length, type: 'int' },
        { label: 'Часов преподавания', value: round(lessons.reduce((s, l) => s + hours(l), 0), 1), type: 'int' },
      ],
      sections: [
        {
          title: 'Группы',
          columns: [
            { key: 'name', title: 'Группа' },
            { key: 'branch', title: 'Филиал' },
            { key: 'teacher', title: 'Преподаватель' },
            { key: 'students', title: 'Студентов', type: 'int' },
            { key: 'max', title: 'Мест', type: 'int' },
            { key: 'fill', title: 'Заполненность', type: 'percent' },
          ],
          rows: groups.map((g) => ({
            name: g.name,
            branch: g.branch.name,
            teacher: g.teacher ? `${g.teacher.lastName} ${g.teacher.firstName}` : '—',
            students: g._count.students,
            max: g.maxStudents,
            fill: pct(g._count.students, g.maxStudents),
          })),
          total: { name: 'Итого', students: taken, max: places, fill: pct(taken, places) },
        },
        {
          title: `Кабинеты (доступно ${available} ч: 12 ч × ${workDays} раб. дн.)`,
          columns: [
            { key: 'name', title: 'Кабинет' },
            { key: 'branch', title: 'Филиал' },
            { key: 'lessons', title: 'Занятий', type: 'int' },
            { key: 'hours', title: 'Часов', type: 'int' },
            { key: 'load', title: 'Загрузка', type: 'percent' },
          ],
          rows: rooms.map((r) => {
            const ls = lessons.filter((l) => l.roomId === r.id);
            const h = round(ls.reduce((s, l) => s + hours(l), 0), 1);
            return { name: r.name, branch: r.branch.name, lessons: ls.length, hours: h, load: pct(h, available) };
          }),
        },
        {
          title: 'Преподаватели',
          columns: [
            { key: 'name', title: 'Преподаватель' },
            { key: 'lessons', title: 'Занятий', type: 'int' },
            { key: 'hours', title: 'Часов', type: 'int' },
            { key: 'academic', title: 'Ак. часов', type: 'int' },
          ],
          rows: [...teacherMap.values()].map((t) => ({ ...t, hours: round(t.hours, 1), academic: round((t.hours * 60) / 45, 1) })).sort((a, b) => b.hours - a.hours),
        },
      ],
    };
  }

  // ───── Удержание ─────
  private async retention(p: ReturnType<typeof period>, scope: { branchId?: string }): Promise<Report> {
    // Группы, завершившиеся в периоде: кто из студентов продолжил обучение в другой группе.
    const finished = await this.prisma.group.findMany({
      where: { ...scope, endDate: { gte: p.from, lt: p.to } },
      include: { course: { select: { level: true } }, students: { where: { waitlist: false }, select: { studentId: true } } },
    });
    let ended = 0;
    let continued = 0;
    const byGroup = [];
    for (const g of finished) {
      const ids = g.students.map((s) => s.studentId);
      const next = await this.prisma.groupStudent.findMany({
        where: { studentId: { in: ids }, groupId: { not: g.id }, joinedAt: { gte: new Date(+(g.startDate ?? p.from)) } },
        select: { studentId: true },
        distinct: ['studentId'],
      });
      ended += ids.length;
      continued += next.length;
      byGroup.push({ name: g.name, level: g.course.level, students: ids.length, continued: next.length, rate: pct(next.length, ids.length) });
    }
    // Отток по месяцам: вышли из группы и не продолжили в другой в течение 30 дней.
    const left = await this.prisma.groupStudent.findMany({
      where: { leftAt: { gte: p.from, lt: p.to }, group: scope },
      select: { studentId: true, leftAt: true },
    });
    const churn = new Map<string, { left: number; churned: number }>();
    for (const l of left) {
      const again = await this.prisma.groupStudent.count({
        where: { studentId: l.studentId, joinedAt: { gte: new Date(+l.leftAt! - 86_400_000), lte: new Date(+l.leftAt! + 30 * 86_400_000) }, leftAt: null },
      });
      const k = ym(l.leftAt!);
      const x = churn.get(k) ?? { left: 0, churned: 0 };
      x.left++;
      if (!again) x.churned++;
      churn.set(k, x);
    }
    const active = await this.prisma.student.count({ where: { ...scope, status: 'active' } });
    // LTV: средняя сумма оплат на одного платившего студента (за всё время).
    const ltv = await this.prisma.payment.groupBy({ by: ['studentId'], where: { ...scope, deletedAt: null }, _sum: { amount: true } });
    const ltvAvg = ltv.length ? round(ltv.reduce((s, x) => s + Number(x._sum.amount ?? 0), 0) / ltv.length) : 0;
    return {
      title: 'Удержание',
      from: p.fromStr,
      to: p.toStr,
      kpis: [
        { label: 'Перешли на следующий уровень', value: pct(continued, ended) ?? 0, type: 'percent' },
        { label: 'Активных студентов', value: active, type: 'int' },
        { label: 'LTV (средние оплаты на студента)', value: ltvAvg, type: 'money' },
      ],
      sections: [
        {
          title: 'Завершившиеся группы: продолжили обучение',
          columns: [
            { key: 'name', title: 'Группа' },
            { key: 'level', title: 'Уровень' },
            { key: 'students', title: 'Студентов', type: 'int' },
            { key: 'continued', title: 'Продолжили', type: 'int' },
            { key: 'rate', title: 'Доля', type: 'percent' },
          ],
          rows: byGroup,
          total: { name: 'Итого', students: ended, continued, rate: pct(continued, ended) },
        },
        {
          title: 'Отток по месяцам',
          columns: [
            { key: 'month', title: 'Месяц' },
            { key: 'left', title: 'Вышли из групп', type: 'int' },
            { key: 'churned', title: 'Не продолжили (30 дней)', type: 'int' },
          ],
          rows: [...churn].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month)),
        },
      ],
    };
  }

  // ───── Посещаемость и успеваемость ─────
  private async performance(p: ReturnType<typeof period>, scope: { branchId?: string }): Promise<Report> {
    const groups = await this.prisma.group.findMany({ where: { ...scope }, select: { id: true, name: true, course: { select: { level: true } } }, orderBy: { name: 'asc' } });
    const SK: [string, string][] = [['hoeren', 'Hören'], ['lesen', 'Lesen'], ['schreiben', 'Schreiben'], ['sprechen', 'Sprechen']];
    const rows = [];
    for (const g of groups) {
      const [marks, grades] = await Promise.all([
        this.prisma.attendance.findMany({ where: { lesson: { groupId: g.id, startsAt: { gte: p.from, lt: p.to } } }, select: { status: true } }),
        this.prisma.grade.findMany({ where: { lesson: { groupId: g.id, startsAt: { gte: p.from, lt: p.to } } } }),
      ]);
      if (!marks.length && !grades.length) continue;
      const attended = marks.filter((m) => m.status === 'present' || m.status === 'late').length;
      const row: Record<string, unknown> = { name: g.name, level: g.course.level, marks: marks.length, attendance: pct(attended, marks.length) };
      for (const [k] of SK) {
        const xs = grades.filter((x) => x.skill === k).map(toPercent);
        row[k] = xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : null;
      }
      rows.push(row);
    }
    const exams = await this.prisma.externalExam.findMany({
      where: { date: { gte: p.from, lt: p.to }, student: scope },
      include: { student: { select: { firstName: true, lastName: true } } },
      orderBy: { date: 'asc' },
    });
    const PROV: Record<string, string> = { goethe: 'Goethe', telc: 'telc', osd: 'ÖSD', testdaf: 'TestDaF' };
    const ST: Record<string, string> = { registered: 'Зарегистрирован', passed: 'Сдал', failed: 'Не сдал' };
    const done = exams.filter((e) => e.status !== 'registered');
    return {
      title: 'Посещаемость и успеваемость',
      from: p.fromStr,
      to: p.toStr,
      kpis: [
        { label: 'Внешних экзаменов', value: exams.length, type: 'int' },
        { label: 'Сдали', value: pct(exams.filter((e) => e.status === 'passed').length, done.length) ?? 0, type: 'percent' },
      ],
      sections: [
        {
          title: 'По группам (средние оценки в %)',
          columns: [
            { key: 'name', title: 'Группа' },
            { key: 'level', title: 'Уровень' },
            { key: 'marks', title: 'Отметок', type: 'int' },
            { key: 'attendance', title: 'Посещаемость', type: 'percent' },
            ...SK.map(([k, n]) => ({ key: k, title: n, type: 'percent' as const })),
          ],
          rows,
        },
        {
          title: 'Внешние экзамены',
          columns: [
            { key: 'date', title: 'Дата', type: 'date' },
            { key: 'student', title: 'Студент' },
            { key: 'exam', title: 'Экзамен' },
            { key: 'score', title: 'Баллы', type: 'int' },
            { key: 'status', title: 'Результат' },
          ],
          rows: exams.map((e) => ({
            date: e.date,
            student: `${e.student.lastName} ${e.student.firstName}`,
            exam: `${PROV[e.provider] ?? e.provider} ${e.level}`,
            score: e.score === null ? null : Number(e.score),
            status: ST[e.status] ?? e.status,
          })),
        },
      ],
    };
  }

  // ───── Зарплатная ведомость ─────
  private async payroll(p: ReturnType<typeof period>, scope: { branchId?: string }): Promise<Report> {
    const r = await this.finance.payroll({ from: p.from, to: p.to, branchId: scope.branchId });
    return {
      title: 'Зарплатная ведомость',
      from: p.fromStr,
      to: p.toStr,
      kpis: [{ label: 'Начислено всего', value: r.total, type: 'money' }],
      sections: [
        {
          title: 'Начисления преподавателям',
          columns: [
            { key: 'name', title: 'Преподаватель' },
            { key: 'category', title: 'Категория' },
            { key: 'rate', title: 'Ставка', type: 'percent' },
            { key: 'lessons', title: 'Занятий', type: 'int' },
            { key: 'visits', title: 'Посещений', type: 'int' },
            { key: 'missed', title: 'Пропусков (без оплаты)', type: 'int' },
            { key: 'amount', title: 'Начислено', type: 'money' },
          ],
          rows: r.teachers.map((t) => ({
            name: `${t.teacher.lastName} ${t.teacher.firstName}`,
            category: t.category === 'experienced' ? 'Опытный' : 'Новый',
            rate: t.rate,
            lessons: t.lessons,
            visits: t.visits,
            missed: t.missed,
            amount: t.amount,
          })),
          total: { name: 'Итого', amount: r.total },
        },
      ],
    };
  }
}

/** Excel: показатели и каждый раздел — отдельный лист с форматами чисел. */
async function toXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Deutschzentrum CRM';
  wb.created = new Date();
  const fmt: Record<string, string> = { money: '#,##0.00 "сом"', percent: '0.0"%"', int: '#,##0.##', date: 'dd.mm.yyyy' };
  if (r.kpis?.length) {
    const ws = wb.addWorksheet('Показатели');
    ws.addRow([r.title]).font = { bold: true, size: 14 };
    ws.addRow([`Период: ${r.from} — ${r.to}`]);
    ws.addRow([]);
    for (const k of r.kpis) {
      const row = ws.addRow([k.label, k.value]);
      if (k.type && fmt[k.type]) row.getCell(2).numFmt = fmt[k.type];
    }
    ws.getColumn(1).width = 40;
    ws.getColumn(2).width = 20;
  }
  const used = new Set<string>();
  for (const s of r.sections) {
    // Имя листа: до 31 символа, без запрещённых знаков, уникальное.
    let name = s.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim();
    while (used.has(name)) name = `${name.slice(0, 26)} ${used.size}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.addRow([s.title]).font = { bold: true, size: 12 };
    ws.addRow([`${r.title} · ${r.from} — ${r.to}`]).font = { color: { argb: 'FF666666' } };
    const head = ws.addRow(s.columns.map((c) => c.title));
    head.font = { bold: true };
    head.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }));
    const put = (obj: Record<string, unknown>, bold = false) => {
      const row = ws.addRow(s.columns.map((c) => (c.type === 'date' && obj[c.key] ? new Date(obj[c.key] as string) : obj[c.key] ?? null)));
      s.columns.forEach((c, i) => c.type && fmt[c.type] && (row.getCell(i + 1).numFmt = fmt[c.type]));
      if (bold) row.font = { bold: true };
    };
    s.rows.forEach((x) => put(x));
    if (s.total) put(s.total, true);
    s.columns.forEach((c, i) => (ws.getColumn(i + 1).width = Math.max(12, Math.min(40, c.title.length + 4, ...s.rows.map((x) => String(x[c.key] ?? '').length + 2)))));
    ws.views = [{ state: 'frozen', ySplit: 3 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
