import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';

export const LEAD_SOURCES = ['site', 'whatsapp', 'telegram', 'instagram', 'call', 'referral', 'manual'] as const;
export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export const GOALS = ['exam', 'work', 'study', 'family', 'other'] as const;

class UtmDto {
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() medium?: string;
  @IsOptional() @IsString() campaign?: string;
  @IsOptional() @IsString() content?: string;
  @IsOptional() @IsString() term?: string;
}

class LeadFields {
  @ApiPropertyOptional() @IsOptional() @IsString() lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() managerId?: string;
  @ApiPropertyOptional({ enum: LEVELS }) @IsOptional() @IsIn(LEVELS) currentLevel?: string;
  @ApiPropertyOptional({ enum: LEVELS }) @IsOptional() @IsIn(LEVELS) targetLevel?: string;
  @ApiPropertyOptional({ enum: GOALS }) @IsOptional() @IsIn(GOALS) goal?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() levelTestScore?: number;
}

export class LeadCreateDto extends LeadFields {
  @ApiProperty() @IsString() firstName: string;
  @ApiPropertyOptional({ enum: LEAD_SOURCES }) @IsOptional() @IsIn(LEAD_SOURCES) source?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() stageId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utmSource?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utmMedium?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utmCampaign?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utmContent?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utmTerm?: string;
  @ApiPropertyOptional({ type: UtmDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UtmDto)
  utm?: UtmDto;
}

export class LeadUpdateDto extends LeadFields {
  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
}

export class LeadQueryDto {
  @IsOptional() @IsString() stageId?: string;
  @IsOptional() @IsString() managerId?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() search?: string;
}

export class MoveStageDto {
  @ApiProperty() @IsString() stageId: string;
  @ApiPropertyOptional({ description: 'Обязательна для этапа «Отказ»' }) @IsOptional() @IsString() lostReason?: string;
}

export class ActivityDto {
  @ApiProperty({ enum: ['comment', 'call', 'message'] }) @IsIn(['comment', 'call', 'message']) type: string;
  @ApiProperty() @IsString() text: string;
}

export class MergeDto {
  @ApiProperty({ description: 'Лид, который будет поглощён' }) @IsString() sourceId: string;
}

/** Заявка с сайта (webhook). Формат упрощён для форм на сайте. */
export class SiteLeadDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(LEVELS) level?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(LEAD_SOURCES) source?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utm_source?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utm_medium?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utm_campaign?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utm_content?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() utm_term?: string;
}
