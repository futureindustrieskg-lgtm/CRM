import { Controller, Get, Global, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';

const toJson = (v: unknown) =>
  v === undefined || v === null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);

/** Журнал действий: кто, когда и что изменил (ТЗ 2). */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  log(params: {
    userId?: string;
    entity: string;
    entityId: string;
    action: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        userId: params.userId,
        entity: params.entity,
        entityId: params.entityId,
        action: params.action,
        before: toJson(params.before),
        after: toJson(params.after),
        reason: params.reason,
      },
    });
  }
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(@Query('entity') entity?: string, @Query('entityId') entityId?: string, @Query('take') take = '100') {
    return this.prisma.auditLog.findMany({
      where: { entity, entityId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(take) || 100, 500),
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
  }
}

@Global()
@Module({ providers: [AuditService], controllers: [AuditController], exports: [AuditService] })
export class AuditModule {}
