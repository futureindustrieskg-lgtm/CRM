/**
 * Перенос данных для пилота (ТЗ 7, этап 5): студенты и лиды из Excel (.xlsx) или CSV.
 * Порядок: загрузить файл → сопоставить колонки (в интерфейсе) → проверка без записи (dryRun) → импорт.
 * Дубли ищутся по телефону и e-mail — и в базе, и внутри файла; строки с ошибками пропускаются с причиной.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Module, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { AuditService } from '../audit/audit';
import { hasPermission } from '../common/permissions';
import { Ctx, RequestContext } from '../common/context';
import { FinanceService } from '../finance/finance.service';
import { PrismaService } from '../prisma/prisma.service';

export const MAX_ROWS = 5000;
const MAX_FILE_MB = 5;
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/** Поля импорта и подсказки для автосопоставления колонок (заголовки на русском, кыргызском, английском). */
export const FIELDS = {
  students: {
    fullName: ['фио', 'ф.и.о', 'аты-жөнү', 'full name', 'name', 'студент', 'ученик'],
    lastName: ['фамилия', 'фамилиясы', 'last name', 'surname'],
    firstName: ['имя', 'аты', 'first name'],
    phone: ['телефон', 'тел', 'phone', 'мобильный', 'номер', 'whatsapp'],
    email: ['email', 'e-mail', 'почта', 'электронная почта'],
    birthDate: ['дата рождения', 'туулган күнү', 'birth', 'birthday', 'др'],
    currentLevel: ['уровень', 'деңгээл', 'level', 'текущий уровень'],
    targetLevel: ['цель уровень', 'целевой уровень', 'target level'],
    status: ['статус', 'status'],
    parentName: ['родитель', 'фио родителя', 'ата-эне', 'parent'],
    parentPhone: ['телефон родителя', 'parent phone'],
    balance: ['баланс', 'остаток', 'долг', 'balance'],
    passport: ['паспорт', 'passport'],
    address: ['адрес', 'дарек', 'address'],
  },
  leads: {
    fullName: ['фио', 'ф.и.о', 'аты-жөнү', 'full name', 'name', 'клиент', 'имя клиента'],
    lastName: ['фамилия', 'last name', 'surname'],
    firstName: ['имя', 'аты', 'first name'],
    phone: ['телефон', 'тел', 'phone', 'номер', 'whatsapp'],
    email: ['email', 'e-mail', 'почта'],
    source: ['источник', 'канал', 'source'],
    currentLevel: ['уровень', 'level'],
    comment: ['комментарий', 'примечание', 'comment', 'note', 'заметка'],
  },
} as const;
type Entity = keyof typeof FIELDS;
type Row = Record<string, string | undefined>;

const ENTITIES = Object.keys(FIELDS) as Entity[];

/** Телефоны Кыргызстана: «0700 123 456», «700123456» → 996700123456 (как в остальной CRM — только цифры). */
export function importPhone(v?: string) {
  const d = (v ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 9) return `996${d}`;
  if (d.length === 10 && d.startsWith('0')) return `996${d.slice(1)}`;
  return d;
}

/** Дата: 31.12.2010, 31/12/2010, 2010-12-31 (Excel-даты приходят уже в последнем виде). */
export function importDate(v?: string): Date | null | 'bad' {
  const s = (v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return valid(+m[3], +m[2], +m[1]);
  return 'bad';
}
function valid(y: number, mo: number, d: number): Date | 'bad' {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y > 1900 && y < 2100 ? dt : 'bad';
}

const STATUS: Record<string, string> = {
  active: 'active', активен: 'active', активный: 'active', учится: 'active', да: 'active',
  paused: 'paused', пауза: 'paused', 'на паузе': 'paused', заморожен: 'paused',
  finished: 'finished', завершил: 'finished', окончил: 'finished', выпускник: 'finished',
  left: 'left', ушёл: 'left', ушел: 'left', выбыл: 'left', отчислен: 'left',
};
const SOURCES: Record<string, string> = {
  сайт: 'site', site: 'site', whatsapp: 'whatsapp', ватсап: 'whatsapp', вотсап: 'whatsapp', telegram: 'telegram', телеграм: 'telegram',
  instagram: 'instagram', инстаграм: 'instagram', инста: 'instagram', звонок: 'call', call: 'call', телефон: 'call',
  рекомендация: 'referral', referral: 'referral', 'сарафан': 'referral', друг: 'referral',
};

const level = (v?: string) => {
  const m = (v ?? '').toUpperCase().replace(/[АВС]/g, (c) => ({ А: 'A', В: 'B', С: 'C' })[c]!).match(/[ABC][12]/);
  return m && LEVELS.includes(m[0]) ? m[0] : null;
};

/** «Иванова Анна Сергеевна» → фамилия «Иванова», имя «Анна Сергеевна». */
function names(r: Row) {
  let last = r.lastName?.trim() ?? '';
  let first = r.firstName?.trim() ?? '';
  if ((!last || !first) && r.fullName?.trim()) {
    const parts = r.fullName.trim().split(/\s+/);
    if (!last) last = parts[0] ?? '';
    if (!first) first = parts.slice(1).join(' ');
  }
  return { last, first };
}

/** Простой разбор CSV: разделитель «;» или «,», кавычки, BOM (выгрузки из Excel и Google Таблиц). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Значение ячейки Excel → строка (даты — ГГГГ-ММ-ДД, формулы — результат). */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    return '';
  }
  return String(v);
}

/** Автосопоставление: колонка файла → поле CRM по заголовку. */
export function guessMapping(entity: Entity, headers: string[]) {
  const map: Record<string, number> = {};
  const norm = (s: string) => s.toLowerCase().replace(/[*:]/g, '').trim();
  const fields = FIELDS[entity] as Record<string, readonly string[]>;
  // Сначала точные совпадения (чтобы «телефон родителя» не ушёл в «телефон»), затем по вхождению.
  for (const pass of ['exact', 'includes'] as const) {
    for (const [field, hints] of Object.entries(fields)) {
      if (field in map) continue;
      const idx = headers.findIndex((h, i) => !Object.values(map).includes(i) && hints.some((x) => (pass === 'exact' ? norm(h) === x : norm(h).includes(x))));
      if (idx >= 0) map[field] = idx;
    }
  }
  return map;
}

class RunDto {
  @ApiPropertyOptional() @IsOptional() @IsString() branchId?: string;
  @ApiProperty({ description: 'Строки: { поле: значение }' }) @IsArray() @ArrayMaxSize(MAX_ROWS) @IsObject({ each: true }) rows: Row[];
  @ApiPropertyOptional({ description: 'Только проверка, без записи' }) @IsOptional() @IsBoolean() dryRun?: boolean;
}
class EntityParam {
  @IsIn(ENTITIES) entity: Entity;
}

interface Result {
  row: number;
  status: 'ok' | 'duplicate' | 'error';
  message?: string;
  id?: string;
}

@ApiTags('import')
@ApiBearerAuth()
@Controller('import')
export class ImportController {
  constructor(private prisma: PrismaService, private audit: AuditService, private finance: FinanceService) {}

  private allow(ctx: RequestContext, entity: Entity) {
    const perm = entity === 'students' ? 'students.create' : 'leads.create';
    if (!hasPermission(ctx.permissions, perm)) throw new ForbiddenException('Недостаточно прав');
  }

  /** Поля и подсказки — для экрана сопоставления колонок. */
  @Get('fields')
  fields() {
    return Object.fromEntries(ENTITIES.map((e) => [e, Object.keys(FIELDS[e])]));
  }

  /** Шаблон Excel с заголовками и примером строки. */
  @Get('template/:entity')
  async template(@Ctx() ctx: RequestContext, @Param() p: EntityParam, @Res() res: Response) {
    this.allow(ctx, p.entity);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(p.entity === 'students' ? 'Студенты' : 'Лиды');
    const sample =
      p.entity === 'students'
        ? { 'ФИО': 'Иванова Анна', 'Телефон': '0700 123 456', 'E-mail': 'anna@example.com', 'Дата рождения': '15.04.2005', 'Уровень': 'A2', 'Статус': 'активен', 'Родитель': 'Иванова Мария', 'Телефон родителя': '0555 000 111', 'Баланс': '-4500', 'Паспорт': '', 'Адрес': '' }
        : { 'ФИО': 'Петров Иван', 'Телефон': '0700 987 654', 'E-mail': '', 'Источник': 'instagram', 'Уровень': 'A1', 'Комментарий': 'Хочет в вечернюю группу' };
    ws.columns = Object.keys(sample).map((k) => ({ header: k, key: k, width: Math.max(14, k.length + 4) }));
    ws.addRow(sample);
    ws.getRow(1).font = { bold: true };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.entity === 'students' ? 'Шаблон студенты.xlsx' : 'Шаблон лиды.xlsx')}`);
    await wb.xlsx.write(res);
    res.end();
  }

  /** Разбор файла: листы, заголовки (первая строка), строки и предложенное сопоставление колонок. */
  @Post('parse')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 } }))
  async parse(@Ctx() ctx: RequestContext, @UploadedFile() file?: Express.Multer.File) {
    if (!hasPermission(ctx.permissions, 'students.create') && !hasPermission(ctx.permissions, 'leads.create')) throw new ForbiddenException('Недостаточно прав');
    if (!file) throw new BadRequestException('Файл не передан');
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').toLowerCase();
    let sheets: { name: string; rows: string[][] }[];
    if (name.endsWith('.csv') || file.mimetype === 'text/csv') {
      sheets = [{ name: 'CSV', rows: parseCsv(file.buffer.toString('utf8')) }];
    } else if (name.endsWith('.xlsx')) {
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
      } catch {
        throw new BadRequestException('Не удалось прочитать файл Excel');
      }
      sheets = wb.worksheets.map((ws) => {
        const rows: string[][] = [];
        ws.eachRow({ includeEmpty: false }, (r) => {
          const vals = (r.values as ExcelJS.CellValue[]).slice(1).map(cellText);
          if (vals.some((v) => v.trim())) rows.push(vals);
        });
        return { name: ws.name, rows };
      });
    } else {
      throw new BadRequestException('Поддерживаются файлы .xlsx и .csv (старый .xls сохраните как .xlsx)');
    }
    return sheets
      .filter((s) => s.rows.length)
      .map((s) => {
        const width = Math.max(...s.rows.map((r) => r.length));
        const headers = Array.from({ length: width }, (_, i) => (s.rows[0][i] ?? '').trim() || `Колонка ${i + 1}`);
        const rows = s.rows.slice(1, MAX_ROWS + 1).map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim()));
        return {
          name: s.name,
          headers,
          rows,
          truncated: s.rows.length - 1 > MAX_ROWS,
          mapping: { students: guessMapping('students', headers), leads: guessMapping('leads', headers) },
        };
      });
  }

  /** Проверка (dryRun) или импорт строк, уже сопоставленных с полями CRM. */
  @Post(':entity')
  async run(@Ctx() ctx: RequestContext, @Param() p: EntityParam, @Body() dto: RunDto) {
    this.allow(ctx, p.entity);
    const branchId = ctx.branchId ?? dto.branchId;
    if (!branchId) throw new BadRequestException('Выберите филиал');
    if (!(await this.prisma.branch.findUnique({ where: { id: branchId } }))) throw new BadRequestException('Филиал не найден');
    const results = p.entity === 'students' ? await this.students(ctx, branchId, dto.rows, !!dto.dryRun) : await this.leads(ctx, branchId, dto.rows, !!dto.dryRun);
    const count = (s: Result['status']) => results.filter((r) => r.status === s).length;
    const summary = { total: results.length, ok: count('ok'), duplicates: count('duplicate'), errors: count('error'), dryRun: !!dto.dryRun };
    if (!dto.dryRun) await this.audit.log({ userId: ctx.userId, entity: 'import', entityId: p.entity, action: 'import', after: summary });
    return { ...summary, results };
  }

  private async students(ctx: RequestContext, branchId: string, rows: Row[], dryRun: boolean): Promise<Result[]> {
    const out: Result[] = [];
    const seenPhones = new Set<string>();
    const seenEmails = new Set<string>();
    const parentRole = await this.prisma.role.findUnique({ where: { code: 'parent' } });
    for (const [i, r] of rows.entries()) {
      const row = i + 2; // строка в файле (1 — заголовки)
      const { last, first } = names(r);
      const phone = importPhone(r.phone);
      const email = r.email?.trim().toLowerCase() || null;
      const birth = importDate(r.birthDate);
      const status = r.status?.trim() ? STATUS[r.status.trim().toLowerCase()] : 'active';
      const bal = r.balance?.trim() ? Number(r.balance.replace(/\s/g, '').replace(',', '.')) : 0;
      const err =
        !last || !first ? 'Нужны фамилия и имя (или ФИО)' :
        phone && (phone.length < 9 || phone.length > 15) ? `Неверный телефон: ${r.phone}` :
        email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? `Неверный e-mail: ${r.email}` :
        birth === 'bad' ? `Неверная дата рождения: ${r.birthDate} (нужно ДД.ММ.ГГГГ)` :
        !status ? `Неизвестный статус: ${r.status} (активен, пауза, завершил, ушёл)` :
        Number.isNaN(bal) ? `Баланс — число: ${r.balance}` :
        r.currentLevel?.trim() && !level(r.currentLevel) ? `Неизвестный уровень: ${r.currentLevel} (A1…C2)` : null;
      if (err) {
        out.push({ row, status: 'error', message: err });
        continue;
      }
      // Дубли: в файле и в базе (по телефону, затем по e-mail).
      if ((phone && seenPhones.has(phone)) || (email && seenEmails.has(email))) {
        out.push({ row, status: 'duplicate', message: 'Повтор в файле' });
        continue;
      }
      const existing =
        (phone && (await this.prisma.student.findFirst({ where: { phone }, select: { id: true, firstName: true, lastName: true } }))) ||
        (email && (await this.prisma.student.findFirst({ where: { email }, select: { id: true, firstName: true, lastName: true } })));
      if (existing) {
        out.push({ row, status: 'duplicate', message: `Уже есть: ${existing.lastName} ${existing.firstName}`, id: existing.id });
        continue;
      }
      if (phone) seenPhones.add(phone);
      if (email) seenEmails.add(email);
      if (dryRun) {
        out.push({ row, status: 'ok' });
        continue;
      }
      try {
        const s = await this.prisma.student.create({
          data: {
            branchId,
            firstName: first,
            lastName: last,
            phone,
            email,
            birthDate: birth instanceof Date ? birth : null,
            currentLevel: level(r.currentLevel),
            targetLevel: level(r.targetLevel),
            status: status!,
            passport: r.passport?.trim() || null,
            address: r.address?.trim() || null,
          },
        });
        // Начальный остаток: отдельная проводка «opening» (в выручку не входит), баланс пересчитывается.
        if (bal) {
          await this.prisma.payment.create({
            data: { branchId, studentId: s.id, amount: bal, method: 'transfer', type: 'opening', comment: 'Начальный остаток при переносе данных', createdById: ctx.userId },
          });
          await this.finance.recalcBalance(s.id);
        }
        // Родитель: учётная запись по телефону (без пароля — доступ выдаётся позже), связь с ребёнком.
        const pPhone = importPhone(r.parentPhone);
        if (parentRole && (pPhone || r.parentName?.trim())) {
          const [pLast, ...pFirst] = (r.parentName?.trim() || 'Родитель').split(/\s+/);
          const parent =
            (pPhone && (await this.prisma.user.findUnique({ where: { phone: pPhone } }))) ||
            (await this.prisma.user.create({ data: { phone: pPhone, firstName: pFirst.join(' ') || pLast, lastName: pFirst.length ? pLast : '' } }));
          await this.prisma.userRole.upsert({
            where: { userId_roleId_branchId: { userId: parent.id, roleId: parentRole.id, branchId } },
            create: { userId: parent.id, roleId: parentRole.id, branchId },
            update: {},
          });
          await this.prisma.parentStudent.create({ data: { parentId: parent.id, studentId: s.id } });
        }
        out.push({ row, status: 'ok', id: s.id });
      } catch (e) {
        out.push({ row, status: 'error', message: e instanceof Error ? e.message.split('\n').pop()?.slice(0, 200) : String(e) });
      }
    }
    return out;
  }

  private async leads(ctx: RequestContext, branchId: string, rows: Row[], dryRun: boolean): Promise<Result[]> {
    const out: Result[] = [];
    const seenPhones = new Set<string>();
    const stage = await this.prisma.pipelineStage.findFirstOrThrow({ orderBy: { sort: 'asc' } });
    for (const [i, r] of rows.entries()) {
      const row = i + 2;
      const { last, first } = names(r);
      const firstName = first || last;
      const phone = importPhone(r.phone);
      const email = r.email?.trim().toLowerCase() || null;
      const source = r.source?.trim() ? SOURCES[r.source.trim().toLowerCase()] ?? 'manual' : 'manual';
      const err = !firstName ? 'Нужно имя (или ФИО)' : !phone && !email ? 'Нужен телефон или e-mail' : phone && (phone.length < 9 || phone.length > 15) ? `Неверный телефон: ${r.phone}` : null;
      if (err) {
        out.push({ row, status: 'error', message: err });
        continue;
      }
      if (phone && seenPhones.has(phone)) {
        out.push({ row, status: 'duplicate', message: 'Повтор в файле' });
        continue;
      }
      const existing = phone
        ? await this.prisma.lead.findFirst({ where: { phone, mergedIntoId: null }, select: { id: true, firstName: true } })
        : await this.prisma.lead.findFirst({ where: { email: email!, mergedIntoId: null }, select: { id: true, firstName: true } });
      if (existing) {
        out.push({ row, status: 'duplicate', message: `Уже есть лид: ${existing.firstName}`, id: existing.id });
        continue;
      }
      if (phone) seenPhones.add(phone);
      if (dryRun) {
        out.push({ row, status: 'ok' });
        continue;
      }
      try {
        const lead = await this.prisma.lead.create({
          data: { branchId, stageId: stage.id, firstName, lastName: first ? last || null : null, phone, email, source, currentLevel: level(r.currentLevel) },
        });
        await this.prisma.leadActivity.create({
          data: { leadId: lead.id, userId: ctx.userId, type: 'system', text: `Лид перенесён из файла${r.comment?.trim() ? `. ${r.comment.trim()}` : ''}`.slice(0, 2000) },
        });
        out.push({ row, status: 'ok', id: lead.id });
      } catch (e) {
        out.push({ row, status: 'error', message: e instanceof Error ? e.message.split('\n').pop()?.slice(0, 200) : String(e) });
      }
    }
    return out;
  }
}

@Module({ controllers: [ImportController] })
export class ImportModule {}
