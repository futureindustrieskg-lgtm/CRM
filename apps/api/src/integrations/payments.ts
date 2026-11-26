/**
 * Онлайн-оплата по ссылке (эквайринг / QR банка) и фискальные чеки (ЭКМ) — ТЗ 3.7, 5.
 *
 * Банк ещё не выбран, поэтому шлюз подключается через универсальный адаптер:
 *   PAYMENT_GATEWAY_URL — создание платежа: POST JSON { orderId, amount, currency, description, returnUrl, callbackUrl } → { paymentUrl }
 *   PAYMENT_WEBHOOK_SECRET — подпись уведомления банка: заголовок X-Signature = hex HMAC-SHA256(тело запроса)
 *   уведомление: POST /api/v1/webhooks/payments  { orderId, status: "paid", transactionId, method?: "qr" | "card" }
 * Для проверки без банка: PAYMENTS_TEST_MODE=1 — на странице оплаты появляется кнопка тестовой оплаты.
 *
 * Онлайн-касса: FISCAL_API_URL (+ FISCAL_API_TOKEN) — POST JSON чека → { fiscalNumber }.
 * Без кассы чеки создаются в режиме имитации (статус simulated) и видны в разделе «Интеграции».
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, Public, RequestContext, RequirePermissions } from '../common/context';
import { FinanceService } from '../finance/finance.service';
import { CENTER_NAME, fmtSom, NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from './webhooks';

const env = (k: string) => process.env[k]?.trim() || '';
export const paymentsTestMode = () => env('PAYMENTS_TEST_MODE') === '1';
export const gatewayConfigured = () => !!env('PAYMENT_GATEWAY_URL');
export const fiscalConfigured = () => !!env('FISCAL_API_URL');
export const LINK_TTL_HOURS = 72;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ───────────── Фискальные чеки ─────────────

@Injectable()
export class FiscalService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Fiscal');
  private timer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.NOTIFY_SCHEDULER === '0') return;
    this.timer = setInterval(() => this.retry().catch((e) => this.log.error(e)), 60_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Чек по оплате или возврату (один на оплату). */
  async issue(paymentId: string) {
    const existing = await this.prisma.fiscalReceipt.findUnique({ where: { paymentId } });
    const r = existing ?? (await this.prisma.fiscalReceipt.create({ data: { paymentId } }));
    return this.send(r.id);
  }

  private async send(id: string) {
    const r = await this.prisma.fiscalReceipt.findUniqueOrThrow({
      where: { id },
      include: { payment: { include: { student: { select: { firstName: true, lastName: true, phone: true, email: true } }, subscription: { select: { course: { select: { name: true } } } } } } },
    });
    if (r.status === 'sent' || r.status === 'simulated') return r;
    if (!fiscalConfigured()) {
      return this.prisma.fiscalReceipt.update({ where: { id }, data: { status: 'simulated', provider: 'simulated', attempts: { increment: 1 }, sentAt: new Date() } });
    }
    const p = r.payment;
    const amount = Math.abs(Number(p.amount));
    try {
      const res = await fetch(env('FISCAL_API_URL'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(env('FISCAL_API_TOKEN') ? { Authorization: `Bearer ${env('FISCAL_API_TOKEN')}` } : {}) },
        body: JSON.stringify({
          externalId: p.id,
          type: p.type === 'refund' ? 'income_return' : 'income',
          paymentMethod: p.method === 'cash' ? 'cash' : 'cashless',
          total: amount,
          currency: p.currency,
          items: [{ name: `Обучение немецкому языку${p.subscription ? `: ${p.subscription.course.name}` : ''}`, price: amount, quantity: 1, vat: 'none' }],
          client: { name: `${p.student.lastName} ${p.student.firstName}`, phone: p.student.phone, email: p.student.email },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const d = (await res.json().catch(() => ({}))) as { fiscalNumber?: string };
      return this.prisma.fiscalReceipt.update({ where: { id }, data: { status: 'sent', provider: 'fiscal_api', fiscalNumber: d.fiscalNumber ?? null, error: null, attempts: { increment: 1 }, sentAt: new Date() } });
    } catch (e) {
      return this.prisma.fiscalReceipt.update({ where: { id }, data: { status: 'failed', error: e instanceof Error ? e.message : String(e), attempts: { increment: 1 } } });
    }
  }

  /** Повтор неотправленных чеков (до 10 попыток). */
  async retry() {
    const rows = await this.prisma.fiscalReceipt.findMany({ where: { status: { in: ['pending', 'failed'] }, attempts: { lt: 10 } }, take: 50 });
    for (const r of rows) await this.send(r.id);
  }
}

// ───────────── Ссылки на оплату ─────────────

@Injectable()
export class PaymentLinksService {
  private log = new Logger('PaymentLinks');

  constructor(
    private prisma: PrismaService,
    private finance: FinanceService,
    private notifications: NotificationsService,
    private webhooks: WebhooksService,
    private fiscal: FiscalService,
  ) {}

  /**
   * Зачисление оплаты по ссылке: ровно один раз (повторное уведомление банка ничего не меняет),
   * затем баланс, уведомление клиенту, webhook и фискальный чек.
   */
  async complete(token: string, provider: string, providerRef: string | null, method: 'qr' | 'card_online') {
    const link = await this.prisma.paymentLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundException('Ссылка не найдена');
    if (link.status === 'paid') return { already: true, paymentId: link.paymentId };
    if (link.status !== 'pending') throw new BadRequestException('Ссылка недействительна');
    const payment = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.paymentLink.updateMany({ where: { id: link.id, status: 'pending' }, data: { status: 'paid', paidAt: new Date(), provider, providerRef } });
      if (!claimed.count) return null;
      const p = await tx.payment.create({
        data: {
          branchId: link.branchId,
          studentId: link.studentId,
          subscriptionId: link.subscriptionId,
          amount: link.amount,
          method,
          type: 'payment',
          comment: `Онлайн-оплата по ссылке (${provider}${providerRef ? `, ${providerRef}` : ''})`,
        },
      });
      await tx.paymentLink.update({ where: { id: link.id }, data: { paymentId: p.id } });
      return p;
    });
    if (!payment) return { already: true };
    const balance = await this.finance.recalcBalance(link.studentId);
    await this.afterPayment(payment.id, link.studentId, Number(link.amount), balance);
    return { paymentId: payment.id, balance };
  }

  /** Общие действия после любой оплаты: уведомление, webhook, фискальный чек. */
  async afterPayment(paymentId: string, studentId: string, amount: number, balance: number, notify = true) {
    try {
      if (notify) {
        const rs = await this.notifications.forStudents('payment_received', [studentId]);
        await this.notifications.emit('payment_received', rs, { amount: fmtSom(amount), balance: fmtSom(balance) }, { dedupe: paymentId });
      }
      await this.webhooks.emit('payment.received', { paymentId, studentId, amount, balance });
      await this.fiscal.issue(paymentId);
    } catch (e) {
      this.log.error(e);
    }
  }
}

class LinkDto {
  @ApiProperty() @IsString() studentId: string;
  @ApiPropertyOptional({ description: 'Сумма; по умолчанию — долг студента (минус баланса)' }) @IsOptional() @IsNumber() @Min(1) amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() subscriptionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
}

@ApiTags('finance')
@ApiBearerAuth()
@Controller('payment-links')
export class PaymentLinksController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @RequirePermissions('finance.read')
  list(@Ctx() ctx: RequestContext, @Query('studentId') studentId?: string) {
    return this.prisma.paymentLink.findMany({
      where: { studentId, ...branchScope(ctx) },
      include: { student: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Ссылка для клиента (WhatsApp / SMS): страница оплаты без входа в систему. */
  @Post()
  @RequirePermissions('finance.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: LinkDto) {
    const s = await this.prisma.student.findFirst({ where: { id: dto.studentId, ...branchScope(ctx) } });
    if (!s) throw new NotFoundException('Студент не найден');
    if (dto.subscriptionId && !(await this.prisma.subscription.findFirst({ where: { id: dto.subscriptionId, studentId: s.id } }))) {
      throw new BadRequestException('Абонемент другого студента');
    }
    const amount = round2(dto.amount ?? -Number(s.balance));
    if (!(amount > 0)) throw new BadRequestException('У студента нет долга — укажите сумму');
    const link = await this.prisma.paymentLink.create({
      data: {
        token: randomBytes(18).toString('base64url'),
        studentId: s.id,
        branchId: s.branchId,
        subscriptionId: dto.subscriptionId,
        amount,
        description: dto.description?.trim() || `Оплата обучения: ${s.lastName} ${s.firstName}`,
        expiresAt: new Date(Date.now() + LINK_TTL_HOURS * 3600_000),
        createdById: ctx.userId,
      },
    });
    await this.audit.log({ userId: ctx.userId, entity: 'payment_link', entityId: link.id, action: 'create', after: { amount, studentId: s.id } });
    return { ...link, path: `/pay/${link.token}` };
  }

  @Post(':id/cancel')
  @RequirePermissions('finance.update')
  async cancel(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const r = await this.prisma.paymentLink.updateMany({ where: { id, status: 'pending', ...branchScope(ctx) }, data: { status: 'cancelled' } });
    if (!r.count) throw new BadRequestException('Ссылку нельзя отменить');
    await this.audit.log({ userId: ctx.userId, entity: 'payment_link', entityId: id, action: 'cancel' });
    return { ok: true };
  }
}

class StartDto {
  @ApiPropertyOptional({ enum: ['card', 'qr'] }) @IsOptional() @IsIn(['card', 'qr']) method?: 'card' | 'qr';
}

/** Страница оплаты для клиента (без входа). */
@ApiTags('public')
@Controller('public/pay')
export class PublicPayController {
  constructor(private prisma: PrismaService, private links: PaymentLinksService) {}

  private async link(token: string) {
    const l = await this.prisma.paymentLink.findUnique({ where: { token } });
    if (!l) throw new NotFoundException('Ссылка не найдена');
    if (l.status === 'pending' && l.expiresAt < new Date()) {
      await this.prisma.paymentLink.update({ where: { id: l.id }, data: { status: 'expired' } });
      return { ...l, status: 'expired' };
    }
    return l;
  }

  @Public()
  @Get(':token')
  async info(@Param('token') token: string) {
    const l = await this.link(token);
    const company = await this.prisma.setting.findUnique({ where: { key: 'company' } });
    const c = (company?.value ?? {}) as { name?: string; brand?: string };
    return {
      amount: Number(l.amount),
      currency: 'KGS',
      description: l.description,
      status: l.status,
      expiresAt: l.expiresAt,
      paidAt: l.paidAt,
      recipient: c.name || CENTER_NAME,
      methods: { gateway: gatewayConfigured(), test: paymentsTestMode() },
    };
  }

  /** Начать оплату: переход на страницу банка (или тестовый режим). */
  @Public()
  @Post(':token/start')
  async start(@Param('token') token: string, @Body() dto: StartDto) {
    const l = await this.link(token);
    if (l.status !== 'pending') throw new BadRequestException('Ссылка недействительна');
    if (!gatewayConfigured()) {
      if (paymentsTestMode()) return { mode: 'test' };
      throw new BadRequestException('Онлайн-оплата пока не подключена. Оплатите в филиале или переводом.');
    }
    const base = env('PUBLIC_WEB_URL') || 'http://localhost:5173';
    const r = await fetch(env('PAYMENT_GATEWAY_URL'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env('PAYMENT_GATEWAY_TOKEN') ? { Authorization: `Bearer ${env('PAYMENT_GATEWAY_TOKEN')}` } : {}) },
      body: JSON.stringify({
        orderId: l.token,
        amount: Number(l.amount),
        currency: 'KGS',
        description: l.description,
        method: dto.method ?? 'card',
        returnUrl: `${base}/pay/${l.token}`,
        callbackUrl: `${env('PUBLIC_API_URL') || 'http://localhost:3000'}/api/v1/webhooks/payments`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new BadRequestException('Банк временно недоступен, попробуйте позже');
    const d = (await r.json()) as { paymentUrl?: string };
    if (!d.paymentUrl?.startsWith('https://')) throw new BadRequestException('Банк вернул неверный адрес оплаты');
    return { mode: 'redirect', url: d.paymentUrl };
  }

  /** Тестовая оплата — только при PAYMENTS_TEST_MODE=1 (разработка, демонстрация). */
  @Public()
  @Post(':token/test-complete')
  async testComplete(@Param('token') token: string, @Body() dto: StartDto) {
    if (!paymentsTestMode()) throw new NotFoundException();
    return this.links.complete(token, 'test', `TEST-${Date.now()}`, dto.method === 'qr' ? 'qr' : 'card_online');
  }
}

/** Уведомление банка об оплате (подпись HMAC-SHA256 в X-Signature). */
@ApiTags('webhooks')
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private links: PaymentLinksService) {}

  @Public()
  @Post()
  async hook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-signature') signature: string | undefined, @Body() body: { orderId?: string; status?: string; transactionId?: string; method?: string }) {
    const secret = env('PAYMENT_WEBHOOK_SECRET');
    if (!secret) throw new NotFoundException();
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body));
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const ok = !!signature && signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!ok) throw new BadRequestException('Неверная подпись');
    if (body.status !== 'paid' || !body.orderId) return { ok: true, ignored: true };
    return this.links.complete(body.orderId, 'gateway', body.transactionId ?? null, body.method === 'qr' ? 'qr' : 'card_online');
  }
}
