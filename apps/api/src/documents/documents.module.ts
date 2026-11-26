import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { AuditService } from '../audit/audit';
import { branchScope, Ctx, RequestContext, RequirePermissions } from '../common/context';
import { subscriptionLessonPrice } from '../finance/finance.service';
import { LearningModule } from '../learning/learning.module';
import { SettingsService, toPercent } from '../learning/settings';
import { PrismaService } from '../prisma/prisma.service';
import { CENTER_TZ } from '../schedule/time';
import { Company, CompanyController, CompanyService, genitive, shortName } from './company';
import { createDoc, Doc, finish, footer, heading, leftRight, para, table, title, twoColumns } from './pdf';
import { amountInWords, plural } from './words';

export const DOC_TYPES = ['contract', 'invoice', 'act', 'reference', 'certificate'] as const;
type DocType = (typeof DOC_TYPES)[number];
const PREFIX: Record<DocType, string> = { contract: 'Д', invoice: 'С', act: 'А', reference: 'СП', certificate: 'СТ' };
const NAMES: Record<DocType, string> = { contract: 'Договор', invoice: 'Счёт на оплату', act: 'Акт оказанных услуг', reference: 'Справка об обучении', certificate: 'Сертификат' };
const SUB_TYPES: Record<string, string> = { month: 'помесячный', level: 'за уровень', package: 'пакет занятий', installment: 'в рассрочку' };
const PROVIDERS = ['goethe', 'telc', 'osd', 'testdaf'] as const;
const PROVIDER_NAMES: Record<string, string> = { goethe: 'Goethe-Zertifikat', telc: 'telc', osd: 'ÖSD', testdaf: 'TestDaF' };

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `${round2(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\s/g, ' ')} сом`;
const d = (x: Date | string | null | undefined) =>
  x ? new Intl.DateTimeFormat('ru-RU', { timeZone: CENTER_TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(x)) : '—';
/** «23 ноября 2026 г.» (Intl уже добавляет «г.»). */
const dLong = (x: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: CENTER_TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(x);
const fio = (p: { lastName?: string | null; firstName: string }) => `${p.lastName ?? ''} ${p.firstName}`.trim();
const phone = (p?: string | null) => (p ? `+${p}` : '—');

class IssueDto {
  @ApiProperty({ enum: DOC_TYPES }) @IsIn(DOC_TYPES) type: DocType;
  @ApiPropertyOptional({ description: 'Для договора, счёта, акта' }) @IsOptional() @IsString() subscriptionId?: string;
  @ApiPropertyOptional({ description: 'Для справки и сертификата' }) @IsOptional() @IsString() studentId?: string;
  @ApiPropertyOptional({ description: 'Для сертификата (обязательно) и справки' }) @IsOptional() @IsString() groupId?: string;
  @ApiPropertyOptional({ description: 'Сумма счёта; по умолчанию — неоплаченный остаток (для рассрочки — очередной платёж)' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number;
}

class ExamDto {
  @ApiProperty({ enum: PROVIDERS }) @IsIn(PROVIDERS) provider: string;
  @ApiProperty() @IsString() level: string;
  @ApiProperty() @IsDateString() date: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() score?: number;
  @ApiPropertyOptional({ enum: ['registered', 'passed', 'failed'] }) @IsOptional() @IsIn(['registered', 'passed', 'failed']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}
class ExamUpdateDto extends PartialType(ExamDto) {}

type IssuedRow = { id: string; type: string; number: string; createdAt: Date; studentId: string; subscriptionId: string | null; groupId: string | null; amount: Prisma.Decimal | null };

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private company: CompanyService,
    private learning: SettingsService,
  ) {}

  /** Реестр выданных документов (по студенту или последние). */
  @Get()
  @RequirePermissions('documents.read')
  list(@Ctx() ctx: RequestContext, @Query('studentId') studentId?: string, @Query('type') type?: string) {
    return this.prisma.issuedDocument.findMany({
      where: { studentId, type, student: branchScope(ctx) },
      include: { student: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  /** Выдать документ: присваивается сквозной номер, документ попадает в реестр. */
  @Post()
  @RequirePermissions('documents.create')
  async issue(@Ctx() ctx: RequestContext, @Body() dto: IssueDto) {
    let studentId = dto.studentId;
    let amount: number | undefined;
    if (['contract', 'invoice', 'act'].includes(dto.type)) {
      if (!dto.subscriptionId) throw new BadRequestException('Укажите абонемент');
      const sub = await this.prisma.subscription.findFirst({
        where: { id: dto.subscriptionId, ...branchScope(ctx) },
        include: { payments: { where: { deletedAt: null } }, _count: { select: { attendance: true } } },
      });
      if (!sub) throw new NotFoundException('Абонемент не найден');
      studentId = sub.studentId;
      if (dto.type === 'invoice') {
        const unpaid = round2(Number(sub.price) - sub.payments.reduce((s, p) => s + Number(p.amount), 0));
        if (unpaid <= 0 && !dto.amount) throw new BadRequestException('Абонемент оплачен полностью');
        amount = dto.amount ?? (sub.installments > 1 ? Math.min(unpaid, round2(Number(sub.price) / sub.installments)) : unpaid);
      }
      if (dto.type === 'act') {
        if (!sub._count.attendance) throw new BadRequestException('По абонементу ещё нет проведённых занятий');
        amount = round2(sub._count.attendance * subscriptionLessonPrice(sub));
      }
      if (dto.type === 'contract') amount = Number(sub.price);
    } else {
      if (!studentId) throw new BadRequestException('Укажите студента');
      if (dto.type === 'certificate' && !dto.groupId) throw new BadRequestException('Укажите группу, по которой выдаётся сертификат');
    }
    const student = await this.prisma.student.findFirst({ where: { id: studentId, ...branchScope(ctx) } });
    if (!student) throw new NotFoundException('Студент не найден');
    if (dto.groupId && !(await this.prisma.groupStudent.findFirst({ where: { groupId: dto.groupId, studentId: student.id, waitlist: false } }))) {
      throw new BadRequestException('Студент не учился в этой группе');
    }

    const year = Number(new Intl.DateTimeFormat('en', { timeZone: CENTER_TZ, year: 'numeric' }).format(new Date()));
    // Номер: максимальный по типу и году + 1; при одновременной выдаче — повтор.
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.issuedDocument.findFirst({ where: { type: dto.type, year }, orderBy: { seq: 'desc' } });
      const seq = (last?.seq ?? 0) + 1;
      try {
        const doc = await this.prisma.issuedDocument.create({
          data: {
            type: dto.type,
            year,
            seq,
            number: `${PREFIX[dto.type]}-${year}-${String(seq).padStart(4, '0')}`,
            studentId: student.id,
            subscriptionId: dto.subscriptionId,
            groupId: dto.groupId,
            amount,
            createdById: ctx.userId,
          },
        });
        await this.audit.log({ userId: ctx.userId, entity: 'document', entityId: doc.id, action: 'issue', after: doc });
        return doc;
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }
    }
    throw new BadRequestException('Не удалось присвоить номер, повторите');
  }

  /** PDF выданного документа (по данным на сейчас, с номером и датой выдачи). */
  @Get(':id/pdf')
  @RequirePermissions('documents.read')
  async pdf(@Ctx() ctx: RequestContext, @Param('id') id: string, @Res() res: Response) {
    const row = await this.prisma.issuedDocument.findFirst({ where: { id, student: branchScope(ctx) } });
    if (!row) throw new NotFoundException('Документ не найден');
    const company = await this.company.get();
    const buf = await this.render(row, company);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`${NAMES[row.type as DocType]} ${row.number}.pdf`)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buf);
  }

  private async render(row: IssuedRow, c: Company): Promise<Buffer> {
    switch (row.type as DocType) {
      case 'contract':
        return this.contract(row, c);
      case 'invoice':
        return this.invoice(row, c);
      case 'act':
        return this.act(row, c);
      case 'reference':
        return this.reference(row, c);
      case 'certificate':
        return this.certificate(row, c);
    }
  }

  private async subscription(id: string) {
    const s = await this.prisma.subscription.findUnique({
      where: { id },
      include: {
        course: true,
        group: { select: { name: true, startDate: true, endDate: true, scheduleRule: true } },
        student: { include: { parents: { where: { isPayer: true }, include: { parent: true } }, branch: true } },
        payments: { where: { deletedAt: null } },
        _count: { select: { attendance: true } },
      },
    });
    if (!s) throw new NotFoundException('Абонемент не найден');
    const payer = s.student.parents[0]?.parent;
    return { s, payer };
  }

  private customer(s: { student: { firstName: string; lastName: string; phone: string | null; birthDate: Date | null } }, payer?: { firstName: string; lastName: string; phone: string | null } | null) {
    return payer
      ? { name: fio(payer), lines: [fio(payer), `Тел.: ${phone(payer.phone)}`, `в интересах обучающегося: ${fio(s.student)}`] }
      : { name: fio(s.student), lines: [fio(s.student), s.student.birthDate ? `Дата рождения: ${d(s.student.birthDate)}` : '', `Тел.: ${phone(s.student.phone)}`].filter(Boolean) };
  }

  private executor(c: Company) {
    return { title: 'Исполнитель', lines: [...this.company.requisites(c), c.director ? `${c.directorPosition}: ${c.director}` : ''].filter(Boolean), sign: shortName(c.director) || '__________' };
  }

  /** Договор на оказание платных образовательных услуг. Шаблон по умолчанию — согласуйте текст с юристом. */
  private async contract(row: IssuedRow, c: Company) {
    const { s, payer } = await this.subscription(row.subscriptionId!);
    const L = await this.learning.learning();
    const cust = this.customer(s, payer);
    const price = Number(s.price);
    const doc = createDoc({ title: `Договор ${row.number}` });
    title(doc, `ДОГОВОР № ${row.number}`, 'на оказание платных образовательных услуг');
    leftRight(doc, `г. ${c.city || s.student.branch.name}`, dLong(row.createdAt));
    para(
      doc,
      `${c.name}, в лице ${c.directorPositionGenitive || genitive(c.directorPosition) || 'директора'} ${c.directorGenitive || genitive(c.director) || '________________'}, действующего на основании ${c.basis}, именуемое в дальнейшем «Исполнитель», с одной стороны, и ${cust.name}, именуемый(ая) в дальнейшем «Заказчик»${payer ? `, действующий(ая) в интересах обучающегося ${fio(s.student)} («Обучающийся»)` : ''}, с другой стороны, заключили настоящий договор о нижеследующем.`,
    );
    heading(doc, '1. Предмет договора');
    para(
      doc,
      `1.1. Исполнитель оказывает услуги по обучению немецкому языку по курсу «${s.course.name}» (уровень ${s.course.level})${s.group ? `, группа «${s.group.name}»` : ''}, а Заказчик оплачивает их на условиях договора.`,
    );
    para(doc, `1.2. Объём услуг: ${s.lessonsTotal} ${plural(s.lessonsTotal, 'занятие', 'занятия', 'занятий')}; абонемент ${SUB_TYPES[s.type] ?? s.type}. Учебная программа курса — ${s.course.academicHours} академических часов. Расписание занятий публикуется в личном кабинете.`);
    heading(doc, '2. Стоимость и порядок оплаты');
    para(doc, `2.1. Стоимость услуг: ${money(price)} (${amountInWords(price)})${Number(s.discountPercent) > 0 ? `, с учётом скидки ${Number(s.discountPercent)} %` : ''}. Цена одного занятия — ${money(subscriptionLessonPrice(s))}.`);
    para(
      doc,
      s.installments > 1
        ? `2.2. Оплата производится в рассрочку: ${s.installments} платежа(ей) по ${money(price / s.installments)}, первый — до начала обучения.`
        : '2.2. Оплата производится до начала обучения в полном объёме.',
    );
    para(doc, '2.3. Способы оплаты: наличными в кассе филиала, банковским переводом на расчётный счёт Исполнителя, QR-оплатой. Валюта — кыргызский сом.');
    heading(doc, '3. Посещение и пропуски');
    const charged = [L.charge.absent ? 'пропуск без уважительной причины' : '', L.charge.late ? 'опоздание' : ''].filter(Boolean);
    para(
      doc,
      `3.1. Занятие считается оказанным и списывается с абонемента при посещении${charged.length ? `, а также в случае: ${charged.join(', ')}` : ''}. ${L.charge.excused ? 'Пропуск по уважительной причине также списывается.' : 'Пропуск по уважительной причине (при предупреждении и подтверждении) не списывается.'}`,
    );
    para(doc, '3.2. Перенос и отмена занятий по инициативе Исполнителя сообщаются Заказчику заранее; отменённые занятия не списываются.');
    heading(doc, '4. Права и обязанности сторон');
    para(doc, '4.1. Исполнитель обязуется организовать обучение квалифицированными преподавателями, предоставлять учебные материалы и сведения об успеваемости в личном кабинете.');
    para(doc, '4.2. Заказчик обязуется своевременно оплачивать услуги, соблюдать правила учебного центра и бережно относиться к имуществу Исполнителя.');
    heading(doc, '5. Расторжение и возврат');
    para(doc, '5.1. Договор может быть расторгнут по инициативе любой из сторон с письменным уведомлением. При расторжении стоимость использованных занятий удерживается по цене одного занятия, остаток возвращается Заказчику в течение 10 рабочих дней.');
    para(doc, '5.2. При переводе в другую группу неиспользованный остаток стоимости переносится на новую группу.');
    heading(doc, '6. Персональные данные и прочие условия');
    para(doc, '6.1. Заказчик даёт согласие на обработку персональных данных для исполнения договора и информирования об обучении (SMS, мессенджеры, e-mail).');
    para(doc, `6.2. Договор вступает в силу с момента подписания и действует до полного исполнения обязательств. Составлен в двух экземплярах, по одному для каждой стороны.`);
    heading(doc, '7. Реквизиты и подписи сторон');
    twoColumns(doc, this.executor(c), { title: 'Заказчик', lines: cust.lines, sign: shortName(cust.name) });
    footer(doc, `Договор № ${row.number} · ${c.name}`);
    return finish(doc);
  }

  private async invoice(row: IssuedRow, c: Company) {
    const { s, payer } = await this.subscription(row.subscriptionId!);
    const amount = Number(row.amount);
    const doc = createDoc({ title: `Счёт ${row.number}` });
    doc.font('B').fontSize(11).text(c.name);
    doc.font('R').fontSize(9);
    this.company.requisites(c).slice(1).forEach((l) => doc.text(l));
    title(doc, `СЧЁТ НА ОПЛАТУ № ${row.number}`, `от ${dLong(row.createdAt)}`);
    const cust = this.customer(s, payer);
    para(doc, `Плательщик: ${cust.name}${payer ? ` (за обучение: ${fio(s.student)})` : ''}`);
    const paid = s.payments.reduce((x, p) => x + Number(p.amount), 0);
    table(
      doc,
      [
        { title: '№', w: 0.06, align: 'center' },
        { title: 'Наименование услуги', w: 0.54 },
        { title: 'Кол-во', w: 0.1, align: 'center' },
        { title: 'Цена', w: 0.15, align: 'right' },
        { title: 'Сумма', w: 0.15, align: 'right' },
      ],
      [
        [
          '1',
          `Обучение немецкому языку: «${s.course.name}»${s.group ? `, группа «${s.group.name}»` : ''}; абонемент ${SUB_TYPES[s.type] ?? s.type}, ${s.lessonsTotal} ${plural(s.lessonsTotal, 'занятие', 'занятия', 'занятий')}${s.installments > 1 ? ` (платёж по рассрочке)` : ''}`,
          '1',
          money(amount),
          money(amount),
        ],
      ],
    );
    doc.font('B').text(`Итого к оплате: ${money(amount)}`, { align: 'right' });
    doc.font('R').text(`Без НДС. Стоимость абонемента: ${money(Number(s.price))}, оплачено ранее: ${money(paid)}.`, { align: 'right' });
    doc.moveDown(0.5);
    para(doc, `Сумма прописью: ${amountInWords(amount)}.`);
    para(doc, 'Счёт действителен 10 дней. При оплате переводом укажите номер счёта и ФИО обучающегося в назначении платежа.');
    doc.moveDown(1.5);
    doc.text(`${c.directorPosition} _________________ / ${shortName(c.director) || '__________'} /`);
    footer(doc, `Счёт № ${row.number} · ${c.name}`);
    return finish(doc);
  }

  private async act(row: IssuedRow, c: Company) {
    const { s, payer } = await this.subscription(row.subscriptionId!);
    const lessons = await this.prisma.attendance.findMany({
      where: { subscriptionId: s.id },
      include: { lesson: { select: { startsAt: true } } },
      orderBy: { lesson: { startsAt: 'asc' } },
    });
    const lp = subscriptionLessonPrice(s);
    const amount = Number(row.amount);
    const doc = createDoc({ title: `Акт ${row.number}` });
    title(doc, `АКТ № ${row.number}`, 'об оказании образовательных услуг');
    leftRight(doc, `г. ${c.city || s.student.branch.name}`, dLong(row.createdAt));
    const cust = this.customer(s, payer);
    para(doc, `Исполнитель ${c.name} оказал, а Заказчик ${cust.name} принял следующие услуги по обучению${payer ? ` обучающегося ${fio(s.student)}` : ''}:`);
    table(
      doc,
      [
        { title: '№', w: 0.06, align: 'center' },
        { title: 'Услуга', w: 0.5 },
        { title: 'Занятий', w: 0.12, align: 'center' },
        { title: 'Цена', w: 0.16, align: 'right' },
        { title: 'Сумма', w: 0.16, align: 'right' },
      ],
      [
        [
          '1',
          `Занятия по курсу «${s.course.name}»${s.group ? `, группа «${s.group.name}»` : ''}, период ${d(lessons[0]?.lesson.startsAt)} — ${d(lessons[lessons.length - 1]?.lesson.startsAt)}`,
          String(lessons.length),
          money(lp),
          money(amount),
        ],
      ],
    );
    doc.font('B').text(`Итого: ${money(amount)}`, { align: 'right' }).font('R');
    doc.moveDown(0.5);
    para(doc, `Сумма прописью: ${amountInWords(amount)}. Услуги оказаны полностью и в срок. Заказчик претензий по объёму, качеству и срокам оказания услуг не имеет.`);
    twoColumns(doc, this.executor(c), { title: 'Заказчик', lines: cust.lines, sign: shortName(cust.name) });
    footer(doc, `Акт № ${row.number} · ${c.name}`);
    return finish(doc);
  }

  private async memberships(studentId: string, groupId?: string | null) {
    return this.prisma.groupStudent.findMany({
      where: { studentId, waitlist: false, ...(groupId ? { groupId } : {}) },
      include: { group: { include: { course: true } } },
      orderBy: { joinedAt: 'asc' },
    });
  }

  private async attendanceStats(studentId: string, groupId: string) {
    const marks = await this.prisma.attendance.findMany({ where: { studentId, lesson: { groupId } }, select: { status: true } });
    const attended = marks.filter((m) => m.status === 'present' || m.status === 'late').length;
    return { total: marks.length, attended, rate: marks.length ? Math.round((attended / marks.length) * 100) : null };
  }

  private async reference(row: IssuedRow, c: Company) {
    const student = await this.prisma.student.findUniqueOrThrow({ where: { id: row.studentId }, include: { branch: true } });
    const ms = await this.memberships(student.id, row.groupId);
    const doc = createDoc({ title: `Справка ${row.number}` });
    doc.font('B').fontSize(11).text(c.name, { align: 'center' });
    doc.font('R').fontSize(9).text([c.address, c.phone].filter(Boolean).join(' · '), { align: 'center' });
    title(doc, `СПРАВКА № ${row.number}`, `от ${dLong(row.createdAt)}`);
    para(
      doc,
      `Дана ${fio(student)}${student.birthDate ? `, ${d(student.birthDate)} г. р.,` : ''} в том, что он(а) ${ms.some((m) => !m.leftAt && m.group.status !== 'finished') ? 'обучается' : 'проходил(а) обучение'} в ${c.name} на курсах немецкого языка:`,
    );
    const rows: string[][] = [];
    for (const m of ms) {
      const st = await this.attendanceStats(student.id, m.groupId);
      rows.push([
        `${m.group.course.name} (${m.group.course.level})`,
        m.group.name,
        `${d(m.joinedAt)} — ${m.leftAt ? d(m.leftAt) : m.group.status === 'finished' ? d(m.group.endDate) : 'по н. в.'}`,
        String(m.group.course.academicHours),
        st.total ? `${st.attended} из ${st.total}` : '—',
      ]);
    }
    if (!rows.length) throw new BadRequestException('Студент не зачислен ни в одну группу');
    table(
      doc,
      [
        { title: 'Курс', w: 0.3 },
        { title: 'Группа', w: 0.22 },
        { title: 'Период', w: 0.24 },
        { title: 'Ак. часов', w: 0.1, align: 'center' },
        { title: 'Посещено', w: 0.14, align: 'center' },
      ],
      rows,
    );
    para(doc, 'Справка выдана для предъявления по месту требования.');
    doc.moveDown(2);
    doc.text(`${c.directorPosition} _________________ / ${shortName(c.director) || '__________'} /`);
    doc.moveDown(0.5).fontSize(8).fillColor('#666').text('М. П.').fillColor('#000');
    footer(doc, `Справка № ${row.number} · ${c.name}`);
    return finish(doc);
  }

  /** Сертификат об окончании уровня (альбомный лист). */
  private async certificate(row: IssuedRow, c: Company) {
    const student = await this.prisma.student.findUniqueOrThrow({ where: { id: row.studentId } });
    const [m] = await this.memberships(student.id, row.groupId);
    if (!m) throw new BadRequestException('Студент не учился в этой группе');
    const st = await this.attendanceStats(student.id, m.groupId);
    const grades = await this.prisma.grade.findMany({ where: { studentId: student.id, OR: [{ lesson: { groupId: m.groupId } }, { submissionId: { not: null } }] } });
    const skills: [string, string][] = [['hoeren', 'Hören'], ['lesen', 'Lesen'], ['schreiben', 'Schreiben'], ['sprechen', 'Sprechen']];
    const avg = skills
      .map(([k, n]) => {
        const xs = grades.filter((g) => g.skill === k).map(toPercent);
        return xs.length ? `${n}: ${Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)} %` : null;
      })
      .filter(Boolean);

    const doc = createDoc({ landscape: true, title: `Сертификат ${row.number}` });
    const W = doc.page.width;
    const H = doc.page.height;
    doc.lineWidth(3).rect(24, 24, W - 48, H - 48).stroke('#1d4ed8');
    doc.lineWidth(1).rect(32, 32, W - 64, H - 64).stroke('#ffce00');
    // Полоса цветов флага Германии.
    [['#111111', 0], ['#dd0000', 1], ['#ffce00', 2]].forEach(([color, i]) => doc.rect(W / 2 - 60 + (i as number) * 40, 50, 40, 8).fill(color as string));
    doc.fillColor('#000');
    doc.font('B').fontSize(13).text(c.name.toUpperCase(), 0, 74, { width: W, align: 'center' });
    doc.font('SB').fontSize(40).fillColor('#1d4ed8').text('СЕРТИФИКАТ', 0, 104, { width: W, align: 'center' });
    doc.font('R').fontSize(14).fillColor('#555').text('ZERTIFIKAT', 0, 152, { width: W, align: 'center' });
    doc.fillColor('#000').font('R').fontSize(13).text('настоящим удостоверяется, что', 0, 192, { width: W, align: 'center' });
    doc.font('B').fontSize(26).text(`${student.lastName} ${student.firstName}`, 0, 216, { width: W, align: 'center' });
    doc.font('R').fontSize(13).text(
      `успешно завершил(а) курс немецкого языка «${m.group.course.name}»\nуровень ${m.group.course.level} по шкале CEFR · ${m.group.course.academicHours} академических часов`,
      80,
      262,
      { width: W - 160, align: 'center', lineGap: 3 },
    );
    const period = `Период обучения: ${d(m.joinedAt)} — ${d(m.leftAt ?? m.group.endDate ?? new Date())}`;
    const results = [st.rate !== null ? `Посещаемость: ${st.rate} %` : null, ...avg].filter(Boolean).join(' · ');
    doc.fontSize(10.5).fillColor('#444').text(period, 0, 318, { width: W, align: 'center' });
    if (results) doc.text(results, 0, 336, { width: W, align: 'center' });
    doc.fillColor('#000').fontSize(10);
    const y = H - 130;
    doc.text(`${c.city ? `г. ${c.city}, ` : ''}${dLong(row.createdAt)}`, 70, y + 18, { width: 250 });
    doc.text('_______________________', W - 320, y, { width: 250, align: 'center' });
    doc.text(`${c.directorPosition}\n${c.director || ''}`, W - 320, y + 16, { width: 250, align: 'center' });
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor('#777').text(`№ ${row.number}`, 0, H - 58, { width: W, align: 'center', lineBreak: false });
    return finish(doc as Doc);
  }
}

// ───────────── Внешние экзамены ─────────────

@ApiTags('documents')
@ApiBearerAuth()
@Controller()
export class ExamsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get('students/:id/exams')
  @RequirePermissions('students.read')
  async list(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    if (!(await this.prisma.student.findFirst({ where: { id, ...branchScope(ctx) } }))) throw new NotFoundException('Студент не найден');
    return this.prisma.externalExam.findMany({ where: { studentId: id }, orderBy: { date: 'desc' } });
  }

  @Post('students/:id/exams')
  @RequirePermissions('students.update')
  async create(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: ExamDto) {
    if (!(await this.prisma.student.findFirst({ where: { id, ...branchScope(ctx) } }))) throw new NotFoundException('Студент не найден');
    const e = await this.prisma.externalExam.create({ data: { ...dto, studentId: id, date: new Date(dto.date) } });
    await this.audit.log({ userId: ctx.userId, entity: 'exam', entityId: e.id, action: 'create', after: e });
    return e;
  }

  @Patch('exams/:id')
  @RequirePermissions('students.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: ExamUpdateDto) {
    const before = await this.prisma.externalExam.findFirst({ where: { id, student: branchScope(ctx) } });
    if (!before) throw new NotFoundException('Экзамен не найден');
    const after = await this.prisma.externalExam.update({ where: { id }, data: { ...dto, date: dto.date ? new Date(dto.date) : undefined } });
    await this.audit.log({ userId: ctx.userId, entity: 'exam', entityId: id, action: 'update', before, after });
    return after;
  }

  @Delete('exams/:id')
  @RequirePermissions('students.update')
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const before = await this.prisma.externalExam.findFirst({ where: { id, student: branchScope(ctx) } });
    if (!before) throw new NotFoundException('Экзамен не найден');
    await this.prisma.externalExam.delete({ where: { id } });
    await this.audit.log({ userId: ctx.userId, entity: 'exam', entityId: id, action: 'delete', before });
    return { ok: true };
  }
}

export { PROVIDER_NAMES };

@Module({
  imports: [LearningModule],
  controllers: [CompanyController, DocumentsController, ExamsController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class DocumentsModule {}
