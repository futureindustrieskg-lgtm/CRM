/**
 * Типы автоматических сообщений (ТЗ 3.8) и шаблоны по умолчанию на русском и кыргызском.
 * Поля подстановки: {{name}} — имя получателя, {{student}} — имя студента (для родителя),
 * {{date}}, {{time}}, {{group}}, {{amount}}, {{balance}}, {{title}}, {{grade}}, {{reason}}, {{center}}.
 * Шаблоны редактируются в интерфейсе; эти тексты используются, пока их не изменили.
 */
import type { Channel } from './channels';

export interface TypeRule {
  enabled: boolean;
  /** Порядок каналов: берётся первый доступный, для которого у получателя есть адрес. */
  channels: Channel[];
  /** Дублировать родителям студента. */
  parents: boolean;
}

export const NOTIFICATION_TYPES: Record<string, { name: string; rule: TypeRule; vars: string[] }> = {
  lesson_reminder: { name: 'Напоминание о занятии', rule: { enabled: true, channels: ['push', 'telegram', 'whatsapp', 'sms'], parents: false }, vars: ['name', 'group', 'date', 'time', 'link'] },
  lesson_changed: { name: 'Перенос или отмена занятия', rule: { enabled: true, channels: ['push', 'whatsapp', 'sms'], parents: true }, vars: ['name', 'student', 'group', 'date', 'time', 'reason'] },
  homework_new: { name: 'Новое домашнее задание', rule: { enabled: true, channels: ['push', 'telegram'], parents: false }, vars: ['name', 'title', 'group', 'date'] },
  homework_checked: { name: 'ДЗ проверено / на доработке', rule: { enabled: true, channels: ['push', 'telegram'], parents: false }, vars: ['name', 'title', 'grade', 'reason'] },
  grade: { name: 'Оценки за занятие', rule: { enabled: true, channels: ['push'], parents: true }, vars: ['name', 'student', 'group', 'date', 'grade'] },
  payment_received: { name: 'Оплата получена', rule: { enabled: true, channels: ['push', 'whatsapp', 'sms', 'email'], parents: true }, vars: ['name', 'student', 'amount', 'balance'] },
  debt_reminder: { name: 'Напоминание о задолженности', rule: { enabled: true, channels: ['whatsapp', 'sms', 'push'], parents: true }, vars: ['name', 'student', 'amount'] },
  subscription_ending: { name: 'Абонемент заканчивается', rule: { enabled: true, channels: ['push', 'whatsapp'], parents: true }, vars: ['name', 'student', 'group', 'remaining'] },
  absence_streak: { name: 'Пропуски подряд (родителям)', rule: { enabled: true, channels: ['push', 'whatsapp', 'sms'], parents: true }, vars: ['name', 'student', 'group', 'count'] },
  birthday: { name: 'День рождения', rule: { enabled: true, channels: ['whatsapp', 'push', 'sms'], parents: false }, vars: ['name', 'center'] },
  broadcast: { name: 'Рассылка', rule: { enabled: true, channels: ['push', 'telegram', 'whatsapp', 'sms', 'email'], parents: false }, vars: ['name', 'student', 'center'] },
};

type Tpl = { title: string; body: string };

export const DEFAULT_TEMPLATES: Record<string, { ru: Tpl; ky: Tpl }> = {
  lesson_reminder: {
    ru: { title: 'Скоро занятие', body: '{{name}}, напоминаем: занятие группы «{{group}}» сегодня в {{time}}. {{link}}' },
    ky: { title: 'Жакында сабак', body: '{{name}}, эскертебиз: «{{group}}» тобунун сабагы бүгүн саат {{time}}да. {{link}}' },
  },
  lesson_changed: {
    ru: { title: 'Изменение в расписании', body: '{{name}}, занятие группы «{{group}}»: {{reason}}. Новое время: {{date}} {{time}}.' },
    ky: { title: 'Сабак тартибиндеги өзгөрүү', body: '{{name}}, «{{group}}» тобунун сабагы: {{reason}}. Жаңы убакыт: {{date}} {{time}}.' },
  },
  homework_new: {
    ru: { title: 'Новое домашнее задание', body: '{{name}}, новое задание «{{title}}» ({{group}}). Срок: {{date}}.' },
    ky: { title: 'Жаңы үй тапшырмасы', body: '{{name}}, жаңы тапшырма «{{title}}» ({{group}}). Мөөнөтү: {{date}}.' },
  },
  homework_checked: {
    ru: { title: 'Задание проверено', body: '{{name}}, задание «{{title}}»: {{reason}} {{grade}}' },
    ky: { title: 'Тапшырма текшерилди', body: '{{name}}, «{{title}}» тапшырмасы: {{reason}} {{grade}}' },
  },
  grade: {
    ru: { title: 'Новые оценки', body: '{{student}}, {{group}}, {{date}}: {{grade}}' },
    ky: { title: 'Жаңы баалар', body: '{{student}}, {{group}}, {{date}}: {{grade}}' },
  },
  payment_received: {
    ru: { title: 'Оплата получена', body: '{{name}}, получили оплату {{amount}} за обучение ({{student}}). Баланс: {{balance}}. Спасибо!' },
    ky: { title: 'Төлөм алынды', body: '{{name}}, окуу үчүн {{amount}} төлөм алынды ({{student}}). Баланс: {{balance}}. Рахмат!' },
  },
  debt_reminder: {
    ru: { title: 'Задолженность за обучение', body: '{{name}}, по обучению ({{student}}) задолженность {{amount}}. Оплатить можно в филиале или по QR.' },
    ky: { title: 'Окуу үчүн карыз', body: '{{name}}, окуу боюнча ({{student}}) {{amount}} карыз бар. Филиалда же QR аркылуу төлөсөңүз болот.' },
  },
  subscription_ending: {
    ru: { title: 'Абонемент заканчивается', body: '{{name}}, по абонементу ({{student}}, {{group}}) осталось занятий: {{remaining}}. Продлите, чтобы не прерывать обучение.' },
    ky: { title: 'Абонемент бүтүп жатат', body: '{{name}}, абонемент боюнча ({{student}}, {{group}}) калган сабактар: {{remaining}}. Окууну үзбөө үчүн узартыңыз.' },
  },
  absence_streak: {
    ru: { title: 'Пропуски занятий', body: '{{name}}, {{student}} пропустил(а) {{count}} занятия подряд в группе «{{group}}». Пожалуйста, свяжитесь с центром.' },
    ky: { title: 'Сабактарды калтыруу', body: '{{name}}, {{student}} «{{group}}» тобунда катары менен {{count}} сабакты калтырды. Борбор менен байланышыңыз.' },
  },
  birthday: {
    ru: { title: 'С днём рождения!', body: '{{name}}, команда {{center}} поздравляет вас с днём рождения! Alles Gute zum Geburtstag! 🎉' },
    ky: { title: 'Туулган күнүңүз менен!', body: '{{name}}, {{center}} командасы сизди туулган күнүңүз менен куттуктайт! Alles Gute zum Geburtstag! 🎉' },
  },
  broadcast: {
    ru: { title: '{{title}}', body: '{{body}}' },
    ky: { title: '{{title}}', body: '{{body}}' },
  },
};

/** Подстановка полей; неизвестные поля заменяются пустой строкой. */
export function render(tpl: string, vars: Record<string, unknown>) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k]))).replace(/[ \t]+$/gm, '').trim();
}
