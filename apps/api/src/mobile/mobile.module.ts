/**
 * API мобильного приложения (этап 4): устройства для push и кабинет клиента.
 * Студент видит себя, родитель — своих детей (ParentStudent): баланс, абонементы, ближайшие занятия
 * со ссылкой на онлайн-урок, посещаемость, оценки, оплата долга по ссылке.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit';
import { Ctx, RequestContext } from '../common/context';
import { OnlineMeetingService } from '../integrations/online';
import { LINK_TTL_HOURS } from '../integrations/payments';
import { isExpoToken } from '../notifications/expo';
import { PrismaService } from '../prisma/prisma.service';

class DeviceDto {
  @ApiProperty({ description: 'Expo push token: ExponentPushToken[…]' }) @IsString() @MaxLength(200) token: string;
  @ApiProperty({ enum: ['android', 'ios', 'web'] }) @IsIn(['android', 'ios', 'web']) platform: string;
}
class TokenDto {
  @ApiProperty() @IsString() @MaxLength(200) token: string;
}

const UPCOMING_DAYS = 14;
const HISTORY = 20;
const round2 = (n: number) => Math.round(n * 100) / 100;

@ApiTags('mobile')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private prisma: PrismaService, private online: OnlineMeetingService, private audit: AuditService) {}

  /** Регистрация телефона для push. Токен переходит к текущему пользователю (сменили учётную запись на телефоне). */
  @Post('devices')
  @HttpCode(204)
  async addDevice(@Ctx() ctx: RequestContext, @Body() dto: DeviceDto) {
    if (!isExpoToken(dto.token)) throw new BadRequestException('Неверный push-токен');
    await this.prisma.pushDevice.upsert({
      where: { token: dto.token },
      create: { token: dto.token, platform: dto.platform, userId: ctx.userId },
      update: { userId: ctx.userId, platform: dto.platform, lastSeenAt: new Date() },
    });
  }

  /** При выходе из приложения push на этот телефон больше не приходят. */
  @Post('devices/remove')
  @HttpCode(204)
  async removeDevice(@Ctx() ctx: RequestContext, @Body() dto: TokenDto) {
    await this.prisma.pushDevice.deleteMany({ where: { token: dto.token, userId: ctx.userId } });
  }

  /** Студенты, доступные клиенту: студент — он сам, родитель — его дети. */
  private async studentIds(ctx: RequestContext): Promise<string[]> {
    if (ctx.roleCode === 'student') {
      const s = await this.prisma.student.findFirst({ where: { userId: ctx.userId }, select: { id: true } });
      if (!s) throw new ForbiddenException('Учётная запись не связана со студентом');
      return [s.id];
    }
    if (ctx.roleCode === 'parent') {
      const links = await this.prisma.parentStudent.findMany({ where: { parentId: ctx.userId }, select: { studentId: true } });
      return links.map((l) => l.studentId);
    }
    throw new ForbiddenException('Кабинет — для студентов и родителей');
  }

  /** Всё для главного экрана приложения одним запросом (экономия трафика). */
  @Get('cabinet')
  async cabinet(@Ctx() ctx: RequestContext) {
    const ids = await this.studentIds(ctx);
    const now = Date.now();
    const students = [];
    for (const id of ids) {
      const s = await this.prisma.student.findUniqueOrThrow({
        where: { id },
        select: { id: true, firstName: true, lastName: true, balance: true, currentLevel: true },
      });
      const groups = await this.prisma.groupStudent.findMany({
        where: { studentId: id, leftAt: null, waitlist: false },
        select: { group: { select: { id: true, name: true } } },
      });
      const [subs, lessons, attendance, grades] = await Promise.all([
        this.prisma.subscription.findMany({
          where: { studentId: id, status: 'active' },
          select: {
            id: true,
            lessonsTotal: true,
            price: true,
            type: true,
            course: { select: { name: true } },
            group: { select: { name: true } },
            _count: { select: { attendance: { where: { charged: true } } } },
          },
          orderBy: { startDate: 'asc' },
        }),
        this.prisma.lesson.findMany({
          where: {
            groupId: { in: groups.map((g) => g.group.id) },
            status: 'planned',
            endsAt: { gt: new Date(now) },
            startsAt: { lt: new Date(now + UPCOMING_DAYS * 86_400_000) },
          },
          include: {
            group: { select: { name: true, onlineUrl: true, course: { select: { format: true } } } },
            room: { select: { name: true, isOnline: true } },
            teacher: { select: { firstName: true, lastName: true } },
            courseTopic: { select: { title: true } },
          },
          orderBy: { startsAt: 'asc' },
          take: 20,
        }),
        this.prisma.attendance.findMany({
          where: { studentId: id },
          select: { status: true, lesson: { select: { startsAt: true, group: { select: { name: true } } } } },
          orderBy: { lesson: { startsAt: 'desc' } },
          take: HISTORY,
        }),
        this.prisma.grade.findMany({
          where: { studentId: id },
          select: { skill: true, value: true, scale: true, maxValue: true, createdAt: true, lesson: { select: { startsAt: true } } },
          orderBy: { createdAt: 'desc' },
          take: HISTORY,
        }),
      ]);
      const upcoming = [];
      for (const l of lessons) {
        const online = this.online.isOnline(l);
        // Ссылка появляется за час до начала (как в веб-кабинете).
        const url = online && +l.startsAt - now < 3600_000 ? await this.online.ensureLink(l.id) : l.onlineUrl;
        upcoming.push({
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
      students.push({
        id: s.id,
        name: `${s.firstName} ${s.lastName}`,
        level: s.currentLevel,
        balance: Number(s.balance),
        groups: groups.map((g) => g.group.name),
        subscriptions: subs.map((x) => ({
          id: x.id,
          name: x.group?.name ?? x.course.name,
          type: x.type,
          price: Number(x.price),
          lessonsTotal: x.lessonsTotal,
          lessonsLeft: Math.max(0, x.lessonsTotal - x._count.attendance),
        })),
        upcoming,
        attendance: attendance.map((a) => ({ date: a.lesson.startsAt, group: a.lesson.group.name, status: a.status })),
        grades: grades.map((g) => ({
          date: g.lesson?.startsAt ?? g.createdAt,
          skill: g.skill,
          value: Number(g.value),
          scale: g.scale,
          maxValue: g.maxValue === null ? null : Number(g.maxValue),
        })),
      });
    }
    return { role: ctx.roleCode, students };
  }

  /**
   * Оплатить долг из приложения: ссылка на страницу оплаты (QR / карта).
   * Повторный запрос возвращает ту же действующую ссылку, а не плодит новые.
   */
  @Post('students/:id/pay')
  async pay(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const ids = await this.studentIds(ctx);
    if (!ids.includes(id)) throw new NotFoundException('Студент не найден');
    const s = await this.prisma.student.findUniqueOrThrow({ where: { id } });
    const amount = round2(-Number(s.balance));
    if (!(amount > 0)) throw new BadRequestException('Долга нет');
    const existing = await this.prisma.paymentLink.findFirst({
      where: { studentId: id, status: 'pending', amount, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const link =
      existing ??
      (await this.prisma.paymentLink.create({
        data: {
          token: randomBytes(18).toString('base64url'),
          studentId: id,
          branchId: s.branchId,
          amount,
          description: `Оплата обучения: ${s.lastName} ${s.firstName}`,
          expiresAt: new Date(Date.now() + LINK_TTL_HOURS * 3600_000),
          createdById: ctx.userId,
        },
      }));
    if (!existing) await this.audit.log({ userId: ctx.userId, entity: 'payment_link', entityId: link.id, action: 'create', after: { amount, studentId: id, from: 'app' } });
    const base = (process.env.PUBLIC_WEB_URL?.trim() || 'http://localhost:5173').replace(/\/$/, '');
    return { amount, url: `${base}/pay/${link.token}` };
  }
}

@Module({ controllers: [MeController] })
export class MobileModule {}
