import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsDateString, IsEmail, IsIn, IsOptional, IsString } from 'class-validator';
import { AuditService } from '../audit/audit';
import { normalizePhone } from '../auth/auth';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { hasPermission } from '../common/permissions';
import { GOALS, LEVELS } from '../leads/leads.dto';
import { PrismaService } from '../prisma/prisma.service';

export const STUDENT_STATUSES = ['active', 'paused', 'finished', 'left'] as const;

class StudentFields {
  @ApiPropertyOptional() @IsOptional() @IsDateString() birthDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ enum: LEVELS }) @IsOptional() @IsIn(LEVELS) currentLevel?: string;
  @ApiPropertyOptional({ enum: LEVELS }) @IsOptional() @IsIn(LEVELS) targetLevel?: string;
  @ApiPropertyOptional({ enum: GOALS }) @IsOptional() @IsIn(GOALS) goal?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredTime?: string;
  @ApiPropertyOptional({ enum: STUDENT_STATUSES }) @IsOptional() @IsIn(STUDENT_STATUSES) status?: string;
}

class StudentCreateDto extends StudentFields {
  @ApiProperty() @IsString() firstName: string;
  @ApiProperty() @IsString() lastName: string;
  @ApiPropertyOptional() @IsOptional() @IsString() branchId?: string;
}

class StudentUpdateDto extends StudentFields {
  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() branchId?: string;
  @ApiPropertyOptional({ description: 'Отметить согласие на обработку ПД' }) @IsOptional() @IsDateString() consentAt?: string;
}

class StudentQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() level?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsIn(['1']) debt?: string;
}

/** Контакты скрываются от ролей без права students.contacts (например, преподаватель — ТЗ 2). */
function maskContacts<T extends { phone: string | null; email: string | null }>(ctx: RequestContext, s: T): T {
  if (hasPermission(ctx.permissions, 'students.contacts')) return s;
  return { ...s, phone: null, email: null };
}

@ApiTags('students')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @RequirePermissions('students.read')
  async list(@Ctx() ctx: RequestContext, @Query() q: StudentQueryDto) {
    const where: Prisma.StudentWhereInput = { ...branchScope(ctx, q.branchId) };
    if (q.status) where.status = q.status;
    if (q.level) where.currentLevel = q.level;
    if (q.debt) where.balance = { lt: 0 };
    if (q.search) {
      const digits = normalizePhone(q.search);
      where.OR = [
        { firstName: { contains: q.search, mode: 'insensitive' } },
        { lastName: { contains: q.search, mode: 'insensitive' } },
        ...(digits ? [{ phone: { contains: digits } }] : []),
      ];
    }
    const rows = await this.prisma.student.findMany({
      where,
      include: { branch: { select: { id: true, name: true } } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 1000,
    });
    return rows.map((s) => maskContacts(ctx, s));
  }

  @Get(':id')
  @RequirePermissions('students.read')
  async get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const s = await this.prisma.student.findFirst({
      where: { id, ...branchScope(ctx) },
      include: {
        branch: { select: { id: true, name: true } },
        parents: { include: { parent: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
        groups: { include: { group: { include: { course: true } } } },
        payments: { where: { deletedAt: null }, orderBy: { paidAt: 'desc' }, take: 50 },
        grades: { orderBy: { createdAt: 'desc' }, take: 50 },
        lead: { select: { id: true, source: true, utmSource: true, utmCampaign: true, createdAt: true } },
      },
    });
    if (!s) throw new NotFoundException('Студент не найден');
    return maskContacts(ctx, s);
  }

  @Post()
  @RequirePermissions('students.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: StudentCreateDto) {
    const branchId = ctx.branchId ?? dto.branchId;
    if (!branchId) throw new BadRequestException('Укажите филиал');
    const s = await this.prisma.student.create({
      data: {
        ...dto,
        branchId,
        phone: normalizePhone(dto.phone),
        email: dto.email?.toLowerCase(),
        birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      },
    });
    await this.audit.log({ userId: ctx.userId, entity: 'student', entityId: s.id, action: 'create', after: s });
    return s;
  }

  @Patch(':id')
  @RequirePermissions('students.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: StudentUpdateDto) {
    const before = await this.prisma.student.findFirst({ where: { id, ...branchScope(ctx) } });
    if (!before) throw new NotFoundException('Студент не найден');
    const after = await this.prisma.student.update({
      where: { id },
      data: {
        ...dto,
        branchId: ctx.branchId ? undefined : dto.branchId,
        phone: dto.phone !== undefined ? normalizePhone(dto.phone) : undefined,
        email: dto.email?.toLowerCase(),
        birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
        consentAt: dto.consentAt ? new Date(dto.consentAt) : undefined,
      },
    });
    await this.audit.log({ userId: ctx.userId, entity: 'student', entityId: id, action: 'update', before, after });
    return after;
  }
}

// ───────────── Задачи менеджера ─────────────

class TaskDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsDateString() dueAt: string;
  @ApiPropertyOptional() @IsOptional() @IsString() leadId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() assigneeId?: string;
}

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private prisma: PrismaService) {}

  /** Мои открытые задачи (по умолчанию) или все задачи филиала (?all=1, нужен leads.read_all). */
  @Get()
  @RequirePermissions('leads.read')
  list(@Ctx() ctx: RequestContext, @Query('all') all?: string, @Query('done') done?: string) {
    const everyone = all === '1' && hasPermission(ctx.permissions, 'leads.read_all');
    return this.prisma.task.findMany({
      where: {
        ...(everyone ? {} : { assigneeId: ctx.userId }),
        ...(everyone && ctx.branchId ? { lead: { branchId: ctx.branchId } } : {}),
        doneAt: done === '1' ? { not: null } : null,
      },
      include: {
        lead: { select: { id: true, firstName: true, lastName: true, phone: true } },
        assignee: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { dueAt: 'asc' },
      take: 300,
    });
  }

  @Post()
  @RequirePermissions('leads.update')
  create(@Ctx() ctx: RequestContext, @Body() dto: TaskDto) {
    return this.prisma.task.create({
      data: { title: dto.title, dueAt: new Date(dto.dueAt), leadId: dto.leadId, assigneeId: dto.assigneeId ?? ctx.userId },
    });
  }

  @Post(':id/done')
  @RequirePermissions('leads.update')
  async done(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const t = await this.prisma.task.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    if (t.assigneeId !== ctx.userId && !hasPermission(ctx.permissions, 'leads.read_all')) {
      throw new NotFoundException();
    }
    return this.prisma.task.update({ where: { id }, data: { doneAt: t.doneAt ? null : new Date() } });
  }
}

// ───────────── Дашборд ─────────────

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async summary(@Ctx() ctx: RequestContext, @Query('branchId') branchId?: string) {
    const scope = branchScope(ctx, branchId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const canLeads = hasPermission(ctx.permissions, 'leads.read');
    const canStudents = hasPermission(ctx.permissions, 'students.read');
    const canFinance = hasPermission(ctx.permissions, 'finance.read');
    const leadScope: Prisma.LeadWhereInput = {
      mergedIntoId: null,
      ...scope,
      ...(hasPermission(ctx.permissions, 'leads.read_all') ? {} : { managerId: ctx.userId }),
    };

    const [stages, byStage, newToday, newMonth, wonMonth, activeStudents, debtors, overdue, revenueMonth] =
      await Promise.all([
        this.prisma.pipelineStage.findMany({ orderBy: { sort: 'asc' } }),
        canLeads ? this.prisma.lead.groupBy({ by: ['stageId'], where: leadScope, _count: true }) : [],
        canLeads ? this.prisma.lead.count({ where: { ...leadScope, createdAt: { gte: today } } }) : 0,
        canLeads ? this.prisma.lead.count({ where: { ...leadScope, createdAt: { gte: monthStart } } }) : 0,
        canLeads
          ? this.prisma.lead.count({ where: { ...leadScope, createdAt: { gte: monthStart }, stage: { isWon: true } } })
          : 0,
        canStudents ? this.prisma.student.count({ where: { ...scope, status: 'active' } }) : 0,
        canStudents ? this.prisma.student.count({ where: { ...scope, balance: { lt: 0 } } }) : 0,
        this.prisma.task.count({ where: { assigneeId: ctx.userId, doneAt: null, dueAt: { lt: new Date() } } }),
        canFinance
          ? this.prisma.payment.aggregate({
              where: { ...scope, deletedAt: null, paidAt: { gte: monthStart } },
              _sum: { amount: true },
            })
          : null,
      ]);

    return {
      funnel: stages.map((s) => ({
        stageId: s.id,
        name: s.name,
        color: s.color,
        count: (byStage as { stageId: string; _count: number }[]).find((b) => b.stageId === s.id)?._count ?? 0,
      })),
      newLeadsToday: newToday,
      newLeadsMonth: newMonth,
      conversionMonth: newMonth ? Math.round((wonMonth / newMonth) * 1000) / 10 : 0,
      activeStudents,
      debtors,
      overdueTasks: overdue,
      revenueMonth: revenueMonth ? Number(revenueMonth._sum.amount ?? 0) : null,
    };
  }
}

@Module({ controllers: [StudentsController, TasksController, DashboardController] })
export class StudentsModule {}
