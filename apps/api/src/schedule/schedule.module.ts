import {
  BadRequestException,
  Body,
  ConflictException,
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
import { IsDateString, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { pushToUser } from '../notifications/expo';
import { NotificationsService, when } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictService } from './conflicts';
import { canSeeAll, CoursesController, GroupsController, RoomsController } from './groups';

class LessonQueryDto {
  @ApiProperty() @IsDateString() from: string;
  @ApiProperty() @IsDateString() to: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() roomId?: string;
  @IsOptional() @IsString() teacherId?: string;
  @IsOptional() @IsString() groupId?: string;
}

class LessonCreateDto {
  @ApiProperty() @IsString() groupId: string;
  @ApiProperty() @IsDateString() startsAt: string;
  @ApiProperty() @IsDateString() endsAt: string;
  @ApiPropertyOptional() @IsOptional() @IsString() roomId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() teacherId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() topic?: string;
}

class LessonUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() roomId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() teacherId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() topic?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() onlineUrl?: string;
  @ApiPropertyOptional({ description: 'Обязательна при переносе и замене преподавателя' })
  @IsOptional()
  @IsString()
  reason?: string;
}

class ChangeRequestDto {
  @ApiProperty({ enum: ['move', 'cancel'] }) @IsIn(['move', 'cancel']) kind: 'move' | 'cancel';
  @ApiProperty() @IsString() @MaxLength(300) reason: string;
  @ApiPropertyOptional({ description: 'Предлагаемое время (текстом), для переноса' }) @IsOptional() @IsString() @MaxLength(100) proposed?: string;
}

class CancelDto {
  @ApiProperty() @IsString() reason: string;
}

const MAX_RANGE_DAYS = 62;

@ApiTags('schedule')
@ApiBearerAuth()
@Controller('lessons')
export class LessonsController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private conflicts: ConflictService,
    private notifications: NotificationsService,
  ) {}

  /** Календарь (ТЗ 3.3): разрезы — филиал, кабинет, преподаватель, группа. */
  @Get()
  @RequirePermissions('schedule.read')
  list(@Ctx() ctx: RequestContext, @Query() q: LessonQueryDto) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to > from)) throw new BadRequestException('Неверный период');
    if (+to - +from > MAX_RANGE_DAYS * 86_400_000) throw new BadRequestException(`Период не больше ${MAX_RANGE_DAYS} дней`);
    const where: Prisma.LessonWhereInput = {
      startsAt: { lt: to },
      endsAt: { gt: from },
      group: branchScope(ctx, q.branchId),
    };
    if (!canSeeAll(ctx)) where.teacherId = ctx.userId;
    else if (q.teacherId) where.teacherId = q.teacherId;
    if (q.roomId) where.roomId = q.roomId;
    if (q.groupId) where.groupId = q.groupId;
    return this.prisma.lesson.findMany({
      where,
      include: {
        group: {
          select: {
            id: true,
            name: true,
            branchId: true,
            course: { select: { name: true, level: true } },
            _count: { select: { students: { where: { leftAt: null, waitlist: false } } } },
          },
        },
        teacher: { select: { id: true, firstName: true, lastName: true } },
        room: { select: { id: true, name: true, isOnline: true } },
        _count: { select: { attendance: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 2000,
    });
  }

  /** Разовое (дополнительное) занятие группы. */
  @Post()
  @RequirePermissions('schedule.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: LessonCreateDto) {
    const g = await this.prisma.group.findFirst({ where: { id: dto.groupId, ...branchScope(ctx) } });
    if (!g) throw new NotFoundException('Группа не найдена');
    const slot = {
      startsAt: new Date(dto.startsAt),
      endsAt: new Date(dto.endsAt),
      teacherId: dto.teacherId ?? g.teacherId,
      roomId: dto.roomId ?? g.roomId,
    };
    if (!(slot.endsAt > slot.startsAt)) throw new BadRequestException('Конец занятия должен быть позже начала');
    await this.check(slot, g.id);
    const l = await this.prisma.lesson.create({ data: { ...slot, groupId: g.id, topic: dto.topic } });
    await this.audit.log({ userId: ctx.userId, entity: 'lesson', entityId: l.id, action: 'create', after: l });
    return l;
  }

  /** Перенос, смена кабинета, замена преподавателя (ТЗ 3.3). */
  @Patch(':id')
  @RequirePermissions('schedule.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: LessonUpdateDto) {
    const before = await this.findOwn(ctx, id);
    if (before.status === 'cancelled') throw new BadRequestException('Занятие отменено');
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : before.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : before.endsAt;
    if (!(endsAt > startsAt)) throw new BadRequestException('Конец занятия должен быть позже начала');

    const moved = +startsAt !== +before.startsAt || +endsAt !== +before.endsAt;
    const teacherChanged = dto.teacherId !== undefined && dto.teacherId !== before.teacherId;
    const roomChanged = dto.roomId !== undefined && dto.roomId !== before.roomId;
    if ((moved || teacherChanged) && !dto.reason?.trim()) {
      throw new BadRequestException('Укажите причину переноса или замены преподавателя');
    }
    if (dto.roomId && !(await this.prisma.room.findFirst({ where: { id: dto.roomId, branchId: before.group.branchId } }))) {
      throw new BadRequestException('Кабинет не из филиала группы');
    }
    if (moved || teacherChanged || roomChanged) {
      await this.check(
        {
          startsAt,
          endsAt,
          teacherId: dto.teacherId === undefined ? before.teacherId : dto.teacherId,
          roomId: dto.roomId === undefined ? before.roomId : dto.roomId,
        },
        before.groupId,
        id,
      );
    }
    const { reason, ...rest } = dto;
    const after = await this.prisma.lesson.update({
      where: { id },
      data: { ...rest, startsAt, endsAt },
    });
    const { group: _, ...beforePlain } = before;
    await this.audit.log({
      userId: ctx.userId,
      entity: 'lesson',
      entityId: id,
      action: moved ? 'move' : teacherChanged ? 'replace_teacher' : 'update',
      before: beforePlain,
      after,
      reason,
    });
    // Перенос или замена преподавателя — уведомление участникам (ТЗ 3.3, 3.8).
    if (moved || teacherChanged) {
      await this.notifyChange(after.id, moved ? `перенесено (${reason})` : `замена преподавателя (${reason})`);
    }
    return after;
  }

  /** Сообщение студентам группы (и родителям по правилу) об изменении занятия. */
  private async notifyChange(lessonId: string, reason: string) {
    const l = await this.prisma.lesson.findUniqueOrThrow({
      where: { id: lessonId },
      include: { group: { select: { name: true, students: { where: { leftAt: null, waitlist: false }, select: { studentId: true } } } } },
    });
    if (l.endsAt < new Date()) return;
    const rs = await this.notifications.forStudents('lesson_changed', l.group.students.map((s) => s.studentId));
    await this.notifications.emit('lesson_changed', rs, { group: l.group.name, reason, ...when(l.startsAt) }, { dedupe: `${l.id}:${Date.now()}` });
  }

  @Post(':id/cancel')
  @RequirePermissions('schedule.update')
  async cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: CancelDto) {
    if (!dto.reason?.trim()) throw new BadRequestException('Укажите причину отмены');
    const before = await this.findOwn(ctx, id);
    if (before.status === 'cancelled') throw new BadRequestException('Занятие уже отменено');
    const after = await this.prisma.lesson.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.log({ userId: ctx.userId, entity: 'lesson', entityId: id, action: 'cancel', before: { status: before.status }, after: { status: after.status }, reason: dto.reason });
    await this.notifyChange(id, `отменено (${dto.reason})`);
    return after;
  }

  @Post(':id/restore')
  @RequirePermissions('schedule.update')
  async restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const before = await this.findOwn(ctx, id);
    if (before.status !== 'cancelled') throw new BadRequestException('Занятие не отменено');
    await this.check(before, before.groupId, id);
    const after = await this.prisma.lesson.update({ where: { id }, data: { status: 'planned' } });
    await this.audit.log({ userId: ctx.userId, entity: 'lesson', entityId: id, action: 'restore', before: { status: before.status }, after: { status: after.status } });
    return after;
  }

  /**
   * Запрос преподавателя на перенос или отмену своего занятия (из приложения): у преподавателя нет права
   * менять расписание, поэтому администраторам филиала создаётся задача в CRM и отправляется push.
   */
  @Post(':id/change-request')
  @RequirePermissions('attendance.read')
  async changeRequest(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: ChangeRequestDto) {
    if (!dto.reason?.trim()) throw new BadRequestException('Укажите причину');
    const l = await this.findOwn(ctx, id);
    if (l.status === 'cancelled') throw new BadRequestException('Занятие уже отменено');
    if (l.endsAt < new Date()) throw new BadRequestException('Занятие уже прошло');
    const [teacher, group] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { firstName: true, lastName: true } }),
      this.prisma.group.findUniqueOrThrow({ where: { id: l.groupId }, select: { name: true, branchId: true } }),
    ]);
    // Администраторы филиала группы; если их нет — директор (роль на все филиалы).
    let admins = await this.prisma.userRole.findMany({
      where: { role: { code: 'branch_admin' }, branchId: group.branchId, user: { isActive: true } },
      select: { userId: true },
    });
    if (!admins.length) admins = await this.prisma.userRole.findMany({ where: { role: { code: 'owner' }, user: { isActive: true } }, select: { userId: true } });
    const ids = [...new Set(admins.map((a) => a.userId))].filter((u) => u !== ctx.userId);
    if (!ids.length) throw new BadRequestException('В филиале нет администратора для запроса');
    const w = when(l.startsAt);
    const what = dto.kind === 'cancel' ? 'отменить' : 'перенести';
    const title =
      `Запрос преподавателя ${teacher.firstName} ${teacher.lastName}: ${what} занятие «${group.name}» ${w.date} ${w.time}` +
      (dto.kind === 'move' && dto.proposed?.trim() ? ` → ${dto.proposed.trim()}` : '') +
      `. Причина: ${dto.reason.trim()}`;
    // Срок задачи — за 2 часа до занятия (но не раньше чем через 15 минут).
    const dueAt = new Date(Math.max(Date.now() + 15 * 60_000, +l.startsAt - 2 * 3600_000));
    await this.prisma.task.createMany({ data: ids.map((assigneeId) => ({ assigneeId, title: title.slice(0, 500), dueAt })) });
    await this.audit.log({ userId: ctx.userId, entity: 'lesson', entityId: id, action: `${dto.kind}_request`, after: { proposed: dto.proposed }, reason: dto.reason });
    for (const userId of ids) {
      await pushToUser(this.prisma, userId, { title: `Запрос: ${what} занятие`, body: title.slice(0, 200), data: { type: 'lesson_request', lessonId: id } });
    }
    return { sent: ids.length };
  }

  /** Проверка конфликтов перед сохранением отдельного занятия; при конфликте — 409. */
  private async check(
    slot: { startsAt: Date; endsAt: Date; teacherId: string | null; roomId: string | null },
    groupId: string,
    excludeId?: string,
  ) {
    const studentIds = (
      await this.prisma.groupStudent.findMany({ where: { groupId, leftAt: null, waitlist: false }, select: { studentId: true } })
    ).map((s) => s.studentId);
    const conflicts = await this.conflicts.find([{ ...slot, studentIds }], excludeId ? [excludeId] : []);
    if (conflicts.length) throw new ConflictException({ message: 'Конфликты расписания', conflicts });
  }

  private async findOwn(ctx: RequestContext, id: string) {
    const l = await this.prisma.lesson.findFirst({
      where: { id, group: branchScope(ctx), ...(canSeeAll(ctx) ? {} : { teacherId: ctx.userId }) },
      include: { group: { select: { branchId: true } } },
    });
    if (!l) throw new NotFoundException('Занятие не найдено');
    return l;
  }
}

@Module({
  controllers: [CoursesController, RoomsController, GroupsController, LessonsController],
  providers: [ConflictService],
})
export class ScheduleModule {}
