import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, OmitType, PartialType } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { hasPermission } from '../common/permissions';
import { FinanceService } from '../finance/finance.service';
import { WebhooksService } from '../integrations/webhooks';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictService } from './conflicts';
import { generateSlots, hoursPerLesson, localDate, ScheduleRule, validateRule, zonedToUtc } from './time';

export const COURSE_LEVELS = [
  'A1', 'A1.1', 'A1.2', 'A2', 'A2.1', 'A2.2', 'B1', 'B1.1', 'B1.2', 'B2', 'B2.1', 'B2.2', 'C1', 'C2',
];
export const COURSE_FORMATS = ['group', 'individual', 'mini_group', 'online'];
export const GROUP_STATUSES = ['recruiting', 'running', 'finished'];

/** Роль видит всё расписание филиала, а не только свои группы и занятия. */
export const canSeeAll = (ctx: RequestContext) => hasPermission(ctx.permissions, 'schedule.read_all');

// ───────────── Курсы ─────────────

class CourseCreateDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty({ enum: COURSE_LEVELS }) @IsIn(COURSE_LEVELS) level: string;
  @ApiProperty({ enum: COURSE_FORMATS }) @IsIn(COURSE_FORMATS) format: string;
  @ApiProperty() @IsInt() @Min(1) @Max(1000) academicHours: number;
  @ApiProperty() @IsNumber() @Min(0) price: number;
  @ApiPropertyOptional() @IsOptional() @IsString() textbook?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class CourseUpdateDto extends PartialType(CourseCreateDto) {}

@ApiTags('groups')
@ApiBearerAuth()
@Controller('courses')
export class CoursesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @RequirePermissions('groups.read')
  list(@Query('all') all?: string) {
    return this.prisma.course.findMany({
      where: all === '1' ? {} : { isActive: true },
      include: { _count: { select: { groups: true, topics: true } } },
      orderBy: [{ level: 'asc' }, { name: 'asc' }],
    });
  }

  @Post()
  @RequirePermissions('groups.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: CourseCreateDto) {
    const c = await this.prisma.course.create({ data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'course', entityId: c.id, action: 'create', after: c });
    return c;
  }

  @Patch(':id')
  @RequirePermissions('groups.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: CourseUpdateDto) {
    const before = await this.prisma.course.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Курс не найден');
    const after = await this.prisma.course.update({ where: { id }, data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'course', entityId: id, action: 'update', before, after });
    return after;
  }
}

// ───────────── Кабинеты ─────────────

class RoomCreateDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(500) capacity?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isOnline?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() branchId?: string;
}

class RoomUpdateDto extends PartialType(OmitType(RoomCreateDto, ['branchId'] as const)) {}

@ApiTags('schedule')
@ApiBearerAuth()
@Controller('rooms')
export class RoomsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @RequirePermissions('schedule.read')
  list(@Ctx() ctx: RequestContext, @Query('branchId') branchId?: string) {
    return this.prisma.room.findMany({
      where: branchScope(ctx, branchId),
      include: { branch: { select: { id: true, name: true } } },
      orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
    });
  }

  @Post()
  @RequirePermissions('schedule.update')
  async create(@Ctx() ctx: RequestContext, @Body() dto: RoomCreateDto) {
    const branchId = ctx.branchId ?? dto.branchId;
    if (!branchId) throw new BadRequestException('Укажите филиал');
    const r = await this.prisma.room.create({ data: { ...dto, branchId } });
    await this.audit.log({ userId: ctx.userId, entity: 'room', entityId: r.id, action: 'create', after: r });
    return r;
  }

  @Patch(':id')
  @RequirePermissions('schedule.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: RoomUpdateDto) {
    const before = await this.prisma.room.findFirst({ where: { id, ...branchScope(ctx) } });
    if (!before) throw new NotFoundException('Кабинет не найден');
    const after = await this.prisma.room.update({ where: { id }, data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'room', entityId: id, action: 'update', before, after });
    return after;
  }
}

// ───────────── Группы ─────────────

class ScheduleRuleDto implements ScheduleRule {
  @ApiProperty({ example: [1, 3, 5] }) @IsArray() @IsInt({ each: true }) days: number[];
  @ApiProperty({ example: '19:00' }) @IsString() start: string;
  @ApiProperty({ example: '20:30' }) @IsString() end: string;
}

class GroupCreateDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() courseId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() branchId?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() teacherId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() roomId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) minStudents?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) maxStudents?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() startDate?: string | null;
  @ApiPropertyOptional({ enum: GROUP_STATUSES }) @IsOptional() @IsIn(GROUP_STATUSES) status?: string;
  @ApiPropertyOptional({ nullable: true, description: 'Постоянная ссылка Zoom/Meet для онлайн-группы' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  onlineUrl?: string | null;
  @ApiPropertyOptional({ type: ScheduleRuleDto, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  @Type(() => ScheduleRuleDto)
  scheduleRule?: ScheduleRuleDto | null;
}

class GroupUpdateDto extends PartialType(OmitType(GroupCreateDto, ['branchId'] as const)) {}

class GenerateDto {
  @ApiPropertyOptional({ description: 'С какой даты (YYYY-MM-DD); по умолчанию — со старта группы или с сегодня' })
  @IsOptional()
  @IsDateString()
  from?: string;
  @ApiPropertyOptional({ description: 'Сколько занятий создать; по умолчанию — остаток часов курса' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  count?: number;
  @ApiPropertyOptional({ description: 'Праздники — эти даты пропускаются', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsDateString({}, { each: true })
  skipDates?: string[];
  @ApiPropertyOptional({ description: 'Только показать, что будет создано' }) @IsOptional() @IsBoolean() dryRun?: boolean;
}

class AddStudentDto {
  @ApiProperty() @IsString() studentId: string;
}

class ReasonDto {
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

class TransferDto {
  @ApiProperty() @IsString() toGroupId: string;
  @ApiProperty() @IsString() reason: string;
}

class NextLevelDto {
  @ApiProperty() @IsString() courseId: string;
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
}

class GroupQueryDto {
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() courseId?: string;
  @IsOptional() @IsString() teacherId?: string;
  @IsOptional() @IsString() search?: string;
}

const ACTIVE = { leftAt: null, waitlist: false } as const;

@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
export class GroupsController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private conflicts: ConflictService,
    private finance: FinanceService,
    private webhooks: WebhooksService,
  ) {}

  @Get()
  @RequirePermissions('groups.read')
  async list(@Ctx() ctx: RequestContext, @Query() q: GroupQueryDto) {
    const where: Prisma.GroupWhereInput = { ...branchScope(ctx, q.branchId) };
    if (!canSeeAll(ctx)) where.teacherId = ctx.userId;
    else if (q.teacherId) where.teacherId = q.teacherId;
    if (q.status) where.status = q.status;
    if (q.courseId) where.courseId = q.courseId;
    if (q.search) where.name = { contains: q.search, mode: 'insensitive' };
    const rows = await this.prisma.group.findMany({
      where,
      include: {
        course: { select: { id: true, name: true, level: true, academicHours: true } },
        teacher: { select: { id: true, firstName: true, lastName: true } },
        room: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        students: { where: { leftAt: null }, select: { waitlist: true } },
        lessons: { where: { status: { not: 'cancelled' } }, select: { startsAt: true } },
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    const now = new Date();
    return rows.map(({ students, lessons, ...g }) => ({
      ...g,
      activeCount: students.filter((s) => !s.waitlist).length,
      waitlistCount: students.filter((s) => s.waitlist).length,
      lessonsTotal: lessons.length,
      lessonsDone: lessons.filter((l) => l.startsAt < now).length,
      nextLessonAt: lessons.filter((l) => l.startsAt >= now).sort((a, b) => +a.startsAt - +b.startsAt)[0]?.startsAt ?? null,
    }));
  }

  /** Преподаватели филиала — для выбора в группе и при замене. */
  @Get('teachers')
  @RequirePermissions('groups.read')
  teachers(@Ctx() ctx: RequestContext, @Query('branchId') branchId?: string) {
    const b = ctx.branchId ?? branchId;
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        roles: { some: { role: { code: 'teacher' }, ...(b ? { OR: [{ branchId: b }, { branchId: null }] } : {}) } },
      },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { lastName: 'asc' },
    });
  }

  @Get(':id')
  @RequirePermissions('groups.read')
  async get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const g = await this.prisma.group.findFirst({
      where: { id, ...this.scope(ctx) },
      include: {
        course: true,
        teacher: { select: { id: true, firstName: true, lastName: true } },
        room: true,
        branch: { select: { id: true, name: true, timezone: true } },
        students: {
          where: { leftAt: null },
          include: {
            student: { select: { id: true, firstName: true, lastName: true, currentLevel: true, status: true, balance: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
        lessons: {
          orderBy: { startsAt: 'asc' },
          include: {
            teacher: { select: { id: true, firstName: true, lastName: true } },
            room: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!g) throw new NotFoundException('Группа не найдена');
    // Баланс студента видят только роли с доступом к финансам.
    if (!hasPermission(ctx.permissions, 'finance.read')) {
      g.students = g.students.map((s) => ({ ...s, student: { ...s.student, balance: null as any } }));
    }
    return g;
  }

  @Post()
  @RequirePermissions('groups.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: GroupCreateDto) {
    const branchId = ctx.branchId ?? dto.branchId;
    if (!branchId) throw new BadRequestException('Укажите филиал');
    const { branchId: _, ...data } = dto;
    await this.validate(branchId, data);
    const g = await this.prisma.group.create({
      data: {
        ...data,
        branchId,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        scheduleRule: (data.scheduleRule ?? undefined) as any,
      },
    });
    await this.audit.log({ userId: ctx.userId, entity: 'group', entityId: g.id, action: 'create', after: g });
    return g;
  }

  /**
   * Изменение группы. Если сменились преподаватель или кабинет — они меняются
   * и во всех будущих запланированных занятиях (с проверкой конфликтов).
   */
  @Patch(':id')
  @RequirePermissions('groups.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: GroupUpdateDto) {
    const before = await this.findOwn(ctx, id);
    await this.validate(before.branchId, dto, before);

    const lessonPatch: { teacherId?: string | null; roomId?: string | null } = {};
    if (dto.teacherId !== undefined && dto.teacherId !== before.teacherId) lessonPatch.teacherId = dto.teacherId;
    if (dto.roomId !== undefined && dto.roomId !== before.roomId) lessonPatch.roomId = dto.roomId;
    const future = Object.keys(lessonPatch).length
      ? await this.prisma.lesson.findMany({ where: { groupId: id, status: 'planned', startsAt: { gt: new Date() } } })
      : [];
    if (future.length) {
      // Проверяем только то, что меняется: нового преподавателя и/или новый кабинет.
      const conflicts = await this.conflicts.find(
        future.map((l) => ({
          startsAt: l.startsAt,
          endsAt: l.endsAt,
          teacherId: lessonPatch.teacherId,
          roomId: lessonPatch.roomId,
          studentIds: [],
        })),
        future.map((l) => l.id),
      );
      if (conflicts.length) throw new ConflictException({ message: 'Конфликты расписания', conflicts });
    }

    const after = await this.prisma.$transaction(async (tx) => {
      if (future.length) {
        await tx.lesson.updateMany({ where: { id: { in: future.map((l) => l.id) } }, data: lessonPatch });
      }
      return tx.group.update({
        where: { id },
        data: {
          ...dto,
          startDate: dto.startDate === undefined ? undefined : dto.startDate ? new Date(dto.startDate) : null,
          scheduleRule: dto.scheduleRule === undefined ? undefined : ((dto.scheduleRule ?? Prisma.DbNull) as any),
        },
      });
    });
    await this.audit.log({
      userId: ctx.userId,
      entity: 'group',
      entityId: id,
      action: 'update',
      before,
      after,
      reason: future.length ? `Обновлено будущих занятий: ${future.length}` : undefined,
    });
    return { ...after, lessonsUpdated: future.length };
  }

  /**
   * Создание занятий по шаблону (ТЗ 3.3) на весь курс или на заданное число занятий.
   * Будущие запланированные занятия без отметок с даты `from` пересоздаются.
   * При конфликтах ничего не создаётся — возвращается 409 со списком.
   */
  @Post(':id/lessons/generate')
  @RequirePermissions('schedule.create')
  async generate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: GenerateDto) {
    const g = await this.prisma.group.findFirst({
      where: { id, ...this.scope(ctx) },
      include: { course: true, branch: true },
    });
    if (!g) throw new NotFoundException('Группа не найдена');
    const rule = g.scheduleRule as unknown as ScheduleRule | null;
    const err = validateRule(rule);
    if (err) throw new BadRequestException(`Шаблон расписания группы: ${err}`);
    const tz = g.branch.timezone;

    const today = localDate(new Date(), tz);
    const start = g.startDate ? localDate(g.startDate, tz) : today;
    const from = dto.from?.slice(0, 10) ?? (start > today ? start : today);
    const fromUtc = zonedToUtc(from, '00:00', tz);

    const lessons = await this.prisma.lesson.findMany({
      where: { groupId: id, status: { not: 'cancelled' } },
      include: { _count: { select: { attendance: true } } },
    });
    const replaced = lessons.filter((l) => l.status === 'planned' && l.startsAt >= fromUtc && l._count.attendance === 0);
    const kept = lessons.length - replaced.length;
    const total = Math.ceil(g.course.academicHours / hoursPerLesson(rule!));
    const count = dto.count ?? Math.max(0, total - kept);

    const slots = generateSlots(rule!, from, count, tz, (dto.skipDates ?? []).map((d) => d.slice(0, 10)));
    const studentIds = await this.activeStudentIds(id);
    const conflicts = await this.conflicts.find(
      slots.map((s) => ({ ...s, teacherId: g.teacherId, roomId: g.roomId, studentIds })),
      replaced.map((l) => l.id),
    );

    const summary = { from, total, kept, replaced: replaced.length, count: slots.length, hoursPerLesson: hoursPerLesson(rule!) };
    if (dto.dryRun) return { ...summary, lessons: slots, conflicts };
    if (conflicts.length) throw new ConflictException({ message: 'Конфликты расписания', conflicts, ...summary });

    await this.prisma.$transaction(async (tx) => {
      if (replaced.length) await tx.lesson.deleteMany({ where: { id: { in: replaced.map((l) => l.id) } } });
      if (slots.length) {
        await tx.lesson.createMany({
          data: slots.map((s) => ({ groupId: id, teacherId: g.teacherId, roomId: g.roomId, ...s })),
        });
        await tx.group.update({
          where: { id },
          data: { endDate: slots[slots.length - 1].endsAt, startDate: g.startDate ?? slots[0].startsAt },
        });
      }
    });
    await this.audit.log({ userId: ctx.userId, entity: 'group', entityId: id, action: 'generate_lessons', after: summary });
    return { ...summary, lessons: slots, conflicts: [] };
  }

  // ───── Состав группы ─────

  /** Зачисление; если мест нет — в лист ожидания (ТЗ 3.4). */
  @Post(':id/students')
  @RequirePermissions('groups.update')
  async addStudent(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: AddStudentDto) {
    const g = await this.findOwn(ctx, id);
    const res = await this.enroll(ctx, g, dto.studentId);
    return res;
  }

  @Post(':id/students/:studentId/remove')
  @RequirePermissions('groups.update')
  async removeStudent(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('studentId') studentId: string,
    @Body() dto: ReasonDto,
  ) {
    const g = await this.findOwn(ctx, id);
    const gs = await this.membership(id, studentId);
    await this.prisma.groupStudent.update({
      where: { groupId_studentId: { groupId: id, studentId } },
      data: { leftAt: new Date() },
    });
    await this.audit.log({ userId: ctx.userId, entity: 'group', entityId: id, action: 'remove_student', before: gs, reason: dto.reason });
    const promoted = gs.waitlist ? null : await this.promoteWaitlist(ctx, g);
    return { ok: true, promoted };
  }

  /** Перевод из листа ожидания в основной состав. */
  @Post(':id/students/:studentId/activate')
  @RequirePermissions('groups.update')
  async activate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('studentId') studentId: string) {
    const g = await this.findOwn(ctx, id);
    const gs = await this.membership(id, studentId);
    if (!gs.waitlist) throw new BadRequestException('Студент уже в основном составе');
    if ((await this.activeCount(id)) >= g.maxStudents) throw new BadRequestException('В группе нет свободных мест');
    await this.prisma.groupStudent.update({
      where: { groupId_studentId: { groupId: id, studentId } },
      data: { waitlist: false },
    });
    await this.audit.log({ userId: ctx.userId, entity: 'group', entityId: id, action: 'activate_student', after: { studentId } });
    await this.notifyMinimum(ctx, g);
    return { ok: true };
  }

  /**
   * Перевод студента в другую группу (ТЗ 3.4).
   * Перерасчёт остатка абонемента подключается в модуле «Финансы».
   */
  @Post(':id/students/:studentId/transfer')
  @RequirePermissions('groups.update')
  async transfer(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('studentId') studentId: string,
    @Body() dto: TransferDto,
  ) {
    if (!dto.reason?.trim()) throw new BadRequestException('Укажите причину перевода');
    if (dto.toGroupId === id) throw new BadRequestException('Студент уже в этой группе');
    const from = await this.findOwn(ctx, id);
    const to = await this.findOwn(ctx, dto.toGroupId);
    const gs = await this.membership(id, studentId);
    // Сначала проверяем, что в новую группу можно зачислить, — только потом выводим из старой.
    await this.assertCanEnroll(to, studentId);
    await this.prisma.groupStudent.update({
      where: { groupId_studentId: { groupId: id, studentId } },
      data: { leftAt: new Date() },
    });
    const res = await this.enroll(ctx, to, studentId, false);
    // Перерасчёт остатка абонемента: неиспользованные деньги переходят в абонемент новой группы.
    const recalculated = await this.finance.transfer(studentId, id, to, ctx.userId);
    await this.audit.log({
      userId: ctx.userId,
      entity: 'student',
      entityId: studentId,
      action: 'transfer',
      before: { groupId: id, groupName: from.name },
      after: { groupId: to.id, groupName: to.name, waitlist: res.waitlist, subscriptions: recalculated },
      reason: dto.reason,
    });
    if (!gs.waitlist) await this.promoteWaitlist(ctx, from);
    return { ...res, subscriptions: recalculated };
  }

  /** Массовый перевод группы на следующий уровень: новая группа с тем же составом, шаблоном и преподавателем. */
  @Post(':id/next-level')
  @RequirePermissions('groups.create')
  async nextLevel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: NextLevelDto) {
    const g = await this.findOwn(ctx, id);
    const course = await this.prisma.course.findUnique({ where: { id: dto.courseId } });
    if (!course) throw new BadRequestException('Курс не найден');
    const active = await this.prisma.groupStudent.findMany({ where: { groupId: id, ...ACTIVE } });
    const created = await this.prisma.$transaction(async (tx) => {
      const ng = await tx.group.create({
        data: {
          branchId: g.branchId,
          courseId: course.id,
          teacherId: g.teacherId,
          roomId: g.roomId,
          name: dto.name,
          minStudents: g.minStudents,
          maxStudents: g.maxStudents,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          scheduleRule: (g.scheduleRule ?? undefined) as any,
          status: 'recruiting',
        },
      });
      if (active.length) {
        await tx.groupStudent.createMany({ data: active.map((s) => ({ groupId: ng.id, studentId: s.studentId })) });
        await tx.student.updateMany({ where: { id: { in: active.map((s) => s.studentId) } }, data: { currentLevel: course.level.slice(0, 2) } });
      }
      await tx.groupStudent.updateMany({ where: { groupId: id, leftAt: null }, data: { leftAt: new Date() } });
      await tx.group.update({ where: { id }, data: { status: 'finished' } });
      return ng;
    });
    await this.audit.log({
      userId: ctx.userId,
      entity: 'group',
      entityId: id,
      action: 'next_level',
      after: { newGroupId: created.id, students: active.length, course: course.name },
    });
    return created;
  }

  // ───── Вспомогательное ─────

  private scope(ctx: RequestContext): Prisma.GroupWhereInput {
    return { ...branchScope(ctx), ...(canSeeAll(ctx) ? {} : { teacherId: ctx.userId }) };
  }

  private async findOwn(ctx: RequestContext, id: string) {
    const g = await this.prisma.group.findFirst({ where: { id, ...this.scope(ctx) } });
    if (!g) throw new NotFoundException('Группа не найдена');
    return g;
  }

  private async membership(groupId: string, studentId: string) {
    const gs = await this.prisma.groupStudent.findUnique({ where: { groupId_studentId: { groupId, studentId } } });
    if (!gs || gs.leftAt) throw new NotFoundException('Студента нет в группе');
    return gs;
  }

  private activeCount(groupId: string) {
    return this.prisma.groupStudent.count({ where: { groupId, ...ACTIVE } });
  }

  private async activeStudentIds(groupId: string) {
    return (await this.prisma.groupStudent.findMany({ where: { groupId, ...ACTIVE }, select: { studentId: true } })).map(
      (s) => s.studentId,
    );
  }

  private async validate(
    branchId: string,
    dto: GroupUpdateDto,
    current?: { minStudents: number; maxStudents: number },
  ) {
    if (dto.courseId && !(await this.prisma.course.findUnique({ where: { id: dto.courseId } }))) {
      throw new BadRequestException('Курс не найден');
    }
    if (dto.roomId && !(await this.prisma.room.findFirst({ where: { id: dto.roomId, branchId } }))) {
      throw new BadRequestException('Кабинет не из филиала группы');
    }
    if (dto.teacherId) {
      const ok = await this.prisma.userRole.findFirst({
        where: { userId: dto.teacherId, role: { code: 'teacher' }, OR: [{ branchId }, { branchId: null }] },
      });
      if (!ok) throw new BadRequestException('Сотрудник не преподаёт в этом филиале');
    }
    const min = dto.minStudents ?? current?.minStudents ?? 4;
    const max = dto.maxStudents ?? current?.maxStudents ?? 12;
    if (min > max) throw new BadRequestException('Минимум студентов больше максимума');
    if (dto.scheduleRule) {
      const err = validateRule(dto.scheduleRule);
      if (err) throw new BadRequestException(err);
    }
  }

  private async assertCanEnroll(g: { id: string; branchId: string }, studentId: string) {
    const student = await this.prisma.student.findFirst({ where: { id: studentId, branchId: g.branchId } });
    if (!student) throw new BadRequestException('Студент не найден в филиале группы');
    const existing = await this.prisma.groupStudent.findUnique({ where: { groupId_studentId: { groupId: g.id, studentId } } });
    if (existing && !existing.leftAt) throw new BadRequestException('Студент уже в группе');
  }

  private async enroll(ctx: RequestContext, g: { id: string; branchId: string; maxStudents: number; minStudents: number; name: string; status: string }, studentId: string, audit = true) {
    await this.assertCanEnroll(g, studentId);
    const waitlist = (await this.activeCount(g.id)) >= g.maxStudents;
    const data = { joinedAt: new Date(), leftAt: null, waitlist };
    await this.prisma.groupStudent.upsert({
      where: { groupId_studentId: { groupId: g.id, studentId } },
      create: { groupId: g.id, studentId, ...data },
      update: data,
    });
    if (audit) {
      await this.audit.log({ userId: ctx.userId, entity: 'group', entityId: g.id, action: 'add_student', after: { studentId, waitlist } });
    }
    if (!waitlist) await this.notifyMinimum(ctx, g);
    if (!waitlist) await this.webhooks.emit('student.enrolled', { studentId, groupId: g.id, groupName: g.name, branchId: g.branchId });
    return { ok: true, waitlist };
  }

  private async promoteWaitlist(ctx: RequestContext, g: { id: string; maxStudents: number }) {
    if ((await this.activeCount(g.id)) >= g.maxStudents) return null;
    const next = await this.prisma.groupStudent.findFirst({
      where: { groupId: g.id, leftAt: null, waitlist: true },
      orderBy: { joinedAt: 'asc' },
    });
    if (!next) return null;
    await this.prisma.groupStudent.update({
      where: { groupId_studentId: { groupId: g.id, studentId: next.studentId } },
      data: { waitlist: false },
    });
    await this.audit.log({
      userId: ctx.userId,
      entity: 'group',
      entityId: g.id,
      action: 'activate_student',
      after: { studentId: next.studentId },
      reason: 'Освободилось место — из листа ожидания',
    });
    return next.studentId;
  }

  /** Уведомление администратору при наборе минимума (ТЗ 3.4) — задача администраторам филиала. */
  private async notifyMinimum(ctx: RequestContext, g: { id: string; branchId: string; minStudents: number; name: string; status: string }) {
    if (g.status !== 'recruiting' || (await this.activeCount(g.id)) !== g.minStudents) return;
    const admins = await this.prisma.userRole.findMany({
      where: { branchId: g.branchId, role: { code: 'branch_admin' }, user: { isActive: true } },
      select: { userId: true },
    });
    const ids = [...new Set(admins.length ? admins.map((a) => a.userId) : [ctx.userId])];
    await this.prisma.task.createMany({
      data: ids.map((assigneeId) => ({
        assigneeId,
        title: `Группа «${g.name}» набрала минимум (${g.minStudents}) — можно запускать`,
        dueAt: new Date(Date.now() + 24 * 3600_000),
      })),
    });
  }
}
