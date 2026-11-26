import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit';
import { normalizePhone } from '../auth/auth';
import { RequestContext } from '../common/context';
import { hasPermission } from '../common/permissions';
import { WebhooksService } from '../integrations/webhooks';
import { PrismaService } from '../prisma/prisma.service';
import { LeadCreateDto, LeadQueryDto, LeadUpdateDto } from './leads.dto';

const leadInclude = {
  stage: true,
  branch: { select: { id: true, name: true } },
  manager: { select: { id: true, firstName: true, lastName: true } },
  student: { select: { id: true } },
} satisfies Prisma.LeadInclude;

@Injectable()
export class LeadsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private config: ConfigService,
    private webhooks: WebhooksService,
  ) {}

  /**
   * Ограничение видимости: филиал активной роли; без права leads.read_all — только свои лиды.
   */
  private scope(ctx: RequestContext): Prisma.LeadWhereInput {
    const where: Prisma.LeadWhereInput = { mergedIntoId: null };
    if (ctx.branchId) where.branchId = ctx.branchId;
    if (!hasPermission(ctx.permissions, 'leads.read_all')) where.managerId = ctx.userId;
    return where;
  }

  async list(ctx: RequestContext, q: LeadQueryDto) {
    const where: Prisma.LeadWhereInput = { ...this.scope(ctx) };
    if (q.stageId) where.stageId = q.stageId;
    if (q.managerId) where.managerId = q.managerId;
    if (q.source) where.source = q.source;
    if (q.branchId && !ctx.branchId) where.branchId = q.branchId;
    if (q.search) {
      const digits = normalizePhone(q.search);
      where.OR = [
        { firstName: { contains: q.search, mode: 'insensitive' } },
        { lastName: { contains: q.search, mode: 'insensitive' } },
        { email: { contains: q.search, mode: 'insensitive' } },
        ...(digits ? [{ phone: { contains: digits } }] : []),
      ];
    }
    return this.prisma.lead.findMany({ where, include: leadInclude, orderBy: { createdAt: 'desc' }, take: 500 });
  }

  async get(ctx: RequestContext, id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, ...this.scope(ctx) },
      include: {
        ...leadInclude,
        activities: {
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
        },
        tasks: { orderBy: { dueAt: 'asc' } },
      },
    });
    if (!lead) throw new NotFoundException('Лид не найден');
    return lead;
  }

  /** Поиск дублей по телефону и e-mail (ТЗ 3.1). */
  async duplicates(ctx: RequestContext, phone?: string, email?: string, excludeId?: string) {
    const p = normalizePhone(phone);
    const e = email?.trim().toLowerCase();
    if (!p && !e) return [];
    return this.prisma.lead.findMany({
      where: {
        mergedIntoId: null,
        id: excludeId ? { not: excludeId } : undefined,
        ...(ctx.branchId ? { branchId: ctx.branchId } : {}),
        OR: [...(p ? [{ phone: p }] : []), ...(e ? [{ email: e }] : [])],
      },
      include: leadInclude,
    });
  }

  /**
   * Создание лида (вручную или из внешнего канала).
   * ctx = null — системное создание (webhook сайта, мессенджеры).
   */
  async create(ctx: RequestContext | null, dto: LeadCreateDto) {
    const branchId = ctx?.branchId ?? dto.branchId ?? null;
    const stage = dto.stageId
      ? await this.prisma.pipelineStage.findUniqueOrThrow({ where: { id: dto.stageId } })
      : await this.prisma.pipelineStage.findFirstOrThrow({ orderBy: { sort: 'asc' } });

    let managerId = dto.managerId ?? null;
    if (!managerId) {
      managerId = ctx && ctx.roleCode === 'sales_manager' ? ctx.userId : await this.nextManager(branchId);
    }

    const { utm, ...rest } = dto;
    const lead = await this.prisma.lead.create({
      data: {
        ...rest,
        utmSource: utm?.source ?? dto.utmSource,
        utmMedium: utm?.medium ?? dto.utmMedium,
        utmCampaign: utm?.campaign ?? dto.utmCampaign,
        utmContent: utm?.content ?? dto.utmContent,
        utmTerm: utm?.term ?? dto.utmTerm,
        phone: normalizePhone(dto.phone),
        email: dto.email?.trim().toLowerCase() || null,
        branchId,
        stageId: stage.id,
        managerId,
      },
      include: leadInclude,
    });

    const dups = await this.duplicates(ctx ?? this.systemCtx(), lead.phone ?? undefined, lead.email ?? undefined, lead.id);
    await this.prisma.leadActivity.create({
      data: {
        leadId: lead.id,
        userId: ctx?.userId,
        type: 'system',
        text: `Лид создан (источник: ${lead.source})` + (dups.length ? `. Найдено возможных дублей: ${dups.length}` : ''),
        meta: dups.length ? { duplicates: dups.map((d) => d.id) } : undefined,
      },
    });

    // Контроль первого касания (ТЗ 3.1): задача менеджеру со сроком N минут.
    if (managerId) {
      const minutes = Number(this.config.get('FIRST_CONTACT_MINUTES') ?? 15);
      await this.prisma.task.create({
        data: {
          leadId: lead.id,
          assigneeId: managerId,
          title: 'Первое касание: связаться с клиентом',
          dueAt: new Date(Date.now() + minutes * 60_000),
        },
      });
    }

    await this.audit.log({ userId: ctx?.userId, entity: 'lead', entityId: lead.id, action: 'create', after: lead });
    await this.webhooks.emit('lead.created', { leadId: lead.id, firstName: lead.firstName, lastName: lead.lastName, phone: lead.phone, email: lead.email, source: lead.source, branchId: lead.branchId, utmSource: lead.utmSource, utmCampaign: lead.utmCampaign });
    return { ...lead, duplicates: dups };
  }

  async update(ctx: RequestContext, id: string, dto: LeadUpdateDto) {
    const before = await this.get(ctx, id);
    const data: Prisma.LeadUncheckedUpdateInput = { ...dto };
    if (dto.phone !== undefined) data.phone = normalizePhone(dto.phone);
    if (dto.email !== undefined) data.email = dto.email?.trim().toLowerCase() || null;
    if (ctx.branchId) delete data.branchId;
    const after = await this.prisma.lead.update({ where: { id }, data, include: leadInclude });
    await this.audit.log({ userId: ctx.userId, entity: 'lead', entityId: id, action: 'update', before: strip(before), after });
    return after;
  }

  /** Перевод по воронке. «Отказ» — только с причиной. */
  async moveStage(ctx: RequestContext, id: string, stageId: string, lostReason?: string) {
    const lead = await this.get(ctx, id);
    const stage = await this.prisma.pipelineStage.findUnique({ where: { id: stageId } });
    if (!stage) throw new NotFoundException('Этап не найден');
    if (stage.isLost && !lostReason?.trim()) throw new BadRequestException('Укажите причину отказа');
    if (lead.stageId === stageId) return lead;

    const after = await this.prisma.lead.update({
      where: { id },
      data: {
        stageId,
        lostReason: stage.isLost ? lostReason!.trim() : null,
        firstContactAt: lead.firstContactAt ?? new Date(),
      },
      include: leadInclude,
    });
    await this.prisma.leadActivity.create({
      data: {
        leadId: id,
        userId: ctx.userId,
        type: 'stage_change',
        text: `${lead.stage.name} → ${stage.name}` + (stage.isLost ? `. Причина: ${lostReason}` : ''),
        meta: { from: lead.stageId, to: stageId },
      },
    });
    await this.audit.log({
      userId: ctx.userId,
      entity: 'lead',
      entityId: id,
      action: 'stage_change',
      before: { stageId: lead.stageId },
      after: { stageId },
      reason: lostReason,
    });
    return after;
  }

  async addActivity(ctx: RequestContext, id: string, type: string, text: string) {
    const lead = await this.get(ctx, id);
    const activity = await this.prisma.leadActivity.create({
      data: { leadId: id, userId: ctx.userId, type, text },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!lead.firstContactAt && (type === 'call' || type === 'message')) {
      await this.prisma.lead.update({ where: { id }, data: { firstContactAt: new Date() } });
    }
    return activity;
  }

  /** Объединение карточек: source поглощается target (ТЗ 3.1). */
  async merge(ctx: RequestContext, targetId: string, sourceId: string) {
    if (targetId === sourceId) throw new BadRequestException('Нельзя объединить лид с самим собой');
    const target = await this.get(ctx, targetId);
    const source = await this.get(ctx, sourceId);
    await this.prisma.$transaction([
      this.prisma.leadActivity.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
      this.prisma.task.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
      this.prisma.lead.update({
        where: { id: targetId },
        data: {
          phone: target.phone ?? source.phone,
          email: target.email ?? source.email,
          lastName: target.lastName ?? source.lastName,
          utmSource: target.utmSource ?? source.utmSource,
          utmCampaign: target.utmCampaign ?? source.utmCampaign,
        },
      }),
      this.prisma.lead.update({ where: { id: sourceId }, data: { mergedIntoId: targetId } }),
      this.prisma.leadActivity.create({
        data: {
          leadId: targetId,
          userId: ctx.userId,
          type: 'system',
          text: `Объединён с карточкой «${source.firstName} ${source.lastName ?? ''}» (${source.source})`.trim(),
        },
      }),
    ]);
    await this.audit.log({
      userId: ctx.userId,
      entity: 'lead',
      entityId: targetId,
      action: 'merge',
      before: strip(source),
      after: { mergedFrom: sourceId },
    });
    return this.get(ctx, targetId);
  }

  /** Перевод лида в студенты: создаёт карточку студента и ставит этап «Зачислен». */
  async convert(ctx: RequestContext, id: string) {
    const lead = await this.get(ctx, id);
    if (lead.student) throw new BadRequestException('Лид уже переведён в студенты');
    const branchId = lead.branchId ?? ctx.branchId;
    if (!branchId) throw new BadRequestException('Укажите филиал лида');
    if (!hasPermission(ctx.permissions, 'students.create')) throw new ForbiddenException('Нет прав: students.create');

    const student = await this.prisma.student.create({
      data: {
        leadId: lead.id,
        branchId,
        firstName: lead.firstName,
        lastName: lead.lastName ?? '',
        phone: lead.phone,
        email: lead.email,
        currentLevel: lead.currentLevel,
        targetLevel: lead.targetLevel,
        goal: lead.goal,
        preferredTime: lead.preferredTime,
      },
    });
    const won = await this.prisma.pipelineStage.findFirst({ where: { isWon: true } });
    if (won) await this.moveStage(ctx, id, won.id);
    await this.audit.log({ userId: ctx.userId, entity: 'student', entityId: student.id, action: 'create', after: student });
    await this.webhooks.emit('lead.converted', { leadId: id, studentId: student.id, branchId: student.branchId });
    return student;
  }

  /** Распределение по очереди: менеджер филиала, которому дольше всего не назначали лид. */
  private async nextManager(branchId: string | null): Promise<string | null> {
    const managers = await this.prisma.user.findMany({
      where: {
        isActive: true,
        roles: {
          some: {
            role: { code: 'sales_manager' },
            ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
          },
        },
      },
      select: { id: true, managedLeads: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
    });
    if (!managers.length) return null;
    managers.sort(
      (a, b) => (a.managedLeads[0]?.createdAt.getTime() ?? 0) - (b.managedLeads[0]?.createdAt.getTime() ?? 0),
    );
    return managers[0].id;
  }

  private systemCtx(): RequestContext {
    return { userId: '', activeRoleId: '', roleCode: 'system', permissions: ['*'], branchId: null };
  }
}

function strip<T extends Record<string, unknown>>(lead: T) {
  const { activities, tasks, ...rest } = lead as Record<string, unknown>;
  return rest;
}
