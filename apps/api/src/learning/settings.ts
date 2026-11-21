import { BadRequestException, Body, Controller, Get, Injectable, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, Max, Min, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit';
import { Ctx, RequestContext, RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';

export const ATTENDANCE_STATUSES = ['present', 'late', 'excused', 'absent'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const SKILLS = ['hoeren', 'lesen', 'schreiben', 'sprechen', 'overall'] as const;
export const GRADE_SCALES = ['percent', 'points', 'de_1_6'] as const;

/** Правила обучения центра (ТЗ 3.5). */
export interface LearningSettings {
  /** Списывать ли занятие с абонемента при каждом статусе. */
  charge: Record<AttendanceStatus, boolean>;
  /** Порог «N пропусков подряд» для задачи менеджеру и уведомления родителю. */
  absenceThreshold: number;
  /** Считать ли пропуск по уважительной причине в серии пропусков. */
  countExcusedInStreak: boolean;
  /** Шкала оценок: проценты, баллы (до gradeMax) или 1–6 по немецкой системе (1 — лучшая). */
  gradeScale: (typeof GRADE_SCALES)[number];
  gradeMax: number;
}

export const LEARNING_DEFAULTS: LearningSettings = {
  charge: { present: true, late: true, absent: true, excused: false },
  absenceThreshold: 2,
  countExcusedInStreak: false,
  gradeScale: 'percent',
  gradeMax: 100,
};

const KEY = 'learning';

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async learning(): Promise<LearningSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    const v = (row?.value ?? {}) as Partial<LearningSettings>;
    return { ...LEARNING_DEFAULTS, ...v, charge: { ...LEARNING_DEFAULTS.charge, ...(v.charge ?? {}) } };
  }

  async saveLearning(value: LearningSettings) {
    await this.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: value as any },
      update: { value: value as any },
    });
    return value;
  }
}

/** Проверка оценки по шкале центра; возвращает ошибку или null. */
export function validateGrade(s: LearningSettings, value: number): string | null {
  if (!Number.isFinite(value)) return 'Оценка — число';
  if (s.gradeScale === 'percent' && (value < 0 || value > 100)) return 'Оценка в процентах: от 0 до 100';
  if (s.gradeScale === 'points' && (value < 0 || value > s.gradeMax)) return `Оценка в баллах: от 0 до ${s.gradeMax}`;
  if (s.gradeScale === 'de_1_6' && (value < 1 || value > 6)) return 'Оценка по немецкой системе: от 1 до 6';
  return null;
}

/** Оценка в процентах — чтобы сравнивать оценки, поставленные в разных шкалах. */
export function toPercent(g: { value: unknown; scale: string; maxValue?: unknown }): number {
  const v = Number(g.value);
  if (g.scale === 'de_1_6') return ((6 - v) / 5) * 100;
  if (g.scale === 'points') return (v / Number(g.maxValue || 100)) * 100;
  return v;
}

class ChargeDto {
  @ApiProperty() @IsBoolean() present: boolean;
  @ApiProperty() @IsBoolean() late: boolean;
  @ApiProperty() @IsBoolean() excused: boolean;
  @ApiProperty() @IsBoolean() absent: boolean;
}

class LearningSettingsDto implements LearningSettings {
  @ApiProperty({ type: ChargeDto }) @ValidateNested() @Type(() => ChargeDto) charge: ChargeDto;
  @ApiProperty() @IsInt() @Min(1) @Max(10) absenceThreshold: number;
  @ApiProperty() @IsBoolean() countExcusedInStreak: boolean;
  @ApiProperty({ enum: GRADE_SCALES }) @IsIn(GRADE_SCALES) gradeScale: LearningSettings['gradeScale'];
  @ApiProperty() @IsNumber() @Min(1) @Max(1000) gradeMax: number;
}

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private settings: SettingsService, private audit: AuditService) {}

  @Get('learning')
  @RequirePermissions('attendance.read')
  learning() {
    return this.settings.learning();
  }

  /** Правила центра меняет владелец (право branches.update). */
  @Put('learning')
  @RequirePermissions('branches.update')
  async save(@Ctx() ctx: RequestContext, @Body() dto: LearningSettingsDto) {
    if (dto.gradeScale !== 'points') dto.gradeMax = 100;
    const before = await this.settings.learning();
    if (!dto.charge) throw new BadRequestException('Укажите правила списания');
    const after = await this.settings.saveLearning({ ...dto, charge: { ...dto.charge } });
    await this.audit.log({ userId: ctx.userId, entity: 'settings', entityId: KEY, action: 'update', before, after });
    return after;
  }
}
