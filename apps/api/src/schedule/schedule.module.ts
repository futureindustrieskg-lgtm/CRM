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
import { IsDateString, IsOptional, IsString, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
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

class CancelDto {
  @ApiProperty() @IsString() reason: string;
}

const MAX_RANGE_DAYS = 62;

@ApiTags('schedule')
@ApiBearerAuth()
@Controller('lessons')
export class LessonsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private conflicts: ConflictService) {}

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
    // Push-уведомления участникам подключаются в итерации «Уведомления».
    return after;
  }

  @Post(':id/cancel')
  @RequirePermissions('schedule.update')
  async cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: CancelDto) {
    if (!dto.reason?.trim()) throw new BadRequestException('Укажите причину отмены');
    const before = await this.findOwn(ctx, id);
    if (before.status === 'cancelled') throw new BadRequestException('Занятие уже отменено');
    const after = await this.prisma.lesson.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.log({ userId: ctx.userId, entity: 'lesson', entityId: id, action: 'cancel', before: { status: before.status }, after: { status: after.status }, reason: dto.reason });
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
