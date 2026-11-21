/**
 * Демо-данные для разработки и показа: филиалы, роли, этапы воронки, сотрудники, лиды, студенты.
 * Запуск: npm run db:seed
 *
 * Тестовые учётные записи (пароль — DEMO_PASSWORD из .env, по умолчанию «Demo2026!crm»):
 *   owner@crm.test      — директор (все филиалы)
 *   admin@crm.test      — администратор филиала «Центр»
 *   manager@crm.test    — менеджер по продажам, филиал «Центр»
 *   manager2@crm.test   — менеджер по продажам, филиал «Юг»
 *   teacher@crm.test    — преподаватель + администратор филиала «Юг» (две роли)
 *   teacher2@crm.test   — преподаватель, филиал «Центр»
 *   accountant@crm.test — бухгалтер
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { DEFAULT_ROLES } from '../src/common/permissions';
import { generateSlots, localDate } from '../src/schedule/time';

const prisma = new PrismaClient();
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo2026!crm';

const STAGES = [
  { code: 'new', name: 'Новая заявка', color: '#3b82f6' },
  { code: 'contacted', name: 'Контакт установлен', color: '#06b6d4' },
  { code: 'level_test', name: 'Тест уровня', color: '#8b5cf6' },
  { code: 'trial', name: 'Пробный урок', color: '#f59e0b' },
  { code: 'contract', name: 'Договор', color: '#ec4899' },
  { code: 'payment', name: 'Оплата', color: '#14b8a6' },
  { code: 'enrolled', name: 'Зачислен в группу', color: '#22c55e', isWon: true },
  { code: 'lost', name: 'Отказ', color: '#ef4444', isLost: true },
];

async function main() {
  // Роли
  for (const r of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, permissions: r.permissions, isSystem: true },
      create: { ...r, isSystem: true },
    });
  }
  const role = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]));

  // Этапы воронки
  for (const [i, s] of STAGES.entries()) {
    await prisma.pipelineStage.upsert({
      where: { code: s.code },
      update: {},
      create: { ...s, sort: (i + 1) * 10 },
    });
  }
  const stage = Object.fromEntries((await prisma.pipelineStage.findMany()).map((s) => [s.code, s.id]));

  if (await prisma.branch.count()) {
    console.log('Филиалы уже есть — демо-данные не добавляются повторно.');
    return;
  }

  const center = await prisma.branch.create({
    data: { name: 'Бишкек — Центр', address: 'пр. Чуй, 120', phone: '+996555000001' },
  });
  const south = await prisma.branch.create({
    data: { name: 'Бишкек — Юг', address: 'ул. Ахунбаева, 45', phone: '+996555000002' },
  });
  for (const b of [center, south]) {
    await prisma.room.createMany({
      data: [
        { branchId: b.id, name: 'Berlin', capacity: 12 },
        { branchId: b.id, name: 'München', capacity: 8 },
        { branchId: b.id, name: 'Online', capacity: 20, isOnline: true },
      ],
    });
  }

  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = (email: string, firstName: string, lastName: string, roles: { roleId: string; branchId?: string }[]) =>
    prisma.user.create({
      data: { email, firstName, lastName, passwordHash: hash, roles: { create: roles } },
    });

  await mk('owner@crm.test', 'Азамат', 'Директоров', [{ roleId: role.owner }]);
  await mk('admin@crm.test', 'Айгуль', 'Администраторова', [{ roleId: role.branch_admin, branchId: center.id }]);
  const m1 = await mk('manager@crm.test', 'Бакыт', 'Продажин', [{ roleId: role.sales_manager, branchId: center.id }]);
  const m2 = await mk('manager2@crm.test', 'Нурлан', 'Южный', [{ roleId: role.sales_manager, branchId: south.id }]);
  const teacher = await mk('teacher@crm.test', 'Anna', 'Schmidt', [
    { roleId: role.teacher, branchId: south.id },
    { roleId: role.branch_admin, branchId: south.id },
  ]);
  const teacher2 = await mk('teacher2@crm.test', 'Thomas', 'Weber', [{ roleId: role.teacher, branchId: center.id }]);
  await mk('accountant@crm.test', 'Гульнара', 'Счётова', [{ roleId: role.accountant }]);

  // Лиды
  const leads: [string, string, string, string, string, string, string?][] = [
    ['Алина', 'Токтогулова', '996700111222', 'site', 'new', 'A1'],
    ['Эрлан', 'Касымов', '996555333444', 'instagram', 'contacted', 'A2'],
    ['Мария', 'Иванова', '996777555666', 'whatsapp', 'level_test', 'B1'],
    ['Тимур', 'Абдыкадыров', '996550777888', 'telegram', 'trial', 'A1'],
    ['Жылдыз', 'Маматова', '996705999000', 'site', 'contract', 'B1'],
    ['Дмитрий', 'Ким', '996555121212', 'referral', 'payment', 'A2'],
    ['Айпери', 'Садыкова', '996700343434', 'site', 'lost', 'A1', 'Дорого'],
    ['Бекзат', 'Осмонов', '996552565656', 'call', 'new', 'B2'],
  ];
  for (const [i, [firstName, lastName, phone, source, st, level, lostReason]] of leads.entries()) {
    const south_ = i % 3 === 2;
    const lead = await prisma.lead.create({
      data: {
        firstName,
        lastName,
        phone,
        source,
        stageId: stage[st],
        currentLevel: level,
        targetLevel: 'B1',
        goal: ['exam', 'work', 'study', 'family'][i % 4],
        branchId: south_ ? south.id : center.id,
        managerId: south_ ? m2.id : m1.id,
        lostReason,
        utmSource: source === 'site' ? 'google' : undefined,
        utmCampaign: source === 'site' ? 'autumn_a1' : undefined,
        activities: { create: { type: 'system', text: `Лид создан (источник: ${source})` } },
      },
    });
    if (st === 'new') {
      await prisma.task.create({
        data: {
          leadId: lead.id,
          assigneeId: lead.managerId!,
          title: 'Первое касание: связаться с клиентом',
          dueAt: new Date(Date.now() + 15 * 60_000),
        },
      });
    }
  }

  // Курсы, группы, студенты
  const a1 = await prisma.course.create({
    data: { name: 'Немецкий A1.1 (группа)', level: 'A1.1', format: 'group', academicHours: 48, textbook: 'Menschen A1.1', price: 9000 },
  });
  const b1 = await prisma.course.create({
    data: { name: 'Goethe B1 — подготовка', level: 'B1', format: 'mini_group', academicHours: 64, textbook: 'Mit Erfolg zu B1', price: 14000 },
  });
  const room = Object.fromEntries(
    (await prisma.room.findMany()).map((r) => [`${r.branchId === center.id ? 'c' : 's'}:${r.name}`, r.id]),
  );
  const tz = center.timezone;
  // Группа центра идёт уже 3 недели; занятия созданы по шаблону на весь курс (48 ч / 2 ч).
  const g1Start = localDate(new Date(Date.now() - 21 * 86_400_000), tz);
  const g1Rule = { days: [1, 3, 5], start: '19:00', end: '20:30' };
  const g1 = await prisma.group.create({
    data: {
      branchId: center.id,
      courseId: a1.id,
      teacherId: teacher2.id,
      roomId: room['c:Berlin'],
      name: 'A1.1 вечер пн/ср/пт',
      status: 'running',
      minStudents: 3,
      startDate: new Date(g1Start),
      scheduleRule: g1Rule,
    },
  });
  const g1Slots = generateSlots(g1Rule, g1Start, 24, tz);
  await prisma.lesson.createMany({
    data: g1Slots.map((s) => ({ groupId: g1.id, teacherId: teacher2.id, roomId: room['c:Berlin'], ...s })),
  });
  await prisma.group.update({ where: { id: g1.id }, data: { endDate: g1Slots[g1Slots.length - 1].endsAt } });

  // Группа юга в наборе: шаблон есть, занятия ещё не созданы.
  const g2 = await prisma.group.create({
    data: {
      branchId: south.id,
      courseId: b1.id,
      teacherId: teacher.id,
      roomId: room['s:München'],
      name: 'B1 Goethe вт/чт',
      status: 'recruiting',
      minStudents: 3,
      maxStudents: 6,
      startDate: new Date(localDate(new Date(Date.now() + 7 * 86_400_000), tz)),
      scheduleRule: { days: [2, 4], start: '18:30', end: '20:00' },
    },
  });

  const students: [string, string, string, string, number][] = [
    ['Асель', 'Жумабаева', 'A1', 'active', 0],
    ['Руслан', 'Бекмуратов', 'A1', 'active', -4500],
    ['Канышай', 'Абдиева', 'A2', 'paused', 0],
    ['Евгений', 'Петров', 'B1', 'active', 2000],
    ['Нургуль', 'Исакова', 'B1', 'active', -9000],
    ['Самат', 'Турдубаев', 'A2', 'finished', 0],
  ];
  for (const [i, [firstName, lastName, level, status, balance]] of students.entries()) {
    const isSouth = level === 'B1';
    const s = await prisma.student.create({
      data: {
        firstName,
        lastName,
        phone: `99670010${String(i).padStart(4, '0')}`,
        currentLevel: level,
        targetLevel: 'B2',
        goal: ['exam', 'work', 'study', 'family'][i % 4],
        status,
        balance,
        branchId: isSouth ? south.id : center.id,
        consentAt: new Date(),
      },
    });
    await prisma.groupStudent.create({ data: { groupId: isSouth ? g2.id : g1.id, studentId: s.id } });
    if (balance >= 0 && status === 'active') {
      await prisma.payment.create({
        data: { branchId: s.branchId, studentId: s.id, amount: isSouth ? 14000 : 9000, method: i % 2 ? 'cash' : 'qr' },
      });
    }
  }

  console.log('Демо-данные созданы.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
