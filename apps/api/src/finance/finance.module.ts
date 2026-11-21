import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Global,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { hasPermission } from '../common/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { CENTER_TZ, localDate, zonedToUtc } from '../schedule/time';
import { FinanceService, PayrollSettings, subscriptionLessonPrice, TEACHER_CATEGORIES } from './finance.service';

export const SUB_TYPES = ['month', 'level', 'package', 'installment'] as const;
export const DISCOUNT_TYPES = ['family', 'friend', 'full_level', 'promo', 'other'] as const;
export const PAY_METHODS = ['cash', 'transfer', 'qr', 'card_online'] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const person = { select: { id: true, firstName: true, lastName: true } } as const;

/** Начало месяца, в который попадает момент d, по часовому поясу центра. */
const monthStart = (d: Date) => zonedToUtc(localDate(d, CENTER_TZ).slice(0, 8) + '01', '00:00', CENTER_TZ);

/** Период отчёта; по умолчанию — текущий месяц по часовому поясу центра. */
function period(from?: string, to?: string): { from: Date; to: Date } {
  const f = from ? new Date(from) : monthStart(new Date());
  const t = to ? new Date(to) : monthStart(new Date(+f + 32 * 86_400_000));
  if (!(t > f)) throw new BadRequestException('Неверный период');
  if (+t - +f > 400 * 86_400_000) throw new BadRequestException('Период не больше 400 дней');
  return { from: f, to: t };
}

// ───────────── Прайс-лист ─────────────

class TariffDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() courseId?: string;
  @ApiProperty({ enum: SUB_TYPES }) @IsIn(SUB_TYPES) type: string;
  @ApiProperty() @IsInt() @Min(1) @Max(500) lessons: number;
  @ApiProperty() @IsNumber() @Min(0) price: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(24) installments?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class TariffUpdateDto extends PartialType(TariffDto) {}

@ApiTags('finance')
@ApiBearerAuth()
@Controller('tariffs')
export class TariffsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @RequirePermissions('finance.read')
  list(@Query('courseId') courseId?: string, @Query('all') all?: string) {
    return this.prisma.tariff.findMany({
      where: { ...(all === '1' ? {} : { isActive: true }), ...(courseId ? { OR: [{ courseId }, { courseId: null }] } : {}) },
      include: { course: { select: { id: true, name: true } } },
      orderBy: [{ courseId: 'asc' }, { price: 'asc' }],
    });
  }

  @Post()
  @RequirePermissions('finance.update')
  async create(@Ctx() ctx: RequestContext, @Body() dto: TariffDto) {
    const t = await this.prisma.tariff.create({ data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'tariff', entityId: t.id, action: 'create', after: t });
    return t;
  }

  @Patch(':id')
  @RequirePermissions('finance.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: TariffUpdateDto) {
    const before = await this.prisma.tariff.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Тариф не найден');
    const after = await this.prisma.tariff.update({ where: { id }, data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'tariff', entityId: id, action: 'update', before, after });
    return after;
  }
}

// ───────────── Абонементы ─────────────

class SubscriptionDto {
  @ApiProperty() @IsString() studentId: string;
  @ApiPropertyOptional({ description: 'Группа; без неё абонемент действует в любой группе курса' })
  @IsOptional()
  @IsString()
  groupId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() courseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() tariffId?: string;
  @ApiPropertyOptional({ enum: SUB_TYPES }) @IsOptional() @IsIn(SUB_TYPES) type?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(500) lessonsTotal?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) basePrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @ApiPropertyOptional({ enum: DISCOUNT_TYPES }) @IsOptional() @IsIn(DISCOUNT_TYPES) discountType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() promoCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(24) installments?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
}

class CancelSubscriptionDto {
  @ApiProperty() @IsString() reason: string;
  @ApiPropertyOptional({ description: 'Вернуть деньги сразу: сумма возврата' }) @IsOptional() @IsNumber() @Min(0) refund?: number;
  @ApiPropertyOptional({ enum: PAY_METHODS }) @IsOptional() @IsIn(PAY_METHODS) method?: string;
}

@ApiTags('finance')
@ApiBearerAuth()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private finance: FinanceService) {}

  @Get()
  @RequirePermissions('finance.read')
  async list(
    @Ctx() ctx: RequestContext,
    @Query('studentId') studentId?: string,
    @Query('groupId') groupId?: string,
    @Query('status') status?: string,
    @Query('branchId') branchId?: string,
  ) {
    const rows = await this.prisma.subscription.findMany({
      where: { ...branchScope(ctx, branchId), studentId, groupId, status },
      include: {
        student: person,
        course: { select: { id: true, name: true } },
        group: { select: { id: true, name: true } },
        _count: { select: { attendance: true } },
      },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      take: 1000,
    });
    return rows.map(({ _count, ...s }) => ({
      ...s,
      used: _count.attendance,
      remaining: Math.max(0, s.lessonsTotal - _count.attendance),
      lessonPrice: round2(subscriptionLessonPrice(s)),
    }));
  }

  /** Продажа абонемента: цена из тарифа или вручную, скидка в процентах. Баланс студента уменьшается на цену. */
  @Post()
  @RequirePermissions('finance.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: SubscriptionDto) {
    const student = await this.prisma.student.findFirst({ where: { id: dto.studentId, ...branchScope(ctx) } });
    if (!student) throw new NotFoundException('Студент не найден');
    const tariff = dto.tariffId ? await this.prisma.tariff.findUnique({ where: { id: dto.tariffId } }) : null;
    if (dto.tariffId && !tariff) throw new BadRequestException('Тариф не найден');
    const group = dto.groupId
      ? await this.prisma.group.findFirst({ where: { id: dto.groupId, branchId: student.branchId } })
      : null;
    if (dto.groupId && !group) throw new BadRequestException('Группа не из филиала студента');
    const courseId = group?.courseId ?? dto.courseId ?? tariff?.courseId;
    if (!courseId) throw new BadRequestException('Укажите группу или курс');
    if (tariff?.courseId && tariff.courseId !== courseId) throw new BadRequestException('Тариф другого курса');

    const lessonsTotal = dto.lessonsTotal ?? tariff?.lessons;
    const basePrice = dto.basePrice ?? (tariff ? Number(tariff.price) : undefined);
    if (!lessonsTotal || basePrice === undefined) throw new BadRequestException('Укажите тариф или количество занятий и цену');
    const discount = dto.discountPercent ?? 0;
    if (discount > 0 && !dto.discountType) throw new BadRequestException('Укажите вид скидки');
    const price = round2(basePrice * (1 - discount / 100));

    const sub = await this.prisma.subscription.create({
      data: {
        studentId: student.id,
        branchId: student.branchId,
        courseId,
        groupId: group?.id,
        tariffId: tariff?.id,
        type: dto.type ?? tariff?.type ?? 'package',
        lessonsTotal,
        basePrice,
        discountPercent: discount,
        discountType: discount > 0 ? dto.discountType : null,
        promoCode: dto.promoCode,
        price,
        installments: dto.installments ?? tariff?.installments ?? 1,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        createdById: ctx.userId,
      },
    });
    // Занятия, списанные «в долг» до покупки, сразу ложатся на новый абонемент.
    if (group) await this.finance.allocate(student.id, group.id);
    else {
      const gs = await this.prisma.groupStudent.findMany({ where: { studentId: student.id, group: { courseId } }, select: { groupId: true } });
      for (const g of gs) await this.finance.allocate(student.id, g.groupId);
    }
    const balance = await this.finance.recalcBalance(student.id);
    await this.audit.log({ userId: ctx.userId, entity: 'subscription', entityId: sub.id, action: 'create', after: sub });
    return { ...sub, balance };
  }

  /**
   * Расторжение (ТЗ 3.7): цена абонемента пересчитывается по использованным занятиям,
   * переплата остаётся на балансе или сразу возвращается.
   */
  @Post(':id/cancel')
  @RequirePermissions('finance.update')
  async cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: CancelSubscriptionDto) {
    if (!dto.reason?.trim()) throw new BadRequestException('Укажите причину расторжения');
    const sub = await this.prisma.subscription.findFirst({ where: { id, ...branchScope(ctx) } });
    if (!sub) throw new NotFoundException('Абонемент не найден');
    if (!['active', 'finished'].includes(sub.status)) throw new BadRequestException('Абонемент уже закрыт');
    const used = await this.finance.used(id);
    const usedValue = round2(used * subscriptionLessonPrice(sub));
    // Возврат проверяем до любых изменений: переплата после расторжения = баланс + неиспользованная часть.
    const student = await this.prisma.student.findUniqueOrThrow({ where: { id: sub.studentId } });
    const available = round2(Number(student.balance) + Number(sub.price) - usedValue);
    if (dto.refund && dto.refund > available) {
      throw new BadRequestException(`Вернуть можно не больше ${Math.max(0, available)} сом`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id },
        data: { status: 'cancelled', lessonsTotal: used, price: usedValue, closedAt: new Date(), closeReason: dto.reason },
      });
      if (dto.refund) {
        await tx.payment.create({
          data: {
            branchId: sub.branchId,
            studentId: sub.studentId,
            subscriptionId: id,
            amount: -dto.refund,
            type: 'refund',
            method: dto.method ?? 'cash',
            comment: `Возврат при расторжении: ${dto.reason}`,
            createdById: ctx.userId,
          },
        });
      }
    });
    const balance = await this.finance.recalcBalance(sub.studentId);
    await this.audit.log({
      userId: ctx.userId,
      entity: 'subscription',
      entityId: id,
      action: 'cancel',
      before: { price: sub.price, lessonsTotal: sub.lessonsTotal },
      after: { price: usedValue, lessonsTotal: used, refund: dto.refund ?? 0 },
      reason: dto.reason,
    });
    return { used, price: usedValue, refund: dto.refund ?? 0, balance };
  }
}

// ───────────── Оплаты ─────────────

class PaymentDto {
  @ApiProperty() @IsString() studentId: string;
  @ApiProperty({ description: 'Сумма в сомах (KGS), больше нуля' }) @IsNumber() @Min(0.01) amount: number;
  @ApiProperty({ enum: PAY_METHODS }) @IsIn(PAY_METHODS) method: string;
  @ApiPropertyOptional({ enum: ['payment', 'refund'] }) @IsOptional() @IsIn(['payment', 'refund']) type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() subscriptionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() paidAt?: string;
}

class DeleteDto {
  @ApiProperty() @IsString() reason: string;
}

@ApiTags('finance')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private finance: FinanceService) {}

  @Get()
  @RequirePermissions('finance.read')
  list(
    @Ctx() ctx: RequestContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('method') method?: string,
    @Query('studentId') studentId?: string,
    @Query('deleted') deleted?: string,
  ) {
    const p = studentId && !from ? null : period(from, to);
    return this.prisma.payment.findMany({
      where: {
        ...branchScope(ctx, branchId),
        ...(p ? { paidAt: { gte: p.from, lt: p.to } } : {}),
        method,
        studentId,
        deletedAt: deleted === '1' ? { not: null } : null,
      },
      include: { student: person, branch: { select: { id: true, name: true } }, subscription: { select: { id: true, course: { select: { name: true } } } } },
      orderBy: { paidAt: 'desc' },
      take: 2000,
    });
  }

  /** Приём оплаты или возврат (касса, перевод, QR, онлайн). Возврат хранится отрицательной суммой. */
  @Post()
  @RequirePermissions('finance.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: PaymentDto) {
    const student = await this.prisma.student.findFirst({ where: { id: dto.studentId, ...branchScope(ctx) } });
    if (!student) throw new NotFoundException('Студент не найден');
    if (dto.subscriptionId && !(await this.prisma.subscription.findFirst({ where: { id: dto.subscriptionId, studentId: student.id } }))) {
      throw new BadRequestException('Абонемент другого студента');
    }
    const refund = dto.type === 'refund';
    if (refund && !hasPermission(ctx.permissions, 'finance.update')) throw new ForbiddenException('Возврат требует права finance.update');
    if (refund && dto.amount > Number(student.balance)) {
      throw new BadRequestException(`Вернуть можно не больше переплаты: ${Number(student.balance)} сом`);
    }
    const p = await this.prisma.payment.create({
      data: {
        branchId: student.branchId,
        studentId: student.id,
        subscriptionId: dto.subscriptionId,
        amount: refund ? -dto.amount : dto.amount,
        type: refund ? 'refund' : 'payment',
        method: dto.method,
        comment: dto.comment,
        paidAt: dto.paidAt ? new Date(dto.paidAt) : undefined,
        createdById: ctx.userId,
      },
    });
    const balance = await this.finance.recalcBalance(student.id);
    await this.audit.log({ userId: ctx.userId, entity: 'payment', entityId: p.id, action: refund ? 'refund' : 'create', after: p });
    return { ...p, balance };
  }

  /** Удаление финансовой записи — только с правом finance.delete_records и с причиной; запись остаётся в журнале. */
  @Post(':id/delete')
  @RequirePermissions('finance.delete_records')
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: DeleteDto) {
    if (!dto.reason?.trim()) throw new BadRequestException('Укажите причину удаления');
    const before = await this.prisma.payment.findFirst({ where: { id, ...branchScope(ctx), deletedAt: null } });
    if (!before) throw new NotFoundException('Оплата не найдена');
    const after = await this.prisma.payment.update({ where: { id }, data: { deletedAt: new Date(), deleteReason: dto.reason } });
    const balance = await this.finance.recalcBalance(before.studentId);
    await this.audit.log({ userId: ctx.userId, entity: 'payment', entityId: id, action: 'delete', before, after, reason: dto.reason });
    return { ok: true, balance };
  }
}

// ───────────── Должники и сводка ─────────────

@ApiTags('finance')
@ApiBearerAuth()
@Controller('finance')
export class FinanceController {
  constructor(private prisma: PrismaService) {}

  /**
   * Должники и заканчивающиеся абонементы: отрицательный баланс, занятия «в долг»
   * (списаны без абонемента), абонементы с остатком ≤ 2 занятий — пора выставить счёт.
   */
  @Get('debtors')
  @RequirePermissions('finance.read')
  async debtors(@Ctx() ctx: RequestContext, @Query('branchId') branchId?: string) {
    const scope = branchScope(ctx, branchId);
    const [negative, unpaid, subs] = await Promise.all([
      this.prisma.student.findMany({
        where: { ...scope, balance: { lt: 0 } },
        select: { id: true, firstName: true, lastName: true, phone: true, balance: true, status: true, branch: { select: { name: true } } },
        orderBy: { balance: 'asc' },
      }),
      this.prisma.attendance.groupBy({
        by: ['studentId'],
        where: { charged: true, subscriptionId: null, student: scope },
        _count: true,
      }),
      this.prisma.subscription.findMany({
        where: { ...scope, status: 'active' },
        include: { student: person, group: { select: { name: true } }, _count: { select: { attendance: true } } },
      }),
    ]);
    const ending = subs
      .map(({ _count, ...s }) => ({ ...s, used: _count.attendance, remaining: s.lessonsTotal - _count.attendance }))
      .filter((s) => s.remaining <= 2)
      .sort((a, b) => a.remaining - b.remaining);
    const unpaidIds = unpaid.map((u) => u.studentId);
    const unpaidStudents = unpaidIds.length
      ? await this.prisma.student.findMany({ where: { id: { in: unpaidIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const canContacts = hasPermission(ctx.permissions, 'students.contacts');
    return {
      negative: negative.map((s) => ({ ...s, phone: canContacts ? s.phone : null })),
      unpaidLessons: unpaid.map((u) => ({ student: unpaidStudents.find((s) => s.id === u.studentId), lessons: u._count })),
      ending,
    };
  }

  /** Сводка поступлений за период: по способам оплаты, филиалам и курсам; возвраты отдельно. */
  @Get('summary')
  @RequirePermissions('finance.read')
  async summary(@Ctx() ctx: RequestContext, @Query('from') from?: string, @Query('to') to?: string, @Query('branchId') branchId?: string) {
    const p = period(from, to);
    const where: Prisma.PaymentWhereInput = { ...branchScope(ctx, branchId), deletedAt: null, paidAt: { gte: p.from, lt: p.to } };
    const rows = await this.prisma.payment.findMany({
      where,
      select: { amount: true, type: true, method: true, branch: { select: { name: true } }, subscription: { select: { course: { select: { name: true } } } } },
    });
    const sum = (xs: typeof rows) => round2(xs.reduce((s, r) => s + Number(r.amount), 0));
    const groupBy = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, number>();
      for (const r of rows.filter((x) => x.type === 'payment')) m.set(key(r), round2((m.get(key(r)) ?? 0) + Number(r.amount)));
      return [...m.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
    };
    const sold = await this.prisma.subscription.aggregate({
      where: { ...branchScope(ctx, branchId), createdAt: { gte: p.from, lt: p.to } },
      _sum: { price: true },
      _count: true,
    });
    return {
      from: p.from,
      to: p.to,
      income: sum(rows.filter((r) => r.type === 'payment')),
      refunds: -sum(rows.filter((r) => r.type === 'refund')),
      net: sum(rows),
      byMethod: groupBy((r) => r.method),
      byBranch: groupBy((r) => r.branch.name),
      byCourse: groupBy((r) => r.subscription?.course.name ?? '—'),
      subscriptionsSold: sold._count,
      subscriptionsAmount: round2(Number(sold._sum.price ?? 0)),
    };
  }
}

// ───────────── Оплата преподавателей ─────────────

class RatesDto {
  @ApiProperty() @IsNumber() @Min(0) @Max(100) new: number;
  @ApiProperty() @IsNumber() @Min(0) @Max(100) experienced: number;
}
class PayrollSettingsDto {
  @ApiProperty({ type: RatesDto }) @ValidateNested() @Type(() => RatesDto) rates: RatesDto;
  @ApiProperty({ example: ['present', 'late'] }) @IsArray() @IsIn(['present', 'late', 'excused', 'absent'], { each: true }) paidStatuses: string[];
}
class CategoryDto {
  @ApiProperty({ enum: TEACHER_CATEGORIES }) @IsIn(TEACHER_CATEGORIES) category: string;
}

@ApiTags('finance')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollController {
  constructor(private prisma: PrismaService, private audit: AuditService, private finance: FinanceService) {}

  /** Ведомость по всем преподавателям (право finance.salaries). */
  @Get()
  @RequirePermissions('finance.salaries')
  all(
    @Ctx() ctx: RequestContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('teacherId') teacherId?: string,
  ) {
    return this.finance.payroll({ ...period(from, to), branchId: ctx.branchId ?? branchId, teacherId });
  }

  /** «Свой расчёт оплаты» для преподавателя (ТЗ 2) — без доступа к чужим начислениям. */
  @Get('my')
  my(@Ctx() ctx: RequestContext, @Query('from') from?: string, @Query('to') to?: string) {
    return this.finance.payroll({ ...period(from, to), teacherId: ctx.userId });
  }

  @Get('teachers')
  @RequirePermissions('finance.salaries')
  teachers(@Ctx() ctx: RequestContext) {
    return this.prisma.user.findMany({
      where: { roles: { some: { role: { code: 'teacher' }, ...(ctx.branchId ? { branchId: ctx.branchId } : {}) } } },
      select: { id: true, firstName: true, lastName: true, teacherCategory: true, isActive: true },
      orderBy: { lastName: 'asc' },
    });
  }

  @Patch('teachers/:id')
  @RequirePermissions('finance.salaries')
  async setCategory(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: CategoryDto) {
    const before = await this.prisma.user.findFirst({ where: { id, roles: { some: { role: { code: 'teacher' } } } } });
    if (!before) throw new NotFoundException('Преподаватель не найден');
    const after = await this.prisma.user.update({ where: { id }, data: { teacherCategory: dto.category }, select: { id: true, teacherCategory: true } });
    await this.audit.log({ userId: ctx.userId, entity: 'user', entityId: id, action: 'teacher_category', before: { category: before.teacherCategory }, after: { category: dto.category } });
    return after;
  }

  @Get('settings')
  @RequirePermissions('finance.salaries')
  settings() {
    return this.finance.payrollSettings();
  }

  @Put('settings')
  @RequirePermissions('finance.salaries')
  async saveSettings(@Ctx() ctx: RequestContext, @Body() dto: PayrollSettingsDto) {
    const before = await this.finance.payrollSettings();
    const value: PayrollSettings = { rates: { new: dto.rates.new, experienced: dto.rates.experienced }, paidStatuses: dto.paidStatuses };
    await this.prisma.setting.upsert({ where: { key: 'payroll' }, create: { key: 'payroll', value: value as any }, update: { value: value as any } });
    await this.audit.log({ userId: ctx.userId, entity: 'settings', entityId: 'payroll', action: 'update', before, after: value });
    return value;
  }
}

@Global()
@Module({
  controllers: [TariffsController, SubscriptionsController, PaymentsController, FinanceController, PayrollController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
