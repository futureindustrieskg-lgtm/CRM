import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';
import { canSeeAll } from '../schedule/groups';
import {
  ATTENDANCE_STATUSES,
  AttendanceStatus,
  LearningSettings,
  SettingsController,
  SettingsService,
  SKILLS,
  toPercent,
  validateGrade,
} from './settings';

/** Отметку можно ставить не раньше чем за 30 минут до начала занятия. */
const MARK_BEFORE_MS = 30 * 60_000;

class MarkItemDto {
  @ApiProperty() @IsString() studentId: string;
  @ApiProperty({ enum: ATTENDANCE_STATUSES }) @IsIn(ATTENDANCE_STATUSES) status: AttendanceStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}

class MarkDto {
  @ApiProperty({ type: [MarkItemDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => MarkItemDto)
  items: MarkItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() topic?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() courseTopicId?: string | null;
  @ApiPropertyOptional({
    description: 'Время отметки на устройстве (офлайн-режим): более старые отметки не перезаписывают новые',
  })
  @IsOptional()
  @IsDateString()
  clientTime?: string;
}

class GradeItemDto {
  @ApiProperty() @IsString() studentId: string;
  @ApiProperty({ enum: SKILLS }) @IsIn(SKILLS) skill: string;
  @ApiProperty({ nullable: true, description: 'null — удалить оценку' })
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  value: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}

class GradesDto {
  @ApiProperty({ type: [GradeItemDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => GradeItemDto)
  items: GradeItemDto[];
}

class TopicItemDto {
  @ApiPropertyOptional() @IsOptional() @IsString() id?: string;
  @ApiProperty() @IsString() title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() chapter?: string;
}

class TopicsDto {
  @ApiProperty({ type: [TopicItemDto] })
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => TopicItemDto)
  topics: TopicItemDto[];
}

const person = { select: { id: true, firstName: true, lastName: true } } as const;

/** Студенты, которые числились в группе (не в листе ожидания) во время занятия. */
function membersAt(groupId: string, startsAt: Date, endsAt: Date): Prisma.GroupStudentWhereInput {
  return {
    groupId,
    waitlist: false,
    joinedAt: { lte: endsAt },
    OR: [{ leftAt: null }, { leftAt: { gt: startsAt } }],
  };
}

// ───────────── Журнал занятия: посещаемость, тема, оценки ─────────────

@ApiTags('attendance')
@ApiBearerAuth()
@Controller('lessons')
export class JournalController {
  constructor(private prisma: PrismaService, private audit: AuditService, private settings: SettingsService) {}

  @Get(':id/journal')
  @RequirePermissions('attendance.read')
  async journal(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const lesson = await this.findOwn(ctx, id);
    const [members, attendance, grades, used, settings] = await Promise.all([
      this.prisma.groupStudent.findMany({
        where: membersAt(lesson.groupId, lesson.startsAt, lesson.endsAt),
        include: { student: { select: { id: true, firstName: true, lastName: true, status: true } } },
        orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      }),
      this.prisma.attendance.findMany({ where: { lessonId: id } }),
      this.prisma.grade.findMany({ where: { lessonId: id } }),
      this.prisma.lesson.findMany({
        where: { groupId: lesson.groupId, status: { not: 'cancelled' }, courseTopicId: { not: null }, id: { not: id } },
        select: { courseTopicId: true },
      }),
      this.settings.learning(),
    ]);
    const usedIds = new Set(used.map((l) => l.courseTopicId));
    const topics = lesson.group.course.topics;
    return {
      lesson: { ...lesson, group: { id: lesson.group.id, name: lesson.group.name, branchId: lesson.group.branchId } },
      course: { id: lesson.group.course.id, name: lesson.group.course.name },
      topics: topics.map((t) => ({ ...t, used: usedIds.has(t.id) })),
      suggestedTopicId: lesson.courseTopicId ?? topics.find((t) => !usedIds.has(t.id))?.id ?? null,
      students: members.map((m) => ({ ...m.student, leftAt: m.leftAt })),
      attendance,
      grades,
      settings,
      canMark: lesson.status !== 'cancelled' && Date.now() >= +lesson.startsAt - MARK_BEFORE_MS,
    };
  }

  /**
   * Отметка посещаемости (ТЗ 3.5): статусы, тема урока, списание по правилам центра,
   * проверка серии пропусков. Повторная отправка исправляет отметки.
   */
  @Put(':id/attendance')
  @RequirePermissions('attendance.create')
  async mark(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: MarkDto) {
    const lesson = await this.findOwn(ctx, id);
    if (lesson.status === 'cancelled') throw new BadRequestException('Занятие отменено');
    if (Date.now() < +lesson.startsAt - MARK_BEFORE_MS) throw new BadRequestException('Занятие ещё не началось');
    if (dto.courseTopicId && !lesson.group.course.topics.some((t) => t.id === dto.courseTopicId)) {
      throw new BadRequestException('Тема не из учебного плана курса');
    }
    const members = await this.prisma.groupStudent.findMany({
      where: membersAt(lesson.groupId, lesson.startsAt, lesson.endsAt),
      select: { studentId: true },
    });
    const allowed = new Set(members.map((m) => m.studentId));
    const foreign = dto.items.filter((i) => !allowed.has(i.studentId));
    if (foreign.length) throw new BadRequestException('Студент не числился в группе на дату занятия');

    const settings = await this.settings.learning();
    const before = await this.prisma.attendance.findMany({ where: { lessonId: id } });
    const prev = new Map(before.map((a) => [a.studentId, a]));
    const clientTime = dto.clientTime ? new Date(dto.clientTime) : null;
    const skipped: string[] = [];
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        const old = prev.get(item.studentId);
        // Офлайн-синхронизация: побеждает более поздняя отметка (ТЗ 4).
        if (clientTime && old && old.markedAt > clientTime) {
          skipped.push(item.studentId);
          continue;
        }
        const data = {
          status: item.status,
          charged: settings.charge[item.status],
          comment: item.comment,
          markedById: ctx.userId,
          markedAt: clientTime ?? now,
        };
        await tx.attendance.upsert({
          where: { lessonId_studentId: { lessonId: id, studentId: item.studentId } },
          create: { lessonId: id, studentId: item.studentId, ...data },
          update: data,
        });
      }
      await tx.lesson.update({
        where: { id },
        data: {
          status: 'done',
          ...(dto.topic !== undefined ? { topic: dto.topic || null } : {}),
          ...(dto.courseTopicId !== undefined ? { courseTopicId: dto.courseTopicId } : {}),
        },
      });
    });

    const after = await this.prisma.attendance.findMany({ where: { lessonId: id } });
    await this.audit.log({
      userId: ctx.userId,
      entity: 'lesson',
      entityId: id,
      action: 'attendance',
      before: Object.fromEntries(before.map((a) => [a.studentId, a.status])),
      after: Object.fromEntries(after.map((a) => [a.studentId, a.status])),
      reason: skipped.length ? `Пропущены устаревшие офлайн-отметки: ${skipped.length}` : undefined,
    });

    const missing = new Set<string>(['absent', ...(settings.countExcusedInStreak ? ['excused'] : [])]);
    const alerts = [];
    for (const a of after) {
      if (!missing.has(a.status)) continue;
      const alert = await this.checkStreak(ctx, lesson, a.studentId, settings, missing);
      if (alert) alerts.push(alert);
    }
    return { saved: dto.items.length - skipped.length, skipped, alerts };
  }

  /** Оценки за занятие по навыкам Hören / Lesen / Schreiben / Sprechen (ТЗ 3.5). */
  @Post(':id/grades')
  @RequirePermissions('attendance.create')
  async grades(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: GradesDto) {
    const lesson = await this.findOwn(ctx, id);
    if (lesson.status === 'cancelled') throw new BadRequestException('Занятие отменено');
    const settings = await this.settings.learning();
    for (const i of dto.items) {
      if (i.value === null) continue;
      const err = validateGrade(settings, i.value);
      if (err) throw new BadRequestException(err);
    }
    const members = await this.prisma.groupStudent.findMany({
      where: membersAt(lesson.groupId, lesson.startsAt, lesson.endsAt),
      select: { studentId: true },
    });
    const allowed = new Set(members.map((m) => m.studentId));
    if (dto.items.some((i) => !allowed.has(i.studentId))) {
      throw new BadRequestException('Студент не числился в группе на дату занятия');
    }
    await this.prisma.$transaction(async (tx) => {
      for (const i of dto.items) {
        await tx.grade.deleteMany({ where: { lessonId: id, studentId: i.studentId, skill: i.skill } });
        if (i.value === null) continue;
        await tx.grade.create({
          data: {
            lessonId: id,
            studentId: i.studentId,
            skill: i.skill,
            value: i.value,
            scale: settings.gradeScale,
            maxValue: settings.gradeScale === 'points' ? settings.gradeMax : null,
            comment: i.comment,
            createdById: ctx.userId,
          },
        });
      }
    });
    await this.audit.log({ userId: ctx.userId, entity: 'lesson', entityId: id, action: 'grades', after: dto.items });
    return this.prisma.grade.findMany({ where: { lessonId: id } });
  }

  private async findOwn(ctx: RequestContext, id: string) {
    const l = await this.prisma.lesson.findFirst({
      where: { id, group: branchScope(ctx), ...(canSeeAll(ctx) ? {} : { teacherId: ctx.userId }) },
      include: {
        group: { include: { course: { include: { topics: { orderBy: { sort: 'asc' } } } } } },
        teacher: person,
        room: { select: { id: true, name: true } },
      },
    });
    if (!l) throw new NotFoundException('Занятие не найдено');
    return l;
  }

  /**
   * Правило «N пропусков подряд» (ТЗ 3.5): задача менеджеру и уведомление родителям.
   * Срабатывает один раз — когда серия достигает порога, а не на каждом следующем пропуске.
   */
  private async checkStreak(
    ctx: RequestContext,
    lesson: { id: string; groupId: string; startsAt: Date; group: { name: string } },
    studentId: string,
    s: LearningSettings,
    missing: Set<string>,
  ) {
    const n = s.absenceThreshold;
    const recent = await this.prisma.lesson.findMany({
      where: { groupId: lesson.groupId, status: 'done', startsAt: { lte: lesson.startsAt } },
      orderBy: { startsAt: 'desc' },
      take: n + 1,
      select: { id: true, startsAt: true, attendance: { where: { studentId }, select: { status: true } } },
    });
    const isMissing = (l: (typeof recent)[number]) => l.attendance[0] && missing.has(l.attendance[0].status);
    if (recent.length < n || !recent.slice(0, n).every(isMissing)) return null;
    if (recent.length > n && isMissing(recent[n])) return null; // серия уже была отмечена раньше

    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { lead: { select: { id: true, managerId: true } }, parents: { select: { parentId: true } } },
    });
    if (!student) return null;
    const name = `${student.firstName} ${student.lastName}`;
    const title = `${name}: ${n} пропуска подряд в группе «${lesson.group.name}» — связаться`;
    const since = recent[n - 1].startsAt;
    // Защита от дублей при повторном сохранении той же отметки.
    if (await this.prisma.task.findFirst({ where: { title, createdAt: { gte: since } } })) return null;

    let assignees: string[] = student.lead?.managerId ? [student.lead.managerId] : [];
    if (!assignees.length) {
      const admins = await this.prisma.userRole.findMany({
        where: { branchId: student.branchId, role: { code: 'branch_admin' }, user: { isActive: true } },
        select: { userId: true },
      });
      assignees = [...new Set(admins.map((a) => a.userId))];
    }
    if (!assignees.length) assignees = [ctx.userId];
    await this.prisma.task.createMany({
      data: assignees.map((assigneeId) => ({
        assigneeId,
        leadId: student.lead?.id,
        title,
        dueAt: new Date(Date.now() + 24 * 3600_000),
      })),
    });
    if (student.parents.length) {
      await this.prisma.notification.createMany({
        data: student.parents.map((p) => ({
          userId: p.parentId,
          studentId,
          type: 'absence_streak',
          title: 'Пропуски занятий',
          body: `${name} пропустил(а) ${n} занятия подряд в группе «${lesson.group.name}». Пожалуйста, свяжитесь с центром.`,
        })),
      });
    }
    await this.audit.log({
      userId: ctx.userId,
      entity: 'student',
      entityId: studentId,
      action: 'absence_streak',
      after: { lessonId: lesson.id, threshold: n, tasks: assignees.length, parents: student.parents.length },
    });
    return { studentId, name, streak: n, tasks: assignees.length, parentsNotified: student.parents.length };
  }
}

// ───────────── Журнал группы и прогресс студента ─────────────

@ApiTags('attendance')
@ApiBearerAuth()
@Controller()
export class ProgressController {
  constructor(private prisma: PrismaService) {}

  /** Сводный журнал группы: занятия × студенты, статистика посещаемости и средние оценки по навыкам. */
  @Get('groups/:id/journal')
  @RequirePermissions('attendance.read')
  async groupJournal(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const g = await this.prisma.group.findFirst({
      where: { id, ...branchScope(ctx), ...(canSeeAll(ctx) ? {} : { teacherId: ctx.userId }) },
      select: { id: true, name: true },
    });
    if (!g) throw new NotFoundException('Группа не найдена');
    const [lessons, members] = await Promise.all([
      this.prisma.lesson.findMany({
        where: { groupId: id, status: { not: 'cancelled' } },
        orderBy: { startsAt: 'asc' },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          topic: true,
          courseTopic: { select: { title: true } },
          attendance: { select: { studentId: true, status: true, charged: true } },
          grades: { select: { studentId: true, skill: true, value: true, scale: true, maxValue: true } },
        },
      }),
      this.prisma.groupStudent.findMany({
        where: { groupId: id, waitlist: false },
        include: { student: { select: { id: true, firstName: true, lastName: true, status: true } } },
        orderBy: [{ leftAt: { sort: 'asc', nulls: 'first' } }, { student: { lastName: 'asc' } }],
      }),
    ]);
    const students = members.map((m) => {
      const marks = lessons.flatMap((l) => l.attendance.filter((a) => a.studentId === m.studentId));
      const count = (s: string) => marks.filter((a) => a.status === s).length;
      const grades = lessons.flatMap((l) => l.grades.filter((x) => x.studentId === m.studentId));
      const avg = Object.fromEntries(
        SKILLS.map((sk) => {
          const xs = grades.filter((x) => x.skill === sk).map(toPercent);
          return [sk, xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null];
        }),
      );
      const attended = count('present') + count('late');
      return {
        ...m.student,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        stats: {
          present: count('present'),
          late: count('late'),
          excused: count('excused'),
          absent: count('absent'),
          charged: marks.filter((a) => a.charged).length,
          rate: marks.length ? Math.round((attended / marks.length) * 100) : null,
        },
        avg,
      };
    });
    return {
      group: g,
      lessons: lessons.map(({ attendance, grades, ...l }) => ({
        ...l,
        marks: Object.fromEntries(attendance.map((a) => [a.studentId, a.status])),
      })),
      students,
    };
  }

  /** Успеваемость студента: средние по навыкам и посещаемость по группам. */
  @Get('students/:id/progress')
  @RequirePermissions('students.read')
  async studentProgress(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const s = await this.prisma.student.findFirst({ where: { id, ...branchScope(ctx) }, select: { id: true } });
    if (!s) throw new NotFoundException('Студент не найден');
    const [grades, attendance] = await Promise.all([
      this.prisma.grade.findMany({
        where: { studentId: id },
        orderBy: { createdAt: 'desc' },
        include: { lesson: { select: { startsAt: true, group: { select: { name: true } } } } },
        take: 200,
      }),
      this.prisma.attendance.findMany({
        where: { studentId: id },
        include: { lesson: { select: { startsAt: true, group: { select: { id: true, name: true } } } } },
      }),
    ]);
    const bySkill = Object.fromEntries(
      SKILLS.map((sk) => {
        const xs = grades.filter((g) => g.skill === sk).map(toPercent);
        return [sk, xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null];
      }),
    );
    const groups = new Map<string, { groupId: string; name: string; total: number; attended: number; absent: number; charged: number }>();
    for (const a of attendance) {
      const k = a.lesson.group.id;
      const row = groups.get(k) ?? { groupId: k, name: a.lesson.group.name, total: 0, attended: 0, absent: 0, charged: 0 };
      row.total++;
      if (a.status === 'present' || a.status === 'late') row.attended++;
      if (a.status === 'absent') row.absent++;
      if (a.charged) row.charged++;
      groups.set(k, row);
    }
    return { bySkill, grades, attendance: [...groups.values()] };
  }

  /** Учебный план курса (ТЗ 3.4). */
  @Get('courses/:id/topics')
  @RequirePermissions('groups.read')
  topics(@Param('id') id: string) {
    return this.prisma.courseTopic.findMany({ where: { courseId: id }, orderBy: { sort: 'asc' } });
  }
}

@ApiTags('groups')
@ApiBearerAuth()
@Controller('courses')
export class TopicsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Замена учебного плана: темы с id обновляются, новые создаются, отсутствующие удаляются. */
  @Put(':id/topics')
  @RequirePermissions('groups.update')
  async save(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: TopicsDto) {
    const course = await this.prisma.course.findUnique({ where: { id }, include: { topics: true } });
    if (!course) throw new NotFoundException('Курс не найден');
    const keep = new Set(dto.topics.map((t) => t.id).filter(Boolean));
    if ([...keep].some((tid) => !course.topics.some((t) => t.id === tid))) {
      throw new BadRequestException('Тема не из этого курса');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.courseTopic.deleteMany({ where: { courseId: id, id: { notIn: [...keep] as string[] } } });
      for (const [i, t] of dto.topics.entries()) {
        const data = { title: t.title.trim(), chapter: t.chapter?.trim() || null, sort: i + 1 };
        if (t.id) await tx.courseTopic.update({ where: { id: t.id }, data });
        else await tx.courseTopic.create({ data: { ...data, courseId: id } });
      }
    });
    await this.audit.log({
      userId: ctx.userId,
      entity: 'course',
      entityId: id,
      action: 'topics',
      before: course.topics.map((t) => t.title),
      after: dto.topics.map((t) => t.title),
    });
    return this.prisma.courseTopic.findMany({ where: { courseId: id }, orderBy: { sort: 'asc' } });
  }
}

@Module({
  controllers: [JournalController, ProgressController, TopicsController, SettingsController],
  providers: [SettingsService],
})
export class LearningModule {}
