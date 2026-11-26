import { Body, Controller, Get, Injectable, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit';
import { Ctx, RequestContext, RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Реквизиты центра для договоров, счетов, актов и сертификатов.
 * Хранятся в базе (не в коде): репозиторий проекта публичный.
 */
export interface Company {
  name: string;
  /** Короткое название для сертификата и уведомлений. */
  brand: string;
  director: string;
  directorPosition: string;
  /** Для договора: «в лице Генерального директора Иванова …». Пусто — склоняется автоматически. */
  directorPositionGenitive: string;
  directorGenitive: string;
  /** На основании чего действует директор. */
  basis: string;
  address: string;
  city: string;
  inn: string;
  okpo: string;
  bank: string;
  account: string;
  bik: string;
  swift: string;
  phone: string;
  email: string;
}

export const COMPANY_DEFAULTS: Company = {
  name: 'Учебный центр',
  brand: 'Deutschzentrum',
  director: '',
  directorPosition: 'Генеральный директор',
  directorPositionGenitive: '',
  directorGenitive: '',
  basis: 'Устава',
  address: '',
  city: '',
  inn: '',
  okpo: '',
  bank: '',
  account: '',
  bik: '',
  swift: '',
  phone: '',
  email: '',
};

/**
 * Родительный падеж для «в лице …» (мужской род, частые случаи): «Генеральный директор» → «Генерального директора»,
 * «Иванов Азамат-Алтай Иванович» → «Иванова Азамат-Алтая Ивановича».
 * Для женских ФИО и редких форм заполните поле вручную в реквизитах.
 */
export function genitive(text: string) {
  const word = (w: string) => {
    if (/ый$/.test(w)) return w.replace(/ый$/, 'ого');
    if (/ий$/.test(w)) return w.replace(/ий$/, 'его');
    if (/ой$/.test(w)) return w.replace(/ой$/, 'ого');
    if (/й$/.test(w)) return w.replace(/й$/, 'я');
    if (/ь$/.test(w)) return w.replace(/ь$/, 'я');
    if (/[бвгджзклмнпрстфхцчшщ]$/i.test(w)) return w + 'а';
    return w;
  };
  // В составных словах (Азамат-Алтай) склоняется последняя часть.
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.split('-').map((p, j, a) => (j === a.length - 1 ? word(p) : p)).join('-'))
    .join(' ');
}

/** «Иванов Азамат-Алтай Иванович» → «Иванов А.-А. И.» для подписи. */
export function shortName(full: string) {
  const [last, ...rest] = full.trim().split(/\s+/);
  if (!last) return '';
  const initials = rest.map((p) => p.split('-').map((x) => `${x[0]}.`).join('-')).join(' ');
  return `${last} ${initials}`.trim();
}

@Injectable()
export class CompanyService {
  constructor(private prisma: PrismaService) {}

  async get(): Promise<Company> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'company' } });
    return { ...COMPANY_DEFAULTS, ...((row?.value ?? {}) as Partial<Company>) };
  }

  /** Строки реквизитов для документа. */
  requisites(c: Company): string[] {
    return [
      c.name,
      c.address && `Адрес: ${c.address}`,
      c.inn && `ИНН: ${c.inn}`,
      c.okpo && `ОКПО: ${c.okpo}`,
      c.bank && `Банк: ${c.bank}`,
      c.account && `Р/с: ${c.account}`,
      c.bik && `БИК: ${c.bik}`,
      c.swift && `SWIFT: ${c.swift}`,
      c.phone && `Тел.: ${c.phone}`,
      c.email && `E-mail: ${c.email}`,
    ].filter(Boolean) as string[];
  }
}

class CompanyDto implements Partial<Company> {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) brand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) director?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) directorPosition?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) directorPositionGenitive?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) directorGenitive?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) basis?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) inn?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) okpo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) bank?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) account?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) bik?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) swift?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) email?: string;
}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('settings/company')
export class CompanyController {
  constructor(private prisma: PrismaService, private audit: AuditService, private company: CompanyService) {}

  @Get()
  @RequirePermissions('documents.read')
  get() {
    return this.company.get();
  }

  /** Реквизиты меняет владелец (право branches.update). */
  @Put()
  @RequirePermissions('branches.update')
  async save(@Ctx() ctx: RequestContext, @Body() dto: CompanyDto) {
    const before = await this.company.get();
    const value = { ...before, ...Object.fromEntries(Object.entries(dto).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])) };
    await this.prisma.setting.upsert({ where: { key: 'company' }, create: { key: 'company', value }, update: { value } });
    await this.audit.log({ userId: ctx.userId, entity: 'settings', entityId: 'company', action: 'update', before, after: value });
    return value;
  }
}
