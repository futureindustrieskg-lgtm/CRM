import { Controller, ForbiddenException, Get, Global, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { hasPermission } from '../common/permissions';
import { channelStatus } from '../notifications/channels';
import { PrismaService } from '../prisma/prisma.service';
import { OnlineMeetingService, onlineProvider, zoomConfigured } from './online';
import {
  FiscalService,
  fiscalConfigured,
  gatewayConfigured,
  PaymentLinksController,
  PaymentLinksService,
  paymentsTestMode,
  PublicPayController,
  PaymentWebhookController,
} from './payments';
import { WebhooksController, WebhooksService } from './webhooks';

@ApiTags('integrations')
@ApiBearerAuth()
@Controller()
export class IntegrationsController {
  constructor(private prisma: PrismaService, private online: OnlineMeetingService) {}

  /** Состояние интеграций: что подключено ключами, что работает в тестовом режиме или имитации. */
  @Get('integrations/status')
  @RequirePermissions('branches.update')
  status() {
    return {
      channels: channelStatus(),
      online: { provider: onlineProvider(), zoom: zoomConfigured() },
      payments: { gateway: gatewayConfigured(), testMode: paymentsTestMode() },
      fiscal: { configured: fiscalConfigured() },
      push: { fcm: false, note: 'Push в мобильное приложение (FCM) — этап 4' },
    };
  }

  @Get('integrations/fiscal')
  @RequirePermissions('finance.read')
  fiscal(@Ctx() ctx: RequestContext) {
    return this.prisma.fiscalReceipt.findMany({
      where: { payment: branchScope(ctx) },
      include: { payment: { select: { amount: true, type: true, method: true, paidAt: true, student: { select: { firstName: true, lastName: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Ссылка на онлайн-занятие: создать (Zoom / Jitsi) — администратор или преподаватель занятия. */
  @Post('lessons/:id/online-link')
  @RequirePermissions('schedule.read')
  async lessonLink(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const l = await this.prisma.lesson.findFirst({ where: { id, group: branchScope(ctx) } });
    if (!l) throw new NotFoundException('Занятие не найдено');
    if (!hasPermission(ctx.permissions, 'schedule.update') && l.teacherId !== ctx.userId) throw new ForbiddenException('Ссылку создаёт администратор или преподаватель занятия');
    return { url: await this.online.ensureLink(id, true) };
  }

  /** Ближайшие занятия студента (2 недели) со ссылкой на онлайн-урок. */
  @Get('my/lessons')
  @RequirePermissions('schedule.read')
  async myLessons(@Ctx() ctx: RequestContext) {
    if (ctx.roleCode !== 'student') throw new ForbiddenException('Раздел для студентов');
    const s = await this.prisma.student.findFirst({ where: { userId: ctx.userId } });
    if (!s) throw new ForbiddenException('Учётная запись не связана со студентом');
    const groups = await this.prisma.groupStudent.findMany({ where: { studentId: s.id, leftAt: null, waitlist: false }, select: { groupId: true } });
    const now = Date.now();
    const lessons = await this.prisma.lesson.findMany({
      where: { groupId: { in: groups.map((g) => g.groupId) }, status: 'planned', endsAt: { gt: new Date(now) }, startsAt: { lt: new Date(now + 14 * 86_400_000) } },
      include: {
        group: { select: { name: true, onlineUrl: true, course: { select: { format: true } } } },
        room: { select: { name: true, isOnline: true } },
        teacher: { select: { firstName: true, lastName: true } },
        courseTopic: { select: { title: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
    });
    const out = [];
    for (const l of lessons) {
      const online = this.online.isOnline(l);
      // Ссылку создаём заранее только для ближайших занятий (за час до начала).
      const url = online && +l.startsAt - now < 3600_000 ? await this.online.ensureLink(l.id) : l.onlineUrl;
      out.push({
        id: l.id,
        startsAt: l.startsAt,
        endsAt: l.endsAt,
        group: l.group.name,
        room: l.room?.name ?? null,
        teacher: l.teacher ? `${l.teacher.firstName} ${l.teacher.lastName}` : null,
        topic: l.courseTopic?.title ?? l.topic,
        online,
        onlineUrl: url,
      });
    }
    return out;
  }
}

@Global()
@Module({
  controllers: [IntegrationsController, WebhooksController, PaymentLinksController, PublicPayController, PaymentWebhookController],
  providers: [WebhooksService, OnlineMeetingService, FiscalService, PaymentLinksService],
  exports: [WebhooksService, OnlineMeetingService, FiscalService, PaymentLinksService],
})
export class IntegrationsModule {}
