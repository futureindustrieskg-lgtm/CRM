import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
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
  Min,
  ValidateNested,
} from 'class-validator';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit';
import { normalizePhone } from '../auth/auth';
import { branchScope, Ctx, Public, RequestContext, RequirePermissions } from '../common/context';
import { LeadsService } from '../leads/leads.service';
import { LearningSettings, SettingsService } from '../learning/settings';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from './files';
import { forTaker, grade, PLACEMENT_LEVELS, QUESTION_TYPES, validateQuestion } from './grading';

export const token = () => randomBytes(18).toString('base64url');

/** Процент → оценка в шкале центра (для ДЗ-тестов). */
export function fromPercent(s: LearningSettings, p: number) {
  if (s.gradeScale === 'points') return Math.round((p / 100) * s.gradeMax * 10) / 10;
  if (s.gradeScale === 'de_1_6') return Math.round((6 - (5 * p) / 100) * 10) / 10;
  return Math.round(p * 10) / 10;
}

// ───────────── Проверка попытки и последствия ─────────────

@Injectable()
export class AttemptsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private settings: SettingsService) {}

  questions(testId: string) {
    return this.prisma.testQuestion.findMany({
      where: { testId },
      orderBy: { sort: 'asc' },
      include: { files: { select: { id: true, name: true, mime: true } } },
    });
  }

  /** Вопросы для участника — без правильных ответов. */
  async takerView(attempt: { id: string; testId: string; token: string }) {
    const qs = await this.questions(attempt.testId);
    return qs.map((q) => forTaker(q, attempt.id));
  }

  /**
   * Завершение попытки: автопроверка; входной тест — уровень в карточку лида и следующий этап воронки;
   * ДЗ-тест — сдача с оценкой в шкале центра.
   */
  async finish(attemptId: string, answers: Record<string, unknown>) {
    const attempt = await this.prisma.testAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { test: true } });
    if (attempt.finishedAt) throw new BadRequestException('Тест уже завершён');
    if (!attempt.startedAt) throw new BadRequestException('Тест не начат');
    const qs = await this.questions(attempt.testId);
    const placement = attempt.test.kind === 'placement';
    const r = grade(qs, answers ?? {}, attempt.id, placement);
    // 30 секунд на отправку после окончания времени; позже — ответы принимаются, но с отметкой.
    const timedOut = !!attempt.deadlineAt && Date.now() > +attempt.deadlineAt + 30_000;
    await this.prisma.testAttempt.update({
      where: { id: attempt.id },
      data: { finishedAt: new Date(), answers: answers as any, score: r.score, maxScore: r.maxScore, percent: r.percent, level: r.level, timedOut },
    });

    if (attempt.leadId && placement) await this.applyToLead(attempt.leadId, r.level!, r.percent, attempt.test.title);
    if (attempt.homeworkId && attempt.studentId) {
      const hw = await this.prisma.homework.findUniqueOrThrow({ where: { id: attempt.homeworkId } });
      const s = await this.settings.learning();
      const value = fromPercent(s, r.percent);
      const sub = await this.prisma.homeworkSubmission.upsert({
        where: { homeworkId_studentId: { homeworkId: hw.id, studentId: attempt.studentId } },
        create: { homeworkId: hw.id, studentId: attempt.studentId, status: 'checked', grade: value, checkedAt: new Date(), testAttemptId: attempt.id, feedback: `Автопроверка: ${r.score} из ${r.maxScore} (${r.percent}%)` },
        update: { status: 'checked', grade: value, checkedAt: new Date(), submittedAt: new Date(), testAttemptId: attempt.id, feedback: `Автопроверка: ${r.score} из ${r.maxScore} (${r.percent}%)` },
      });
      if (hw.skill) {
        const data = { studentId: attempt.studentId, skill: hw.skill, value, scale: s.gradeScale, maxValue: s.gradeScale === 'points' ? s.gradeMax : null, comment: `ДЗ: ${hw.title}` };
        await this.prisma.grade.upsert({ where: { submissionId: sub.id }, create: { ...data, submissionId: sub.id }, update: data });
      }
    }
    return { score: r.score, maxScore: r.maxScore, percent: r.percent, level: r.level, byLevel: r.byLevel, timedOut };
  }

  /** Результат теста уровня: уровень в карточке, запись в истории, перевод сделки на этап после «Тест уровня». */
  private async applyToLead(leadId: string, level: string, percent: number, title: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, include: { stage: true } });
    if (!lead) return;
    const stages = await this.prisma.pipelineStage.findMany({ orderBy: { sort: 'asc' } });
    const testStage = stages.find((s) => s.code === 'level_test');
    const next = testStage && stages.find((s) => s.sort > testStage.sort && !s.isLost);
    const move = next && !lead.stage.isLost && !lead.stage.isWon && lead.stage.sort < next.sort;
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { ...(level !== 'A0' ? { currentLevel: level } : {}), ...(move ? { stageId: next!.id } : {}) },
    });
    await this.prisma.leadActivity.create({
      data: {
        leadId,
        type: 'system',
        text: `Входной тест «${title}»: уровень ${level === 'A0' ? 'ниже A1' : level} (${percent}%)` + (move ? `. Этап → «${next!.name}»` : ''),
        meta: { level, percent },
      },
    });
    await this.audit.log({ entity: 'lead', entityId: leadId, action: 'placement_test', after: { level, percent, stage: move ? next!.code : lead.stage.code } });
  }
}

// ───────────── Конструктор тестов ─────────────

class TestDto {
  @ApiProperty() @IsString() title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ enum: ['quiz', 'placement'] }) @IsOptional() @IsIn(['quiz', 'placement']) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() level?: string;
  @ApiPropertyOptional({ description: 'Ограничение по времени, минут' }) @IsOptional() @IsInt() @Min(1) @Max(300) timeLimitMin?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublished?: boolean;
}
class TestUpdateDto extends PartialType(TestDto) {}

class QuestionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() id?: string;
  @ApiProperty({ enum: QUESTION_TYPES }) @IsIn(QUESTION_TYPES) type: string;
  @ApiProperty() @IsString() prompt: string;
  @ApiPropertyOptional({ enum: PLACEMENT_LEVELS }) @IsOptional() @IsIn(PLACEMENT_LEVELS) level?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) points?: number;
  @ApiProperty() @IsObject() data: Record<string, unknown>;
  @ApiPropertyOptional({ type: [String], description: 'Аудио/картинки к вопросу' }) @IsOptional() @IsArray() @IsString({ each: true }) fileIds?: string[];
}
class QuestionsDto {
  @ApiProperty({ type: [QuestionDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => QuestionDto)
  questions: QuestionDto[];
}

@ApiTags('tests')
@ApiBearerAuth()
@Controller('tests')
export class TestsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private files: FilesService) {}

  @Get()
  @RequirePermissions('homework.create')
  async list() {
    const rows = await this.prisma.test.findMany({
      include: { _count: { select: { questions: true, attempts: { where: { finishedAt: { not: null } } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
  }

  /** Опубликованные входные тесты — для менеджера, отправляющего ссылку лиду (без вопросов и ответов). */
  @Get('placement')
  @RequirePermissions('leads.update')
  placement() {
    return this.prisma.test.findMany({
      where: { kind: 'placement', isPublished: true },
      select: { id: true, title: true, publicToken: true, timeLimitMin: true },
      orderBy: { title: 'asc' },
    });
  }

  @Get(':id')
  @RequirePermissions('homework.create')
  async get(@Param('id') id: string) {
    const t = await this.prisma.test.findUnique({
      where: { id },
      include: { questions: { orderBy: { sort: 'asc' }, include: { files: { select: { id: true, name: true, mime: true } } } } },
    });
    if (!t) throw new NotFoundException('Тест не найден');
    return t;
  }

  /** Результаты: попытки с баллами, уровнем и участником. */
  @Get(':id/attempts')
  @RequirePermissions('homework.create')
  attempts(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.prisma.testAttempt.findMany({
      where: { testId: id, finishedAt: { not: null } },
      include: {
        student: { select: { id: true, firstName: true, lastName: true } },
        lead: { select: { id: true, firstName: true, lastName: true, phone: true } },
      },
      orderBy: { finishedAt: 'desc' },
      take: 500,
    });
  }

  @Post()
  @RequirePermissions('homework.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: TestDto) {
    const t = await this.prisma.test.create({
      data: { ...dto, createdById: ctx.userId, publicToken: dto.kind === 'placement' ? token() : null },
    });
    await this.audit.log({ userId: ctx.userId, entity: 'test', entityId: t.id, action: 'create', after: t });
    return t;
  }

  @Patch(':id')
  @RequirePermissions('homework.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: TestUpdateDto) {
    const before = await this.prisma.test.findUnique({ where: { id }, include: { _count: { select: { questions: true } } } });
    if (!before) throw new NotFoundException('Тест не найден');
    if (dto.isPublished && !before._count.questions) throw new BadRequestException('Добавьте вопросы перед публикацией');
    const kind = dto.kind ?? before.kind;
    const after = await this.prisma.test.update({
      where: { id },
      data: { ...dto, publicToken: kind === 'placement' ? before.publicToken ?? token() : null },
    });
    await this.audit.log({ userId: ctx.userId, entity: 'test', entityId: id, action: 'update', before, after });
    return after;
  }

  /** Сохранение вопросов целиком: существующие обновляются по id, новые создаются, отсутствующие удаляются. */
  @Put(':id/questions')
  @RequirePermissions('homework.update')
  async questions(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: QuestionsDto) {
    const test = await this.prisma.test.findUnique({ where: { id }, include: { questions: { select: { id: true } } } });
    if (!test) throw new NotFoundException('Тест не найден');
    for (const [i, q] of dto.questions.entries()) {
      const err = validateQuestion(q);
      if (err) throw new BadRequestException(`Вопрос ${i + 1}: ${err}`);
      if (test.kind === 'placement' && !q.level) throw new BadRequestException(`Вопрос ${i + 1}: во входном тесте укажите уровень вопроса`);
      if (q.id && !test.questions.some((x) => x.id === q.id)) throw new BadRequestException(`Вопрос ${i + 1}: не из этого теста`);
    }
    const keep = dto.questions.map((q) => q.id).filter(Boolean) as string[];
    const saved: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      await tx.testQuestion.deleteMany({ where: { testId: id, id: { notIn: keep } } });
      for (const [i, q] of dto.questions.entries()) {
        const data = { type: q.type, prompt: q.prompt.trim(), level: q.level ?? null, points: q.points ?? 1, data: q.data as any, sort: i + 1 };
        const row = q.id ? await tx.testQuestion.update({ where: { id: q.id }, data }) : await tx.testQuestion.create({ data: { ...data, testId: id } });
        saved.push(row.id);
      }
    });
    // Медиа: отвязываем убранные, привязываем новые.
    for (const [i, q] of dto.questions.entries()) {
      const qid = saved[i];
      await this.prisma.storedFile.updateMany({ where: { questionId: qid, id: { notIn: q.fileIds ?? [] } }, data: { questionId: null } });
      const fresh = (q.fileIds ?? []).filter(Boolean);
      const already = (await this.prisma.storedFile.findMany({ where: { id: { in: fresh }, questionId: qid }, select: { id: true } })).map((f) => f.id);
      await this.files.attach(ctx.userId, fresh.filter((f) => !already.includes(f)), { questionId: qid }, true);
    }
    await this.audit.log({ userId: ctx.userId, entity: 'test', entityId: id, action: 'questions', after: { count: dto.questions.length } });
    return this.get(id);
  }
}

// ───────────── Ссылка на тест уровня для лида ─────────────

class PlacementLinkDto {
  @ApiProperty() @IsString() testId: string;
}

@ApiTags('tests')
@ApiBearerAuth()
@Controller('leads')
export class PlacementLinkController {
  constructor(private prisma: PrismaService, private leads: LeadsService) {}

  /** Личная ссылка на входной тест для лида (ТЗ 3.6): результат придёт в карточку и переведёт сделку. */
  @Post(':id/placement-link')
  @RequirePermissions('leads.update')
  async create(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: PlacementLinkDto) {
    await this.leads.get(ctx, id); // проверка доступа к лиду (филиал, «только свои»)
    const test = await this.prisma.test.findUnique({ where: { id: dto.testId } });
    if (!test || test.kind !== 'placement' || !test.isPublished) throw new BadRequestException('Нужен опубликованный входной тест');
    const a = await this.prisma.testAttempt.create({ data: { testId: test.id, leadId: id, token: token() } });
    await this.prisma.leadActivity.create({
      data: { leadId: id, userId: ctx.userId, type: 'system', text: `Отправлена ссылка на входной тест «${test.title}»` },
    });
    return { token: a.token, path: `/test/a/${a.token}` };
  }
}

// ───────────── Прохождение по ссылке (без входа) ─────────────

class StartGuestDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() phone: string;
}
class SubmitDto {
  @ApiProperty({ description: '{ [questionId]: ответ }' }) @IsObject() answers: Record<string, unknown>;
}

@ApiTags('public')
@Controller('public')
export class PublicTestsController {
  constructor(private prisma: PrismaService, private attempts: AttemptsService, private leads: LeadsService) {}

  /** Общая ссылка входного теста: название и правила. */
  @Public()
  @Get('tests/:token')
  async info(@Param('token') t: string) {
    const test = await this.prisma.test.findUnique({ where: { publicToken: t }, include: { _count: { select: { questions: true } } } });
    if (!test || !test.isPublished) throw new NotFoundException('Тест не найден');
    return { title: test.title, description: test.description, timeLimitMin: test.timeLimitMin, questions: test._count.questions };
  }

  /** Гость с общей ссылки: имя и телефон → лид (или существующий по телефону) → личная попытка. */
  @Public()
  @Post('tests/:token/start')
  async startGuest(@Param('token') t: string, @Body() dto: StartGuestDto) {
    const test = await this.prisma.test.findUnique({ where: { publicToken: t } });
    if (!test || !test.isPublished) throw new NotFoundException('Тест не найден');
    const phone = normalizePhone(dto.phone);
    if (!phone || phone.length < 9) throw new BadRequestException('Укажите телефон');
    const name = dto.name.trim().slice(0, 100);
    if (!name) throw new BadRequestException('Укажите имя');
    let lead = await this.prisma.lead.findFirst({ where: { phone, mergedIntoId: null }, orderBy: { createdAt: 'desc' } });
    if (!lead) {
      const [firstName, ...rest] = name.split(/\s+/);
      lead = await this.leads.create(null, { firstName, lastName: rest.join(' ') || undefined, phone, source: 'site', branchId: undefined } as any);
    }
    const a = await this.prisma.testAttempt.create({ data: { testId: test.id, leadId: lead!.id, guestName: name, token: token() } });
    return { token: a.token };
  }

  /** Состояние попытки: до начала — правила; после начала — вопросы без ответов; после завершения — результат. */
  @Public()
  @Get('attempts/:token')
  async attempt(@Param('token') t: string) {
    const a = await this.prisma.testAttempt.findUnique({ where: { token: t }, include: { test: { include: { _count: { select: { questions: true } } } } } });
    if (!a) throw new NotFoundException('Ссылка недействительна');
    const base = {
      title: a.test.title,
      description: a.test.description,
      kind: a.test.kind,
      timeLimitMin: a.test.timeLimitMin,
      questionsCount: a.test._count.questions,
      startedAt: a.startedAt,
      deadlineAt: a.deadlineAt,
      finishedAt: a.finishedAt,
    };
    if (a.finishedAt) return { ...base, result: { score: a.score, maxScore: a.maxScore, percent: a.percent, level: a.level, timedOut: a.timedOut } };
    if (!a.startedAt) return base;
    return { ...base, questions: await this.attempts.takerView(a) };
  }

  @Public()
  @Post('attempts/:token/start')
  async start(@Param('token') t: string) {
    const a = await this.prisma.testAttempt.findUnique({ where: { token: t }, include: { test: true } });
    if (!a) throw new NotFoundException('Ссылка недействительна');
    if (a.finishedAt) throw new BadRequestException('Тест уже пройден');
    if (!a.test.isPublished && a.test.kind === 'placement') throw new BadRequestException('Тест закрыт');
    if (!a.startedAt) {
      const now = new Date();
      await this.prisma.testAttempt.update({
        where: { id: a.id },
        data: { startedAt: now, deadlineAt: a.test.timeLimitMin ? new Date(+now + a.test.timeLimitMin * 60_000) : null },
      });
    }
    return this.attempt(t);
  }

  @Public()
  @Post('attempts/:token/submit')
  async submit(@Param('token') t: string, @Body() dto: SubmitDto) {
    const a = await this.prisma.testAttempt.findUnique({ where: { token: t } });
    if (!a) throw new NotFoundException('Ссылка недействительна');
    return this.attempts.finish(a.id, dto.answers);
  }
}
