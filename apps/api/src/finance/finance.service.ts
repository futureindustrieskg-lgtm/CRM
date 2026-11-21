import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ACADEMIC_HOUR_MIN } from '../schedule/time';

export const TEACHER_CATEGORIES = ['new', 'experienced'] as const;
export type TeacherCategory = (typeof TEACHER_CATEGORIES)[number];

/**
 * Правила оплаты преподавателей (решение заказчика):
 * за каждого пришедшего студента — процент от стоимости одного занятия по его абонементу;
 * новые преподаватели — 30 %, опытные — 50 %; за пропущенные студентом занятия оплаты нет.
 */
export interface PayrollSettings {
  rates: Record<TeacherCategory, number>;
  /** Статусы посещаемости, за которые преподавателю начисляется оплата. */
  paidStatuses: string[];
}

export const PAYROLL_DEFAULTS: PayrollSettings = {
  rates: { new: 30, experienced: 50 },
  paidStatuses: ['present', 'late'],
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: Prisma.Decimal | number | string | null | undefined) => Number(d ?? 0);

/** Цена одного занятия по абонементу. */
export function subscriptionLessonPrice(s: { price: unknown; lessonsTotal: number }) {
  return s.lessonsTotal > 0 ? num(s.price as number) / s.lessonsTotal : 0;
}

/** Сколько занятий в курсе при данной длительности занятия (48 ак. ч по 90 мин → 24). */
export function courseLessons(academicHours: number, lessonMinutes: number) {
  const perLesson = Math.max(1, Math.round(lessonMinutes / ACADEMIC_HOUR_MIN));
  return Math.max(1, Math.ceil(academicHours / perLesson));
}

type Tx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class FinanceService {
  constructor(private prisma: PrismaService) {}

  async payrollSettings(): Promise<PayrollSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'payroll' } });
    const v = (row?.value ?? {}) as Partial<PayrollSettings>;
    return { ...PAYROLL_DEFAULTS, ...v, rates: { ...PAYROLL_DEFAULTS.rates, ...(v.rates ?? {}) } };
  }

  /** Баланс студента = оплаты − возвраты − стоимость абонементов. Отрицательный — долг. */
  async recalcBalance(studentId: string, tx: Tx = this.prisma) {
    const [paid, sold] = await Promise.all([
      tx.payment.aggregate({ where: { studentId, deletedAt: null }, _sum: { amount: true } }),
      tx.subscription.aggregate({ where: { studentId }, _sum: { price: true } }),
    ]);
    const balance = round2(num(paid._sum.amount) - num(sold._sum.price));
    await tx.student.update({ where: { id: studentId }, data: { balance } });
    return balance;
  }

  /**
   * Распределение списанных занятий студента в группе по его абонементам (по очереди, от старых к новым).
   * Идемпотентно: пересчитывается целиком после каждой отметки или исправления.
   * Абонементы, закрытые переводом или расторжением, не трогаются.
   */
  async allocate(studentId: string, groupId: string) {
    const group = await this.prisma.group.findUnique({ where: { id: groupId }, select: { courseId: true } });
    if (!group) return;
    const subs = await this.prisma.subscription.findMany({
      where: {
        studentId,
        status: { in: ['active', 'finished'] },
        OR: [{ groupId }, { groupId: null, courseId: group.courseId }],
      },
      orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    });
    const subIds = subs.map((s) => s.id);
    const marks = await this.prisma.attendance.findMany({
      where: {
        studentId,
        lesson: { groupId },
        OR: [{ subscriptionId: null }, { subscriptionId: { in: subIds } }],
      },
      include: { lesson: { select: { startsAt: true } } },
      orderBy: { lesson: { startsAt: 'asc' } },
    });
    // Занятия по этим абонементам из других групп того же курса — уже заняли место.
    const foreign = subIds.length
      ? await this.prisma.attendance.groupBy({
          by: ['subscriptionId'],
          where: { subscriptionId: { in: subIds }, lesson: { groupId: { not: groupId } } },
          _count: true,
        })
      : [];
    const capacity = new Map(subs.map((s) => [s.id, s.lessonsTotal - (foreign.find((f) => f.subscriptionId === s.id)?._count ?? 0)]));

    const target = new Map<string | null, string[]>();
    let i = 0;
    for (const m of marks) {
      let sub: string | null = null;
      if (m.charged) {
        while (i < subs.length && (capacity.get(subs[i].id) ?? 0) <= 0) i++;
        if (i < subs.length) {
          sub = subs[i].id;
          capacity.set(sub, capacity.get(sub)! - 1);
        }
      }
      if (m.subscriptionId !== sub) target.set(sub, [...(target.get(sub) ?? []), m.lessonId]);
    }
    await this.prisma.$transaction(async (tx) => {
      for (const [sub, lessonIds] of target) {
        await tx.attendance.updateMany({ where: { studentId, lessonId: { in: lessonIds } }, data: { subscriptionId: sub } });
      }
      for (const s of subs) {
        const status = (capacity.get(s.id) ?? 0) <= 0 ? 'finished' : 'active';
        if (status !== s.status) await tx.subscription.update({ where: { id: s.id }, data: { status } });
      }
    });
  }

  /** Сколько занятий списано с абонемента. */
  async used(subscriptionId: string, tx: Tx = this.prisma) {
    return tx.attendance.count({ where: { subscriptionId } });
  }

  /**
   * Перевод в другую группу с перерасчётом остатка (ТЗ 3.4): старый абонемент закрывается
   * на использованных занятиях, остаток денег переносится в новый абонемент новой группы.
   */
  async transfer(studentId: string, fromGroupId: string, to: { id: string; courseId: string }, userId: string) {
    const subs = await this.prisma.subscription.findMany({
      where: { studentId, groupId: fromGroupId, status: 'active' },
    });
    if (!subs.length) return [];
    const toGroup = await this.prisma.group.findUniqueOrThrow({
      where: { id: to.id },
      include: { course: true, lessons: { where: { status: { not: 'cancelled' } }, take: 1, select: { startsAt: true, endsAt: true } } },
    });
    const rule = toGroup.scheduleRule as { start?: string; end?: string } | null;
    const minutes =
      toGroup.lessons[0]
        ? (+toGroup.lessons[0].endsAt - +toGroup.lessons[0].startsAt) / 60_000
        : rule?.start && rule?.end
          ? (+new Date(`1970-01-01T${rule.end}:00Z`) - +new Date(`1970-01-01T${rule.start}:00Z`)) / 60_000
          : 90;
    const newLessonPrice = num(toGroup.course.price) / courseLessons(toGroup.course.academicHours, minutes);

    const result: { from: string; to: string | null; used: number; rest: number; lessons: number }[] = [];
    for (const s of subs) {
      const used = await this.used(s.id);
      const lp = subscriptionLessonPrice(s);
      const usedValue = round2(used * lp);
      const rest = round2(num(s.price) - usedValue);
      await this.prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: s.id },
          data: { status: 'transferred', lessonsTotal: used, price: usedValue, closedAt: new Date(), closeReason: `Перевод в группу «${toGroup.name}»` },
        });
        if (rest > 0) {
          const created = await tx.subscription.create({
            data: {
              studentId,
              branchId: s.branchId,
              courseId: toGroup.courseId,
              groupId: toGroup.id,
              type: s.type,
              lessonsTotal: Math.max(1, Math.round(rest / (newLessonPrice || lp || 1))),
              basePrice: rest,
              price: rest,
              fromSubscriptionId: s.id,
              createdById: userId,
            },
          });
          result.push({ from: s.id, to: created.id, used, rest, lessons: created.lessonsTotal });
        } else {
          result.push({ from: s.id, to: null, used, rest: 0, lessons: 0 });
        }
      });
    }
    await this.recalcBalance(studentId);
    return result;
  }

  /**
   * Ведомость оплаты преподавателей за период (ТЗ 3.7).
   * Начисление = ставка категории × цена занятия по абонементу студента, за каждого пришедшего студента.
   */
  async payroll(where: { from: Date; to: Date; branchId?: string; teacherId?: string }) {
    const settings = await this.payrollSettings();
    const rows = await this.prisma.attendance.findMany({
      where: {
        lesson: {
          startsAt: { gte: where.from, lt: where.to },
          status: { not: 'cancelled' },
          teacherId: where.teacherId ?? { not: null },
          ...(where.branchId ? { group: { branchId: where.branchId } } : {}),
        },
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true } },
        subscription: { select: { price: true, lessonsTotal: true } },
        lesson: {
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            teacherId: true,
            teacher: { select: { id: true, firstName: true, lastName: true, teacherCategory: true } },
            group: { select: { id: true, name: true, course: { select: { price: true, academicHours: true } } } },
          },
        },
      },
      orderBy: { lesson: { startsAt: 'asc' } },
    });

    type Line = { lessonId: string; startsAt: Date; group: string; students: { name: string; status: string; lessonPrice: number; amount: number }[]; amount: number };
    const byTeacher = new Map<
      string,
      { teacher: { id: string; firstName: string; lastName: string }; category: string; rate: number; visits: number; missed: number; amount: number; lines: Map<string, Line> }
    >();
    for (const a of rows) {
      const l = a.lesson;
      const t = l.teacher!;
      const category = (t.teacherCategory as TeacherCategory) in settings.rates ? (t.teacherCategory as TeacherCategory) : 'new';
      const rate = settings.rates[category];
      const entry =
        byTeacher.get(t.id) ??
        { teacher: { id: t.id, firstName: t.firstName, lastName: t.lastName }, category, rate, visits: 0, missed: 0, amount: 0, lines: new Map<string, Line>() };
      byTeacher.set(t.id, entry);

      const minutes = (+l.endsAt - +l.startsAt) / 60_000;
      const lessonPrice = a.subscription
        ? subscriptionLessonPrice(a.subscription)
        : num(l.group.course.price) / courseLessons(l.group.course.academicHours, minutes);
      const paid = settings.paidStatuses.includes(a.status);
      const amount = paid ? round2((lessonPrice * rate) / 100) : 0;
      if (paid) entry.visits++;
      else entry.missed++;
      entry.amount = round2(entry.amount + amount);

      const line = entry.lines.get(l.id) ?? { lessonId: l.id, startsAt: l.startsAt, group: l.group.name, students: [], amount: 0 };
      line.students.push({ name: `${a.student.lastName} ${a.student.firstName}`, status: a.status, lessonPrice: round2(lessonPrice), amount });
      line.amount = round2(line.amount + amount);
      entry.lines.set(l.id, line);
    }
    const teachers = [...byTeacher.values()]
      .map(({ lines, ...t }) => ({
        ...t,
        lessons: lines.size,
        lines: [...lines.values()].map((l) => ({ ...l, students: l.students.sort((a, b) => a.name.localeCompare(b.name, 'ru')) })),
      }))
      .sort((a, b) => a.teacher.lastName.localeCompare(b.teacher.lastName));
    return { settings, teachers, total: round2(teachers.reduce((s, t) => s + t.amount, 0)) };
  }
}
