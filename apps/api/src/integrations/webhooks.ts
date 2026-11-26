import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { createHmac, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit';
import { Ctx, RequestContext, RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';

/** События для исходящих webhook-ов (ТЗ 5: новый лид, оплата, зачисление). */
export const WEBHOOK_EVENTS = ['lead.created', 'lead.converted', 'payment.received', 'student.enrolled', 'subscription.created'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Повторы при ошибке: через 1 мин, 5 мин, 30 мин, 2 ч, 6 ч; затем — «failed». */
const BACKOFF_MIN = [1, 5, 30, 120, 360];

/**
 * Адрес не должен вести во внутреннюю сеть сервера (защита от SSRF).
 * Для разработки с локальным приёмником: WEBHOOK_ALLOW_PRIVATE=1.
 */
export function checkWebhookUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequestException('Неверный адрес');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new BadRequestException('Адрес должен начинаться с http:// или https://');
  if (process.env.WEBHOOK_ALLOW_PRIVATE === '1') return;
  if (u.protocol !== 'https:') throw new BadRequestException('Нужен https://');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const priv =
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '0.0.0.0' ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe80:/.test(h);
  if (priv) throw new BadRequestException('Адрес во внутренней сети недоступен для webhook-ов');
}

/** Подпись тела запроса: X-CRM-Signature: sha256=<hex HMAC(secret, "<timestamp>.<body>")>. */
export const signBody = (secret: string, timestamp: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Webhooks');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.NOTIFY_SCHEDULER === '0') return;
    this.timer = setInterval(() => this.process().catch((e) => this.log.error(e)), 30_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Поставить событие в очередь доставки всем подписанным адресам. Ошибки не мешают основной операции. */
  async emit(event: WebhookEvent, data: Record<string, unknown>) {
    try {
      const endpoints = await this.prisma.webhookEndpoint.findMany({ where: { isActive: true, events: { has: event } } });
      if (!endpoints.length) return 0;
      const payload = { event, createdAt: new Date().toISOString(), data };
      await this.prisma.webhookDelivery.createMany({ data: endpoints.map((e) => ({ endpointId: e.id, event, payload: payload as any })) });
      setImmediate(() => this.process().catch((e) => this.log.error(e)));
      return endpoints.length;
    } catch (e) {
      this.log.error(e);
      return 0;
    }
  }

  async deliver(id: string) {
    const d = await this.prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { endpoint: true } });
    const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
    const ts = String(Math.floor(Date.now() / 1000));
    let code: number | null = null;
    let error: string | null = null;
    try {
      checkWebhookUrl(d.endpoint.url);
      const r = await fetch(d.endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Deutschzentrum-CRM-Webhooks/1.0',
          'X-CRM-Event': d.event,
          'X-CRM-Delivery': d.id,
          'X-CRM-Timestamp': ts,
          'X-CRM-Signature': signBody(d.endpoint.secret, ts, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      code = r.status;
      if (!r.ok) error = `HTTP ${r.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const attempts = d.attempts + 1;
    const failed = !!error && attempts > BACKOFF_MIN.length;
    return this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        attempts,
        responseCode: code,
        error,
        status: error ? (failed ? 'failed' : 'pending') : 'sent',
        sentAt: error ? null : new Date(),
        nextAttemptAt: error && !failed ? new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000) : undefined,
      },
    });
  }

  async process() {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.webhookDelivery.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: new Date() }, endpoint: { isActive: true } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const d of due) await this.deliver(d.id);
    } finally {
      this.running = false;
    }
  }
}

class EndpointDto {
  @ApiProperty() @IsUrl({ require_tld: false, require_protocol: true }) @MaxLength(500) url: string;
  @ApiProperty({ enum: WEBHOOK_EVENTS, isArray: true }) @IsArray() @ArrayMinSize(1) @IsIn(WEBHOOK_EVENTS, { each: true }) events: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class EndpointUpdateDto extends PartialType(EndpointDto) {}

/** Настройка webhook-ов — владелец (право branches.update). Секрет показывается только при создании. */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/webhooks')
export class WebhooksController {
  constructor(private prisma: PrismaService, private audit: AuditService, private hooks: WebhooksService) {}

  @Get()
  @RequirePermissions('branches.update')
  async list() {
    const rows = await this.prisma.webhookEndpoint.findMany({ orderBy: { createdAt: 'desc' } });
    const stats = await this.prisma.webhookDelivery.groupBy({ by: ['endpointId', 'status'], _count: true });
    return rows.map(({ secret, ...e }) => ({
      ...e,
      secretHint: `${secret.slice(0, 6)}…`,
      stats: Object.fromEntries(stats.filter((s) => s.endpointId === e.id).map((s) => [s.status, s._count])),
    }));
  }

  @Get('events')
  @RequirePermissions('branches.update')
  events() {
    return WEBHOOK_EVENTS;
  }

  @Post()
  @RequirePermissions('branches.update')
  async create(@Ctx() ctx: RequestContext, @Body() dto: EndpointDto) {
    checkWebhookUrl(dto.url);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const e = await this.prisma.webhookEndpoint.create({ data: { ...dto, secret } });
    await this.audit.log({ userId: ctx.userId, entity: 'webhook', entityId: e.id, action: 'create', after: { url: e.url, events: e.events } });
    return e; // единственный раз, когда секрет возвращается целиком
  }

  @Patch(':id')
  @RequirePermissions('branches.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: EndpointUpdateDto) {
    if (dto.url) checkWebhookUrl(dto.url);
    const before = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Webhook не найден');
    const { secret: _, ...after } = await this.prisma.webhookEndpoint.update({ where: { id }, data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'webhook', entityId: id, action: 'update', before: { url: before.url, events: before.events, isActive: before.isActive }, after });
    return after;
  }

  @Delete(':id')
  @RequirePermissions('branches.update')
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.prisma.webhookEndpoint.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Webhook не найден');
    });
    await this.audit.log({ userId: ctx.userId, entity: 'webhook', entityId: id, action: 'delete' });
    return { ok: true };
  }

  @Get(':id/deliveries')
  @RequirePermissions('branches.update')
  deliveries(@Param('id') id: string) {
    return this.prisma.webhookDelivery.findMany({ where: { endpointId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  /** Проверочное событие «ping» — сразу, с ответом сервера-получателя. */
  @Post(':id/test')
  @RequirePermissions('branches.update')
  async test(@Param('id') id: string) {
    const e = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Webhook не найден');
    const d = await this.prisma.webhookDelivery.create({ data: { endpointId: id, event: 'ping', payload: { event: 'ping', createdAt: new Date().toISOString(), data: {} } } });
    return this.hooks.deliver(d.id);
  }

  /** Повторить доставку вручную (например, после исправления на стороне получателя). */
  @Post('deliveries/:id/retry')
  @RequirePermissions('branches.update')
  async retry(@Param('id') id: string) {
    await this.prisma.webhookDelivery.update({ where: { id }, data: { status: 'pending', nextAttemptAt: new Date() } });
    return this.hooks.deliver(id);
  }
}
