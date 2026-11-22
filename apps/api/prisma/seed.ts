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
 *   parent@crm.test     — родитель студента Руслана Бекмуратова
 *   asel@crm.test       — студентка Асель Жумабаева (кабинет студента: задания, тесты)
 *   Входной тест по общей ссылке: /test/demo-einstufung
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { DEFAULT_ROLES } from '../src/common/permissions';
import { FinanceService } from '../src/finance/finance.service';
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
  // Оплата преподавателей: Anna — опытная (50 %), Thomas — новый (30 %).
  await prisma.user.update({ where: { id: teacher.id }, data: { teacherCategory: 'experienced' } });
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

  // Прайс-лист.
  const tA1Level = await prisma.tariff.create({ data: { courseId: a1.id, name: 'A1.1 — весь уровень', type: 'level', lessons: 24, price: 9000 } });
  await prisma.tariff.create({ data: { courseId: a1.id, name: 'A1.1 — месяц (12 занятий)', type: 'month', lessons: 12, price: 4800 } });
  await prisma.tariff.create({ data: { courseId: a1.id, name: 'A1.1 — рассрочка на 3 платежа', type: 'installment', lessons: 24, price: 9600, installments: 3 } });
  const tB1Level = await prisma.tariff.create({ data: { courseId: b1.id, name: 'Goethe B1 — весь курс', type: 'level', lessons: 32, price: 14000 } });
  await prisma.tariff.create({ data: { courseId: b1.id, name: 'Goethe B1 — пакет 8 занятий', type: 'package', lessons: 8, price: 4000 } });

  // Студенты: абонемент на уровень и оплаты. Баланс считается сервисом: оплаты − стоимость абонементов.
  const students: [string, string, string, string, number, number?][] = [
    ['Асель', 'Жумабаева', 'A1', 'active', 9000],
    ['Руслан', 'Бекмуратов', 'A1', 'active', 4500],
    ['Канышай', 'Абдиева', 'A2', 'paused', 8100, 10],
    ['Евгений', 'Петров', 'B1', 'active', 16000],
    ['Нургуль', 'Исакова', 'B1', 'active', 5000],
    ['Самат', 'Турдубаев', 'A2', 'finished', 9000],
  ];
  const finance = new FinanceService(prisma as any);
  const studentIds: string[] = [];
  for (const [i, [firstName, lastName, level, status, paid, discount]] of students.entries()) {
    const isSouth = level === 'B1';
    const s = await prisma.student.create({
      data: {
        firstName,
        lastName,
        phone: '99670010' + String(i).padStart(4, '0'),
        currentLevel: level,
        targetLevel: 'B2',
        goal: ['exam', 'work', 'study', 'family'][i % 4],
        status,
        branchId: isSouth ? south.id : center.id,
        consentAt: new Date(),
      },
    });
    studentIds.push(s.id);
    const group = isSouth ? g2 : g1;
    await prisma.groupStudent.create({
      data: { groupId: group.id, studentId: s.id, joinedAt: isSouth ? undefined : new Date(g1Start) },
    });
    const tariff = isSouth ? tB1Level : tA1Level;
    const base = Number(tariff.price);
    const sub = await prisma.subscription.create({
      data: {
        studentId: s.id,
        branchId: s.branchId,
        courseId: group.courseId,
        groupId: group.id,
        tariffId: tariff.id,
        type: tariff.type,
        lessonsTotal: tariff.lessons,
        basePrice: base,
        discountPercent: discount ?? 0,
        discountType: discount ? 'family' : null,
        price: base * (1 - (discount ?? 0) / 100),
        startDate: isSouth ? new Date() : new Date(g1Start),
      },
    });
    await prisma.payment.create({
      data: { branchId: s.branchId, studentId: s.id, subscriptionId: sub.id, amount: paid, method: i % 2 ? 'cash' : 'qr', paidAt: isSouth ? new Date() : new Date(g1Start) },
    });
  }

  // Учебный план A1.1 (Menschen A1.1): 24 урока по 2 ак. часа.
  const plan = [
    ['Lektion 1', 'Hallo! Ich bin Nicole'], ['Lektion 1', 'Begrüßung, Alphabet'],
    ['Lektion 2', 'Ich bin Journalistin'], ['Lektion 2', 'Berufe, Zahlen bis 100'],
    ['Lektion 3', 'Das ist meine Mutter'], ['Lektion 3', 'Familie, Possessivartikel'],
    ['Lektion 4', 'Der Tisch ist schön!'], ['Lektion 4', 'Möbel, bestimmter Artikel'],
    ['Lektion 5', 'Was ist das? — Das ist ein F.'], ['Lektion 5', 'Gegenstände, unbestimmter Artikel'],
    ['Lektion 6', 'Ich brauche kein Büro'], ['Lektion 6', 'Negation kein/keine'],
    ['Modul-Plus 1', 'Wiederholung, Test 1'], ['Lektion 7', 'Du kannst wirklich toll …!'],
    ['Lektion 7', 'Modalverb können'], ['Lektion 8', 'Kein Problem. Ich habe Zeit!'],
    ['Lektion 8', 'Uhrzeit, Wochentage'], ['Lektion 9', 'Ich möchte was essen, Onkel Harry'],
    ['Lektion 9', 'Essen und Trinken, möchten'], ['Lektion 10', 'Ich steige jetzt in die U-Bahn ein'],
    ['Lektion 10', 'Trennbare Verben'], ['Lektion 11', 'Ich habe Zeit'], ['Lektion 12', 'Wiederholung'],
    ['Modul-Plus 2', 'Abschlusstest A1.1'],
  ];
  await prisma.courseTopic.createMany({
    data: plan.map(([chapter, title], i) => ({ courseId: a1.id, sort: i + 1, chapter, title })),
  });
  const topics = await prisma.courseTopic.findMany({ where: { courseId: a1.id }, orderBy: { sort: 'asc' } });

  // Родитель Руслана — получит уведомление о серии пропусков.
  const ruslan = await prisma.student.findFirstOrThrow({ where: { lastName: 'Бекмуратов' } });
  const parent = await mk('parent@crm.test', 'Гульмира', 'Бекмуратова', [{ roleId: role.parent, branchId: center.id }]);
  await prisma.parentStudent.create({ data: { parentId: parent.id, studentId: ruslan.id } });

  // Посещаемость и оценки за прошедшие занятия A1.1.
  const past = await prisma.lesson.findMany({
    where: { groupId: g1.id, endsAt: { lt: new Date() } },
    orderBy: { startsAt: 'asc' },
  });
  const members = await prisma.groupStudent.findMany({ where: { groupId: g1.id }, include: { student: true } });
  for (const [i, l] of past.entries()) {
    const last = i === past.length - 1;
    for (const m of members) {
      const ln = m.student.lastName;
      const status =
        ln === 'Бекмуратов' ? (last ? 'absent' : i === 2 ? 'late' : 'present')
        : ln === 'Абдиева' ? (i >= past.length - 3 ? 'excused' : 'present')
        : ln === 'Жумабаева' && i === 4 ? 'late'
        : 'present';
      await prisma.attendance.create({
        data: { lessonId: l.id, studentId: m.studentId, status, charged: status !== 'excused', markedById: teacher2.id, markedAt: l.endsAt },
      });
      if (i % 3 === 2 && status !== 'absent' && status !== 'excused') {
        const base = ln === 'Жумабаева' ? 88 : ln === 'Бекмуратов' ? 64 : 75;
        for (const skill of ['hoeren', 'sprechen']) {
          await prisma.grade.create({
            data: { lessonId: l.id, studentId: m.studentId, skill, value: base + ((i * 7) % 10) - (skill === 'sprechen' ? 6 : 0), createdById: teacher2.id },
          });
        }
      }
    }
    await prisma.lesson.update({ where: { id: l.id }, data: { status: 'done', courseTopicId: topics[i]?.id } });
  }

  // ───── Домашние задания и тесты ─────
  // Студентка Асель получает доступ в кабинет.
  const asel = await prisma.student.findFirstOrThrow({ where: { lastName: 'Жумабаева' } });
  const aselUser = await mk('asel@crm.test', 'Асель', 'Жумабаева', [{ roleId: role.student, branchId: center.id }]);
  // У Асель сегодня день рождения — для демонстрации поздравления.
  const bd = localDate(new Date(), tz);
  await prisma.student.update({ where: { id: asel.id }, data: { userId: aselUser.id, birthDate: new Date(`2001-${bd.slice(5)}T00:00:00Z`) } });
  // Чат группы A1.1 с приветствием преподавателя.
  const chat = await prisma.conversation.create({
    data: {
      type: 'group',
      groupId: g1.id,
      branchId: center.id,
      title: g1.name,
      members: { create: [{ userId: teacher2.id }, { userId: aselUser.id, lastReadAt: new Date(0) }] },
      messages: { create: { senderId: teacher2.id, text: 'Herzlich willkommen! Здесь можно задавать вопросы по урокам и ДЗ.' } },
    },
  });
  void chat;

  const day = 86_400_000;
  const hw1 = await prisma.homework.create({
    data: {
      groupId: g1.id,
      title: 'Lektion 5: Arbeitsbuch S. 34–35',
      description: 'Упражнения 1–4. Напишите 5 предложений с unbestimmter Artikel (ein/eine).',
      skill: 'schreiben',
      links: [{ url: 'https://learngerman.dw.com', title: 'DW: Nicos Weg A1' }],
      dueAt: new Date(Date.now() + 3 * day),
      createdById: teacher2.id,
    },
  });
  await prisma.homeworkSubmission.create({
    data: { homeworkId: hw1.id, studentId: asel.id, text: 'Das ist ein Tisch. Das ist eine Lampe. Das ist ein Buch. Das ist eine Tasche. Das ist ein Stuhl.' },
  });
  await prisma.homework.create({
    data: {
      groupId: g1.id,
      title: 'Sprechen: Meine Familie',
      description: 'Запишите аудио (1–2 минуты): расскажите о своей семье. Используйте mein/meine.',
      skill: 'sprechen',
      dueAt: new Date(Date.now() + 5 * day),
      createdById: teacher2.id,
    },
  });

  const quiz = await prisma.test.create({
    data: { title: 'Artikel-Test: Lektion 4', kind: 'quiz', level: 'A1', timeLimitMin: 10, isPublished: true, createdById: teacher2.id },
  });
  const qz: [string, string, unknown, number?][] = [
    ['article', 'Выберите артикль', { noun: 'Tisch', correct: 'der' }],
    ['article', 'Выберите артикль', { noun: 'Lampe', correct: 'die' }],
    ['article', 'Выберите артикль', { noun: 'Sofa', correct: 'das' }],
    ['choice', 'Wie heißt das auf Deutsch: «стул»?', { options: ['der Stuhl', 'die Stuhl', 'das Stuhl'], correct: [0] }],
    ['matching', 'Сопоставьте слова', { pairs: [{ left: 'der Schrank', right: 'шкаф' }, { left: 'das Bett', right: 'кровать' }, { left: 'die Uhr', right: 'часы' }] }, 3],
    ['text', 'Впишите артикль: ___ Teppich ist schön.', { answers: ['der', 'Der'] }],
  ];
  await prisma.testQuestion.createMany({
    data: qz.map(([type, prompt, data, points], i) => ({ testId: quiz.id, sort: i + 1, type, prompt, data: data as any, points: points ?? 1 })),
  });
  await prisma.homework.create({
    data: { groupId: g1.id, title: 'Тест: артикли (Lektion 4)', testId: quiz.id, skill: 'lesen', dueAt: new Date(Date.now() + 2 * day), createdById: teacher2.id },
  });

  // Входной тест уровня для лидов: вопросы A1–B2, уровень засчитывается при 60 %.
  const placement = await prisma.test.create({
    data: {
      title: 'Einstufungstest Deutsch',
      description: 'Бесплатный тест уровня немецкого: 12 вопросов, 15 минут. Результат придёт менеджеру центра.',
      kind: 'placement',
      timeLimitMin: 15,
      isPublished: true,
      publicToken: 'demo-einstufung',
      createdById: teacher.id,
    },
  });
  const pq: [string, string, string, unknown][] = [
    ['A1', 'choice', 'Ich ___ Anna.', { options: ['bin', 'bist', 'ist'], correct: [0] }],
    ['A1', 'article', 'Выберите артикль', { noun: 'Mutter', correct: 'die' }],
    ['A1', 'choice', 'Wie alt ___ du?', { options: ['bist', 'bin', 'sind'], correct: [0] }],
    ['A2', 'choice', 'Gestern ___ ich ins Kino gegangen.', { options: ['habe', 'bin', 'war'], correct: [1] }],
    ['A2', 'text', 'Ich fahre ___ dem Bus. (впишите предлог)', { answers: ['mit'] }],
    ['A2', 'choice', 'Das Wetter ist heute ___ als gestern.', { options: ['gut', 'besser', 'am besten'], correct: [1] }],
    ['B1', 'choice', 'Ich weiß nicht, ___ er morgen kommt.', { options: ['dass', 'ob', 'wenn'], correct: [1] }],
    ['B1', 'choice', 'Das ist der Mann, ___ ich geholfen habe.', { options: ['den', 'dem', 'der'], correct: [1] }],
    ['B1', 'text', 'Wenn ich Zeit ___, würde ich reisen. (haben, Konjunktiv II)', { answers: ['hätte'] }],
    ['B2', 'choice', 'Das Projekt ___ bis Freitag abgeschlossen sein.', { options: ['muss', 'müsste', 'soll'], correct: [0, 1] }],
    ['B2', 'choice', '___ der Verspätung erreichten wir den Zug.', { options: ['Trotz', 'Wegen', 'Während'], correct: [0] }],
    ['B2', 'text', 'Er tat so, als ___ er nichts gehört. (haben)', { answers: ['hätte'] }],
  ];
  await prisma.testQuestion.createMany({
    data: pq.map(([level, type, prompt, data], i) => ({ testId: placement.id, sort: i + 1, level, type, prompt, data: data as any })),
  });

  // Списание отмеченных занятий с абонементов и пересчёт балансов.
  for (const id of studentIds) {
    const gs = await prisma.groupStudent.findMany({ where: { studentId: id }, select: { groupId: true } });
    for (const g of gs) await finance.allocate(id, g.groupId);
    await finance.recalcBalance(id);
  }

  console.log('Демо-данные созданы.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
