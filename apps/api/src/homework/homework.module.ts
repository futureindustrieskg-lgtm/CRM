import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Module,
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
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { LeadsModule } from '../leads/leads.module';
import { LearningModule } from '../learning/learning.module';
import { SettingsService, SKILLS, validateGrade } from '../learning/settings';
import { PrismaService } from '../prisma/prisma.service';
import { canSeeAll } from '../schedule/groups';
import { FilesController, FilesService } from './files';
import { AttemptsService, PlacementLinkController, PublicTestsController, TestsController, token } from './tests';

/** Sprechen: аудиоответ не длиннее 5 минут (ТЗ 3.6). */
const MAX_AUDIO_SECONDS = 300;

const fileSelect = { select: { id: true, name: true, mime: true, size: true, isFeedback: true } } as const;
const person = { select: { id: true, firstName: true, lastName: true } } as const;

class LinkDto {
  @ApiProperty() @IsUrl({ require_protocol: true }) url: string;
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
}

class HomeworkDto {
  @ApiProperty() @IsString() groupId: string;
  @ApiPropertyOptional({ description: 'Индивидуальное задание одному студенту группы' }) @IsOptional() @IsString() studentId?: string;
  @ApiProperty() @IsString() title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ type: [LinkDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LinkDto)
  links?: LinkDto[];
  @ApiPropertyOptional({ enum: SKILLS }) @IsOptional() @IsIn(SKILLS) skill?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() testId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueAt?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) fileIds?: string[];
}
class HomeworkUpdateDto extends PartialType(OmitType(HomeworkDto, ['groupId', 'studentId'] as const)) {}

class CheckDto {
  @ApiProperty({ enum: ['checked', 'returned'], description: 'returned — вернуть на доработку' }) @IsIn(['checked', 'returned']) status: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() grade?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() feedback?: string;
  @ApiPropertyOptional({ type: [String], description: 'Голосовой ответ или файл с правками' }) @IsOptional() @IsArray() @IsString({ each: true }) fileIds?: string[];
}

class SubmitDto {
  @ApiPropertyOptional() @IsOptional() @IsString() text?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) fileIds?: string[];
  @ApiPropertyOptional({ description: 'Длительность аудиозаписи, секунд' }) @IsOptional() @IsInt() @Min(0) @Max(3600) audioSeconds?: number;
}

/** Студенты, которым адресовано ДЗ: вся активная группа или один студент. */
async function recipients(prisma: PrismaService, hw: { groupId: string; studentId: string | null }) {
  const members = await prisma.groupStudent.findMany({
    where: { groupId: hw.groupId, leftAt: null, waitlist: false, ...(hw.studentId ? { studentId: hw.studentId } : {}) },
    include: { student: person },
  });
  return members.map((m) => m.student).sort((a, b) => a.lastName.localeCompare(b.lastName, 'ru'));
}

// ───────────── ДЗ: преподаватель и администратор ─────────────
// Разделы для сотрудников требуют homework.create: у роли «студент» есть только homework.read
// (свой кабинет), и она не должна видеть чужие сдачи и правильные ответы тестов.

@ApiTags('homework')
@ApiBearerAuth()
@Controller('homework')
export class HomeworkController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private files: FilesService,
    private settings: SettingsService,
  ) {}

  private scope(ctx: RequestContext): Prisma.HomeworkWhereInput {
    return { group: { ...branchScope(ctx), ...(canSeeAll(ctx) ? {} : { teacherId: ctx.userId }) } };
  }

  @Get()
  @RequirePermissions('homework.create')
  async list(@Ctx() ctx: RequestContext, @Query('groupId') groupId?: string) {
    const rows = await this.prisma.homework.findMany({
      where: { ...this.scope(ctx), groupId },
      include: {
        group: { select: { id: true, name: true } },
        student: person,
        test: { select: { id: true, title: true } },
        submissions: { select: { status: true } },
        _count: { select: { files: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const out = [];
    for (const { submissions, ...h } of rows) {
      const total = h.studentId ? 1 : await this.prisma.groupStudent.count({ where: { groupId: h.groupId, leftAt: null, waitlist: false } });
      out.push({
        ...h,
        total,
        submitted: submissions.filter((s) => s.status === 'submitted').length,
        checked: submissions.filter((s) => s.status === 'checked').length,
        returned: submissions.filter((s) => s.status === 'returned').length,
      });
    }
    return out;
  }

  @Get(':id')
  @RequirePermissions('homework.create')
  async get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const hw = await this.prisma.homework.findFirst({
      where: { id, ...this.scope(ctx) },
      include: {
        group: { select: { id: true, name: true } },
        student: person,
        test: { select: { id: true, title: true } },
        files: fileSelect,
        submissions: {
          include: { student: person, files: fileSelect, testAttempt: { select: { score: true, maxScore: true, percent: true, timedOut: true } } },
        },
      },
    });
    if (!hw) throw new NotFoundException('Задание не найдено');
    const students = await recipients(this.prisma, hw);
    return { ...hw, students, settings: await this.settings.learning() };
  }

  @Post()
  @RequirePermissions('homework.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: HomeworkDto) {
    const group = await this.prisma.group.findFirst({ where: { id: dto.groupId, ...branchScope(ctx), ...(canSeeAll(ctx) ? {} : { teacherId: ctx.userId }) } });
    if (!group) throw new NotFoundException('Группа не найдена');
    if (dto.studentId && !(await this.prisma.groupStudent.findFirst({ where: { groupId: group.id, studentId: dto.studentId, leftAt: null } }))) {
      throw new BadRequestException('Студента нет в группе');
    }
    if (dto.testId && !(await this.prisma.test.findFirst({ where: { id: dto.testId, kind: 'quiz' } }))) {
      throw new BadRequestException('Тест не найден');
    }
    const { fileIds, links, ...data } = dto;
    const hw = await this.prisma.homework.create({
      data: { ...data, links: (links ?? undefined) as any, dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined, createdById: ctx.userId },
    });
    await this.files.attach(ctx.userId, fileIds, { homeworkId: hw.id });
    await this.audit.log({ userId: ctx.userId, entity: 'homework', entityId: hw.id, action: 'create', after: hw });
    // Уведомление «новое ДЗ» студентам — итерация 8.
    return hw;
  }

  @Patch(':id')
  @RequirePermissions('homework.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: HomeworkUpdateDto) {
    const before = await this.prisma.homework.findFirst({ where: { id, ...this.scope(ctx) } });
    if (!before) throw new NotFoundException('Задание не найдено');
    const { fileIds, links, ...data } = dto;
    const after = await this.prisma.homework.update({
      where: { id },
      data: { ...data, ...(links !== undefined ? { links: links as any } : {}), dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined },
    });
    await this.files.attach(ctx.userId, fileIds, { homeworkId: id });
    await this.audit.log({ userId: ctx.userId, entity: 'homework', entityId: id, action: 'update', before, after });
    return after;
  }

  /** Проверка сдачи (ТЗ 3.6): оценка в шкале центра, комментарий, голосовой ответ; или возврат на доработку. */
  @Post('submissions/:id/check')
  @RequirePermissions('homework.update')
  async check(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: CheckDto) {
    const sub = await this.prisma.homeworkSubmission.findFirst({
      where: { id, homework: this.scope(ctx) },
      include: { homework: true },
    });
    if (!sub) throw new NotFoundException('Сдача не найдена');
    const s = await this.settings.learning();
    if (dto.grade !== undefined && dto.grade !== null) {
      const err = validateGrade(s, dto.grade);
      if (err) throw new BadRequestException(err);
    }
    if (dto.status === 'returned' && !dto.feedback?.trim() && !dto.fileIds?.length) {
      throw new BadRequestException('Напишите, что исправить');
    }
    const after = await this.prisma.homeworkSubmission.update({
      where: { id },
      data: {
        status: dto.status,
        grade: dto.status === 'checked' ? dto.grade ?? null : null,
        feedback: dto.feedback,
        checkedAt: new Date(),
        checkedById: ctx.userId,
      },
    });
    await this.files.attach(ctx.userId, dto.fileIds, { submissionId: id, isFeedback: true });
    // Оценка засчитывается в навык задания (успеваемость студента).
    if (sub.homework.skill && dto.status === 'checked' && dto.grade !== undefined && dto.grade !== null) {
      const data = { studentId: sub.studentId, skill: sub.homework.skill, value: dto.grade, scale: s.gradeScale, maxValue: s.gradeScale === 'points' ? s.gradeMax : null, comment: `ДЗ: ${sub.homework.title}`, createdById: ctx.userId };
      await this.prisma.grade.upsert({ where: { submissionId: id }, create: { ...data, submissionId: id }, update: data });
    } else {
      await this.prisma.grade.deleteMany({ where: { submissionId: id } });
    }
    await this.audit.log({ userId: ctx.userId, entity: 'homework_submission', entityId: id, action: dto.status === 'checked' ? 'check' : 'return', before: sub, after });
    return after;
  }
}

// ───────────── Кабинет студента ─────────────

@ApiTags('student')
@ApiBearerAuth()
@Controller('my')
export class MyController {
  constructor(private prisma: PrismaService, private files: FilesService, private audit: AuditService) {}

  private async me(ctx: RequestContext) {
    if (ctx.roleCode !== 'student') throw new ForbiddenException('Раздел для студентов');
    const s = await this.prisma.student.findFirst({ where: { userId: ctx.userId } });
    if (!s) throw new ForbiddenException('Учётная запись не связана со студентом');
    return s;
  }

  private async myHomework(studentId: string, id?: string) {
    const groups = await this.prisma.groupStudent.findMany({ where: { studentId, leftAt: null, waitlist: false }, select: { groupId: true } });
    return this.prisma.homework.findMany({
      where: { id, groupId: { in: groups.map((g) => g.groupId) }, OR: [{ studentId: null }, { studentId }] },
      include: {
        group: { select: { id: true, name: true } },
        test: { select: { id: true, title: true, timeLimitMin: true } },
        files: fileSelect,
        submissions: { where: { studentId }, include: { files: fileSelect } },
      },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
  }

  /** Мои задания: всей группе и лично мне, с моей сдачей и проверкой. */
  @Get('homework')
  @RequirePermissions('homework.read')
  async homework(@Ctx() ctx: RequestContext) {
    const s = await this.me(ctx);
    const rows = await this.myHomework(s.id);
    return rows.map(({ submissions, ...h }) => ({ ...h, submission: submissions[0] ?? null }));
  }

  /** Сдача с телефона: текст, фото тетради, файл, аудио до 5 минут. Повторно — пока не проверено. */
  @Post('homework/:id/submit')
  @RequirePermissions('homework.read')
  async submit(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: SubmitDto) {
    const s = await this.me(ctx);
    const [hw] = await this.myHomework(s.id, id);
    if (!hw) throw new NotFoundException('Задание не найдено');
    if (hw.testId) throw new BadRequestException('Это задание — тест: пройдите его');
    if (!dto.text?.trim() && !dto.fileIds?.length) throw new BadRequestException('Добавьте ответ или файл');
    if ((dto.audioSeconds ?? 0) > MAX_AUDIO_SECONDS) throw new BadRequestException('Аудиоответ — не длиннее 5 минут');
    const prev = hw.submissions[0];
    if (prev?.status === 'checked') throw new BadRequestException('Задание уже проверено');
    const sub = await this.prisma.homeworkSubmission.upsert({
      where: { homeworkId_studentId: { homeworkId: id, studentId: s.id } },
      create: { homeworkId: id, studentId: s.id, text: dto.text, audioSeconds: dto.audioSeconds },
      update: { text: dto.text, audioSeconds: dto.audioSeconds, status: 'submitted', submittedAt: new Date() },
    });
    // Повторная сдача заменяет прежние файлы студента (ответ преподавателя остаётся).
    if (prev) await this.prisma.storedFile.updateMany({ where: { submissionId: sub.id, isFeedback: false }, data: { submissionId: null } });
    await this.files.attach(ctx.userId, dto.fileIds, { submissionId: sub.id });
    await this.audit.log({ userId: ctx.userId, entity: 'homework_submission', entityId: sub.id, action: prev ? 'resubmit' : 'submit' });
    return sub;
  }

  /** ДЗ-тест: одна попытка; возвращает токен для прохождения. */
  @Post('homework/:id/test')
  @RequirePermissions('homework.read')
  async test(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const s = await this.me(ctx);
    const [hw] = await this.myHomework(s.id, id);
    if (!hw?.testId) throw new NotFoundException('Тест не найден');
    const existing = await this.prisma.testAttempt.findFirst({ where: { homeworkId: id, studentId: s.id } });
    if (existing) return { token: existing.token };
    const a = await this.prisma.testAttempt.create({ data: { testId: hw.testId, homeworkId: id, studentId: s.id, token: token() } });
    return { token: a.token };
  }
}

@Module({
  imports: [LearningModule, LeadsModule],
  controllers: [FilesController, HomeworkController, MyController, TestsController, PlacementLinkController, PublicTestsController],
  providers: [FilesService, AttemptsService],
})
export class HomeworkModule {}
