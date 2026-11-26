/**
 * Договоры по шаблонам из базы (консультационные услуги, FerienJob и др.).
 * Шаблон — обычный текст с полями подстановки {{…}}; вёрстка PDF определяется по тексту:
 *   строка ПРОПИСНЫМИ (ДОГОВОР, АКТ) — заголовок по центру; «1. Предмет договора» — раздел жирным;
 *   «Приложение …» и {{pagebreak}} — с новой страницы; строки «– …» — пункты списка.
 * Тексты шаблонов хранятся только в базе (репозиторий публичный).
 */
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit';
import { Ctx, RequestContext, RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';
import { CENTER_TZ } from '../schedule/time';
import { Company, genitive, shortName } from './company';
import { Doc, width } from './pdf';
import { numberToWords } from './words';

/** Поля подстановки — для подсказки в редакторе шаблонов. */
export const PLACEHOLDERS: [string, string][] = [
  ['number', 'Номер договора'],
  ['date', 'Дата: «26» ноября 2026 г.'],
  ['city', 'Город центра'],
  ['client.name', 'ФИО клиента'],
  ['client.passport', 'Паспорт (серия и номер)'],
  ['client.passportIssued', 'Кем и когда выдан паспорт'],
  ['client.regAddress', 'Адрес прописки'],
  ['client.address', 'Фактический адрес'],
  ['client.phone', 'Телефон клиента'],
  ['client.email', 'E-mail клиента'],
  ['client.birthDate', 'Дата рождения'],
  ['price', 'Сумма цифрами: 8 000'],
  ['priceText', 'Сумма словами: восемь тысяч'],
  ['priceWords', 'Сумма прописью полностью: Восемь тысяч сомов 00 тыйынов'],
  ['contract.number', 'Для акта: номер договора'],
  ['contract.date', 'Для акта: дата договора'],
  ['company.name', 'Название организации'],
  ['company.director', 'ФИО директора'],
  ['director.genitive', 'ФИО директора в род. падеже'],
  ['director.position', 'Должность в род. падеже'],
  ['director.short', 'Подпись: Иванов А. А.'],
  ['company.basis', 'На основании (Устава)'],
  ['company.registration', 'Свидетельство о регистрации'],
  ['company.address', 'Адрес организации'],
  ['company.inn', 'ИНН'],
  ['company.okpo', 'ОКПО'],
  ['company.bank', 'Банк'],
  ['company.account', 'Расчётный счёт'],
  ['company.bik', 'БИК'],
  ['company.swift', 'SWIFT'],
  ['company.phone', 'Телефон организации'],
  ['pagebreak', 'Новая страница'],
];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** «26» ноября 2026 г. — по времени центра. */
export function quotedDate(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', { timeZone: CENTER_TZ, day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `«${pad2(Number(parts.day))}» ${parts.month} ${parts.year} г.`;
}

export interface TemplateClient {
  firstName: string;
  lastName: string;
  passport: string | null;
  passportIssued: string | null;
  regAddress: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  birthDate: Date | null;
}

/** Значения полей для договора / акта. Пустые данные клиента — линия для заполнения от руки. */
export function templateVars(o: { number: string; date: Date; price: number; company: Company; client: TemplateClient; contract?: { number: string; date: Date } }) {
  const c = o.company;
  const blank = (v: string | null | undefined, len = 24) => (v && v.trim() ? v.trim() : '_'.repeat(len));
  const price = Math.round(o.price * 100) / 100;
  const priceWhole = Math.floor(price);
  return {
    number: o.number,
    date: quotedDate(o.date),
    city: c.city,
    'client.name': `${o.client.lastName} ${o.client.firstName}`.trim(),
    'client.passport': blank(o.client.passport, 16),
    'client.passportIssued': blank(o.client.passportIssued),
    'client.regAddress': blank(o.client.regAddress, 32),
    'client.address': blank(o.client.address ?? o.client.regAddress, 32),
    'client.phone': o.client.phone ? `+${o.client.phone}` : blank(null, 16),
    'client.email': blank(o.client.email, 16),
    'client.birthDate': o.client.birthDate ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' }).format(o.client.birthDate) : blank(null, 10),
    price: priceWhole.toLocaleString('ru-RU').replace(/\s/g, ' ') + (price !== priceWhole ? `,${pad2(Math.round((price - priceWhole) * 100))}` : ''),
    priceText: numberToWords(priceWhole),
    priceWords: (() => {
      const t = numberToWords(priceWhole);
      return t.charAt(0).toUpperCase() + t.slice(1) + ' сомов 00 тыйынов';
    })(),
    'contract.number': o.contract?.number ?? o.number,
    'contract.date': quotedDate(o.contract?.date ?? o.date),
    'company.name': c.name,
    'company.director': c.director,
    'director.genitive': c.directorGenitive || genitive(c.director),
    'director.position': c.directorPositionGenitive || genitive(c.directorPosition),
    'director.short': shortName(c.director),
    'company.basis': c.basis,
    'company.registration': c.registration || c.basis,
    'company.address': c.address,
    'company.inn': c.inn,
    'company.okpo': c.okpo,
    'company.bank': c.bank,
    'company.account': c.account,
    'company.bik': c.bik,
    'company.swift': c.swift,
    'company.phone': c.phone,
  } as Record<string, string>;
}

export function fill(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k === 'pagebreak' ? m : vars[k] ?? m));
}

/** Неизвестные поля в шаблоне — ошибка при сохранении (опечатки в {{…}}). */
export function unknownPlaceholders(text: string) {
  const known = new Set(PLACEHOLDERS.map(([k]) => k));
  return [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !known.has(k)))];
}

/** Вёрстка текста шаблона в PDF. */
export function renderText(doc: Doc, text: string) {
  const lines = text.replace(/\r/g, '').replace(/\t+/g, '    ').split('\n');
  let blank = 0;
  let first = true;
  for (const raw of lines) {
    const line = raw.replace(/ /g, ' ').replace(/\s+$/, '');
    if (!line.trim()) {
      if (++blank === 1 && !first) doc.moveDown(0.3);
      continue;
    }
    blank = 0;
    const t = line.trim();
    if (t === '{{pagebreak}}') {
      doc.addPage();
      continue;
    }
    // «Приложение № 1» — с новой страницы (кроме самого начала документа).
    if (/^Приложение\s*№/i.test(t) && !first && doc.y > doc.page.margins.top + 40) doc.addPage();
    first = false;
    // Заголовок — строка ПРОПИСНЫМИ без двоеточия; короткие «ИНН 0231…», «SWIFT DEMI…» заголовками не считаются.
    const letters = t.replace(/[^A-Za-zА-Яа-яЁё]/g, '');
    const isTitle = letters.length >= 3 && letters === letters.toUpperCase() && t.length < 90 && !/[:_]/.test(t) && (!/\d/.test(t) || letters.length >= 12);
    if (isTitle) {
      doc.font('B').fontSize(12).text(t, { align: 'center' });
      doc.font('R').fontSize(10);
      continue;
    }
    // Раздел «1. Предмет договора»: короткий, без точки и знаков препинания в конце.
    if (/^\d+\.\s+\S/.test(t) && t.length < 80 && !/[;:,.]$/.test(t) && !/^\d+\.\d/.test(t)) {
      doc.moveDown(0.3).font('B').fontSize(10.5).text(t).font('R').fontSize(10);
      continue;
    }
    if (/^Приложение/i.test(t)) {
      doc.font('B').fontSize(10).text(t, { align: 'right' }).font('R');
      continue;
    }
    const bullet = /^[–—-]\s*/.test(t);
    doc.font('R').fontSize(10).text(bullet ? t : t, { align: t.length > 90 ? 'justify' : 'left', lineGap: 1.2, indent: bullet ? 12 : 0, width: width(doc) });
  }
}

// ───────────── Управление шаблонами ─────────────

class TemplateDto {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ description: 'Текст договора с полями {{…}}' }) @IsString() @MaxLength(200_000) body: string;
  @ApiPropertyOptional({ description: 'Текст акта' }) @IsOptional() @IsString() @MaxLength(100_000) actBody?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) defaultPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class TemplateUpdateDto extends PartialType(TemplateDto) {}
class NumberingDto {
  @ApiProperty({ description: 'Следующий номер договора по шаблону' }) @IsInt() @Min(1) next: number;
}

export const CUSTOM_NEXT_KEY = 'customDocNext';

@ApiTags('documents')
@ApiBearerAuth()
@Controller('document-templates')
export class DocumentTemplatesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @RequirePermissions('documents.read')
  async list() {
    const rows = await this.prisma.documentTemplate.findMany({ orderBy: { name: 'asc' } });
    const next = await this.nextNumber();
    return { templates: rows, placeholders: PLACEHOLDERS, nextNumber: next };
  }

  async nextNumber() {
    const [row, last] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: CUSTOM_NEXT_KEY } }),
      this.prisma.issuedDocument.findFirst({ where: { type: 'custom' }, orderBy: { seq: 'desc' } }),
    ]);
    return Math.max(Number(row?.value ?? 1), (last?.seq ?? 0) + 1);
  }

  private check(dto: Partial<TemplateDto>) {
    const bad = [...unknownPlaceholders(dto.body ?? ''), ...unknownPlaceholders(dto.actBody ?? '')];
    if (bad.length) throw new BadRequestException(`Неизвестные поля: ${bad.map((b) => `{{${b}}}`).join(', ')}`);
  }

  @Post()
  @RequirePermissions('documents.update')
  async create(@Ctx() ctx: RequestContext, @Body() dto: TemplateDto) {
    this.check(dto);
    const t = await this.prisma.documentTemplate.create({ data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'document_template', entityId: t.id, action: 'create', after: { name: t.name } });
    return t;
  }

  @Patch(':id')
  @RequirePermissions('documents.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: TemplateUpdateDto) {
    this.check(dto);
    const before = await this.prisma.documentTemplate.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Шаблон не найден');
    const after = await this.prisma.documentTemplate.update({ where: { id }, data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'document_template', entityId: id, action: 'update', before: { name: before.name, length: before.body.length }, after: { name: after.name, length: after.body.length } });
    return after;
  }

  @Delete(':id')
  @RequirePermissions('documents.delete')
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    // Выданные договоры остаются в реестре; шаблон лишь скрывается.
    await this.prisma.documentTemplate.update({ where: { id }, data: { isActive: false } }).catch(() => {
      throw new NotFoundException('Шаблон не найден');
    });
    await this.audit.log({ userId: ctx.userId, entity: 'document_template', entityId: id, action: 'deactivate' });
    return { ok: true };
  }

  /** Продолжить нумерацию бумажных договоров (например, со 872). */
  @Put('numbering')
  @RequirePermissions('documents.update')
  async numbering(@Ctx() ctx: RequestContext, @Body() dto: NumberingDto) {
    const min = await this.nextNumber();
    const last = await this.prisma.issuedDocument.findFirst({ where: { type: 'custom' }, orderBy: { seq: 'desc' } });
    if (last && dto.next <= last.seq) throw new BadRequestException(`Номер ${dto.next} уже занят — следующий свободный ${min}`);
    await this.prisma.setting.upsert({ where: { key: CUSTOM_NEXT_KEY }, create: { key: CUSTOM_NEXT_KEY, value: dto.next }, update: { value: dto.next } });
    await this.audit.log({ userId: ctx.userId, entity: 'settings', entityId: CUSTOM_NEXT_KEY, action: 'update', after: dto });
    return { nextNumber: dto.next };
  }
}
