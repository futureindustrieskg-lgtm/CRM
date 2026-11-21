/**
 * Каталог прав (ТЗ 2). Право = "<модуль>.<действие>".
 * Роли и их права хранятся в БД и редактируются из интерфейса; этот каталог
 * лишь перечисляет, какие права вообще существуют.
 */
export const ACTIONS = ['read', 'create', 'update', 'delete', 'export'] as const;

export const MODULES = [
  { code: 'leads', name: 'Лиды и продажи' },
  { code: 'students', name: 'Клиенты и студенты' },
  { code: 'schedule', name: 'Расписание' },
  { code: 'groups', name: 'Группы и курсы' },
  { code: 'attendance', name: 'Посещаемость и успеваемость' },
  { code: 'homework', name: 'Домашние задания и тесты' },
  { code: 'finance', name: 'Финансы' },
  { code: 'messages', name: 'Коммуникации' },
  { code: 'documents', name: 'Документы и сертификаты' },
  { code: 'reports', name: 'Отчёты' },
  { code: 'users', name: 'Сотрудники и пользователи' },
  { code: 'roles', name: 'Роли и права' },
  { code: 'branches', name: 'Филиалы' },
  { code: 'audit', name: 'Журнал действий' },
] as const;

/** Специальные права сверх CRUD. */
export const SPECIAL_PERMISSIONS = [
  { code: 'leads.read_all', name: 'Видеть лиды всего отдела (не только свои)' },
  { code: 'finance.delete_records', name: 'Удаление финансовых записей' },
  { code: 'finance.salaries', name: 'Доступ к зарплатам' },
  { code: 'students.contacts', name: 'Видеть контакты студентов' },
  { code: 'schedule.read_all', name: 'Видеть всё расписание и все группы (не только свои)' },
] as const;

export const ALL = '*';

export function allPermissionCodes(): string[] {
  const crud = MODULES.flatMap((m) => ACTIONS.map((a) => `${m.code}.${a}`));
  return [...crud, ...SPECIAL_PERMISSIONS.map((p) => p.code)];
}

const crud = (module: string, actions: readonly string[] = ACTIONS) =>
  actions.map((a) => `${module}.${a}`);

/** Системные роли по умолчанию (ТЗ 2). */
export const DEFAULT_ROLES: {
  code: string;
  name: string;
  permissions: string[];
}[] = [
  { code: 'owner', name: 'Владелец / директор', permissions: [ALL] },
  {
    code: 'branch_admin',
    name: 'Администратор филиала',
    permissions: [
      ...crud('leads'),
      'leads.read_all',
      ...crud('students'),
      'students.contacts',
      ...crud('schedule'),
      'schedule.read_all',
      ...crud('groups'),
      ...crud('attendance'),
      ...crud('finance', ['read', 'create', 'update', 'export']),
      ...crud('documents'),
      ...crud('messages'),
      ...crud('users', ['read', 'create', 'update']),
      'branches.read',
      'reports.read',
      'audit.read',
    ],
  },
  {
    code: 'sales_manager',
    name: 'Менеджер по продажам',
    permissions: [
      ...crud('leads', ['read', 'create', 'update', 'export']),
      ...crud('students', ['read', 'create', 'update']),
      'students.contacts',
      'schedule.read',
      'schedule.read_all',
      'groups.read',
      'finance.read',
      'finance.create',
      'messages.read',
      'messages.create',
      'branches.read',
    ],
  },
  {
    code: 'accountant',
    name: 'Бухгалтер',
    permissions: [
      ...crud('finance'),
      'finance.delete_records',
      'finance.salaries',
      'students.read',
      'documents.read',
      'documents.create',
      'reports.read',
      'reports.export',
      'branches.read',
    ],
  },
  {
    code: 'teacher',
    name: 'Преподаватель',
    permissions: [
      'schedule.read',
      'groups.read',
      'students.read',
      ...crud('attendance', ['read', 'create', 'update']),
      ...crud('homework'),
      'messages.read',
      'messages.create',
    ],
  },
  { code: 'student', name: 'Студент', permissions: ['schedule.read', 'homework.read', 'messages.read', 'messages.create'] },
  { code: 'parent', name: 'Родитель', permissions: ['schedule.read', 'messages.read', 'messages.create'] },
];

export function hasPermission(granted: string[], required: string): boolean {
  return granted.includes(ALL) || granted.includes(required);
}
