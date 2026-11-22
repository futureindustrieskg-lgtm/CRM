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
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { createHmac, timingSafeEqual } from 'crypto';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, Public, RequestContext, RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';
import { CHANNELS, channelStatus } from './channels';
import { ChatController } from './chat';
import { NotificationSettings, NotificationsService, Recipient } from './notifications.service';
import { DEFAULT_TEMPLATES, NOTIFICATION_TYPES } from './templates';

const LOCALES = ['ru', 'ky'];

class TemplateDto {
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty() @IsString() @MaxLength(2000) body: string;
}

class RuleDto {
  @ApiProperty() @IsBoolean() enabled: boolean;
  @ApiProperty({ enum: CHANNELS, isArray: true }) @IsArray() @IsIn(CHANNELS, { each: true }) channels: (typeof CHANNELS)[number][];
  @ApiProperty() @IsBoolean() parents: boolean;
}

class SettingsDto {
  @ApiProperty() @IsInt() @Min(1) @Max(24) reminderHours: number;
  @ApiProperty() @IsInt() @Min(0) @Max(23) dailyHour: number;
  @ApiProperty({ description: '{ [тип]: правило }' }) @IsObject() types: Record<string, RuleDto>;
}

class SegmentDto {
  @ApiPropertyOptional({ enum: ['students', 'leads'] }) @IsOptional() @IsIn(['students', 'leads']) audience?: 'students' | 'leads';
  @ApiPropertyOptional() @IsOptional() @IsString() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional({ description: 'Текущий уровень' }) @IsOptional() @IsString() level?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() groupId?: string;
  @ApiPropertyOptional({ description: 'Завершил группу уровня (например, A2 — все, кто закончил A2.x)' }) @IsOptional() @IsString() finishedLevel?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() debtOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeParents?: boolean;
  @ApiPropertyOptional({ description: 'Для лидов: этап воронки' }) @IsOptional() @IsString() stageId?: string;
}

class BroadcastDto {
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty({ description: 'Текст; поля {{name}}, {{student}}, {{center}}' }) @IsString() @MaxLength(2000) body: string;
  @ApiProperty({ type: SegmentDto }) @ValidateNested() @Type(() => SegmentDto) segment: SegmentDto;
}

class PreviewDto {
  @ApiProperty({ type: SegmentDto }) @ValidateNested() @Type(() => SegmentDto) segment: SegmentDto;
}

class ReadDto {
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) ids?: string[];
}

// ───── Привязка Telegram ─────

const linkSecret = () => process.env.TELEGRAM_LINK_SECRET || process.env.JWT_SECRET || 'dev';
const sign = (id: string) => createHmac('sha256', linkSecret()).update(id).digest('base64url').slice(0, 12);
/** Код для /start: id пользователя без дефисов + подпись (только [A-Za-z0-9_-], ≤ 64 символов). */
export const telegramCode = (userId: string) => `${userId.replace(/-/g, '')}_${sign(userId)}`;
function parseCode(code: string): string | null {
  const [hex, sig] = code.split('_');
  if (!/^[0-9a-f]{32}$/.test(hex ?? '') || !sig) return null;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const a = Buffer.from(sign(id));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private n: NotificationsService) {}

  /** Мои уведомления (колокольчик): последние 50 и число непрочитанных. */
  @Get('inbox')
  async inbox(@Ctx() ctx: RequestContext) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId: ctx.userId, status: { in: ['sent', 'simulated'] } },
        select: { id: true, type: true, title: true, body: true, createdAt: true, readAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.notification.count({ where: { userId: ctx.userId, status: { in: ['sent', 'simulated'] }, readAt: null } }),
    ]);
    return { items, unread };
  }

  @Post('inbox/read')
  async read(@Ctx() ctx: RequestContext, @Body() dto: ReadDto) {
    const r = await this.prisma.notification.updateMany({
      where: { userId: ctx.userId, readAt: null, ...(dto.ids?.length ? { id: { in: dto.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  }

  /** Ссылка для привязки Telegram-бота центра к своей учётной записи. */
  @Get('telegram-link')
  async telegramLink(@Ctx() ctx: RequestContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { telegramChatId: true } });
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    return { linked: !!user.telegramChatId, configured: !!bot && !!process.env.TELEGRAM_BOT_TOKEN, url: bot ? `https://t.me/${bot}?start=${telegramCode(ctx.userId)}` : null };
  }

  // ───── Администрирование ─────

  /** Журнал отправки: статус, канал, ошибка. Администратор филиала видит свой филиал. */
  @Get('log')
  @RequirePermissions('messages.update')
  log(@Ctx() ctx: RequestContext, @Query('status') status?: string, @Query('type') type?: string, @Query('search') search?: string) {
    const where: Prisma.NotificationWhereInput = { status, type };
    if (ctx.branchId) where.branchId = ctx.branchId;
    if (search) where.OR = [{ body: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }];
    return this.prisma.notification.findMany({
      where,
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  @Get('channels')
  @RequirePermissions('messages.update')
  channels() {
    return channelStatus();
  }

  @Get('settings')
  @RequirePermissions('messages.update')
  async settings() {
    return { settings: await this.n.settings(), types: Object.fromEntries(Object.entries(NOTIFICATION_TYPES).map(([k, v]) => [k, { name: v.name, vars: v.vars }])) };
  }

  /** Правила рассылки — для всего центра (владелец или администратор без филиала). */
  @Put('settings')
  @RequirePermissions('messages.update')
  async saveSettings(@Ctx() ctx: RequestContext, @Body() dto: SettingsDto) {
    if (ctx.branchId) throw new ForbiddenException('Правила уведомлений меняет администрация центра');
    const known = Object.keys(NOTIFICATION_TYPES);
    for (const [k, r] of Object.entries(dto.types)) {
      if (!known.includes(k)) throw new BadRequestException(`Неизвестный тип: ${k}`);
      if (!Array.isArray(r.channels) || !r.channels.length || r.channels.some((c) => !CHANNELS.includes(c))) throw new BadRequestException(`${k}: укажите каналы`);
    }
    const before = await this.n.settings();
    const value: NotificationSettings = { reminderHours: dto.reminderHours, dailyHour: dto.dailyHour, types: { ...before.types, ...dto.types } };
    await this.n.saveSettings(value);
    await this.audit.log({ userId: ctx.userId, entity: 'settings', entityId: 'notifications', action: 'update', before, after: value });
    return value;
  }

  /** Шаблоны по типам и языкам: изменённые в интерфейсе или по умолчанию. */
  @Get('templates')
  @RequirePermissions('messages.update')
  async templates() {
    const rows = await this.prisma.messageTemplate.findMany();
    return Object.keys(NOTIFICATION_TYPES)
      .filter((t) => t !== 'broadcast')
      .map((type) => ({
        type,
        name: NOTIFICATION_TYPES[type].name,
        vars: NOTIFICATION_TYPES[type].vars,
        locales: Object.fromEntries(
          LOCALES.map((l) => {
            const db = rows.find((r) => r.type === type && r.locale === l);
            const def = DEFAULT_TEMPLATES[type][l as 'ru' | 'ky'];
            return [l, { title: db?.title ?? def.title, body: db?.body ?? def.body, custom: !!db }];
          }),
        ),
      }));
  }

  @Put('templates/:type/:locale')
  @RequirePermissions('messages.update')
  async saveTemplate(@Ctx() ctx: RequestContext, @Param('type') type: string, @Param('locale') locale: string, @Body() dto: TemplateDto) {
    if (!NOTIFICATION_TYPES[type] || type === 'broadcast') throw new NotFoundException('Неизвестный тип сообщения');
    if (!LOCALES.includes(locale)) throw new BadRequestException('Язык: ru или ky');
    if (ctx.branchId) throw new ForbiddenException('Шаблоны меняет администрация центра');
    const t = await this.prisma.messageTemplate.upsert({
      where: { type_locale: { type, locale } },
      create: { type, locale, ...dto },
      update: dto,
    });
    await this.audit.log({ userId: ctx.userId, entity: 'template', entityId: `${type}:${locale}`, action: 'update', after: dto });
    return t;
  }

  // ───── Рассылки ─────

  private async segment(ctx: RequestContext, seg: SegmentDto): Promise<Recipient[]> {
    if (seg.audience === 'leads') {
      const leads = await this.prisma.lead.findMany({
        where: {
          mergedIntoId: null,
          ...branchScope(ctx, seg.branchId),
          ...(seg.stageId ? { stageId: seg.stageId } : { stage: { isLost: false, isWon: false } }),
          ...(seg.level ? { currentLevel: seg.level } : {}),
        },
        select: { id: true, firstName: true, phone: true, email: true, branchId: true },
        take: 5000,
      });
      return leads.map((l) => ({ leadId: l.id, branchId: l.branchId, phone: l.phone, email: l.email, locale: 'ru', name: l.firstName, key: `l${l.id}` }));
    }
    const where: Prisma.StudentWhereInput = { ...branchScope(ctx, seg.branchId) };
    if (seg.status) where.status = seg.status;
    if (seg.level) where.currentLevel = seg.level;
    if (seg.debtOnly) where.balance = { lt: 0 };
    const and: Prisma.StudentWhereInput[] = [];
    if (seg.groupId) and.push({ groups: { some: { groupId: seg.groupId, leftAt: null } } });
    if (seg.finishedLevel) and.push({ groups: { some: { group: { status: 'finished', course: { level: { startsWith: seg.finishedLevel } } } } } });
    if (and.length) where.AND = and;
    const ids = (await this.prisma.student.findMany({ where, select: { id: true }, take: 5000 })).map((s) => s.id);
    return this.n.studentRecipients(ids, { students: true, parents: !!seg.includeParents });
  }

  @Post('broadcasts/preview')
  @RequirePermissions('messages.update')
  async preview(@Ctx() ctx: RequestContext, @Body() dto: PreviewDto) {
    const rs = await this.segment(ctx, dto.segment);
    const s = await this.n.settings();
    const channels = s.types.broadcast.channels;
    const reachable = rs.filter((r) => channels.some((c) => (c === 'push' ? r.userId : c === 'telegram' ? r.telegramChatId : c === 'email' ? r.email : r.phone))).length;
    return { count: rs.length, reachable, sample: rs.slice(0, 10).map((r) => r.name + (r.student && r.student !== r.name ? ` (${r.student})` : '')) };
  }

  @Get('broadcasts')
  @RequirePermissions('messages.update')
  async broadcasts() {
    const rows = await this.prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const stats = await this.prisma.notification.groupBy({ by: ['broadcastId', 'status'], where: { broadcastId: { in: rows.map((r) => r.id) } }, _count: true });
    return rows.map((r) => ({ ...r, stats: Object.fromEntries(stats.filter((s) => s.broadcastId === r.id).map((s) => [s.status, s._count])) }));
  }

  /** Массовая рассылка по сегменту (ТЗ 3.8): например, всем завершившим A2 — предложение B1. */
  @Post('broadcasts')
  @RequirePermissions('messages.update')
  async broadcast(@Ctx() ctx: RequestContext, @Body() dto: BroadcastDto) {
    const rs = await this.segment(ctx, dto.segment);
    if (!rs.length) throw new BadRequestException('В сегменте нет получателей');
    const b = await this.prisma.broadcast.create({
      data: { title: dto.title, body: dto.body, segment: { ...dto.segment, branchId: ctx.branchId ?? dto.segment.branchId } as any, total: rs.length, createdById: ctx.userId, sentAt: new Date() },
    });
    const queued = await this.n.emit('broadcast', rs, {}, { broadcastId: b.id, template: { title: dto.title, body: dto.body }, dedupe: b.id });
    await this.audit.log({ userId: ctx.userId, entity: 'broadcast', entityId: b.id, action: 'create', after: { title: dto.title, segment: dto.segment, total: rs.length } });
    return { ...b, queued };
  }

  /** Обработать очередь и напоминания сейчас (без ожидания минутного цикла). */
  @Post('run')
  @RequirePermissions('messages.update')
  run(@Query('daily') daily?: string) {
    return this.n.tick(daily === '1');
  }
}

/** Webhook Telegram-бота: /start <код> привязывает чат к учётной записи. */
@ApiTags('webhooks')
@Controller('webhooks/telegram')
export class TelegramWebhookController {
  constructor(private prisma: PrismaService) {}

  @Public()
  @Post(':secret')
  async hook(@Param('secret') secret: string, @Body() body: any) {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected || secret.length !== expected.length || !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))) {
      throw new NotFoundException();
    }
    const text: string = body?.message?.text ?? '';
    const chatId = body?.message?.chat?.id;
    const m = text.match(/^\/start\s+(\S+)/);
    if (!m || !chatId) return { ok: true };
    const userId = parseCode(m[1]);
    if (userId) await this.prisma.user.updateMany({ where: { id: userId }, data: { telegramChatId: String(chatId) } });
    return { ok: true, linked: !!userId };
  }
}

@Global()
@Module({
  controllers: [NotificationsController, TelegramWebhookController, ChatController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
