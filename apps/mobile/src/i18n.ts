/** Языки приложения (ТЗ 4): русский и кыргызский; немецкий и английский — по русскому, пока нет перевода. */
import { createContext, useContext } from 'react';

const ru = {
  appName: 'Deutschzentrum',
  login: 'Логин',
  loginHint: 'E-mail или телефон',
  password: 'Пароль',
  signIn: 'Войти',
  logout: 'Выйти',
  home: 'Главная',
  schedule: 'Расписание',
  progress: 'Успехи',
  homework: 'ДЗ',
  inbox: 'Сообщения',
  profile: 'Профиль',
  lessons: 'Занятия',
  balance: 'Баланс',
  debt: 'Долг',
  pay: 'Оплатить',
  paid: 'Оплачено',
  subscriptions: 'Абонементы',
  lessonsLeft: 'осталось занятий',
  noSubscriptions: 'Нет активных абонементов',
  upcoming: 'Ближайшие занятия',
  noLessons: 'Занятий нет',
  join: 'Войти в урок',
  linkSoon: 'Ссылка появится за час до начала',
  online: 'онлайн',
  attendance: 'Посещаемость',
  grades: 'Оценки',
  noData: 'Пока нет данных',
  'st.present': 'Был',
  'st.late': 'Опоздал',
  'st.excused': 'Уваж.',
  'st.absent': 'Не был',
  'sk.hoeren': 'Hören',
  'sk.lesen': 'Lesen',
  'sk.schreiben': 'Schreiben',
  'sk.sprechen': 'Sprechen',
  'sk.overall': 'Итог',
  due: 'Срок',
  submitted: 'Сдано',
  checked: 'Проверено',
  toDo: 'Не сдано',
  answer: 'Ответ',
  send: 'Отправить',
  testInWeb: 'Тест проходится в веб-кабинете',
  today: 'Сегодня',
  week: 'Неделя',
  markAll: 'Все пришли',
  save: 'Сохранить',
  saved: 'Сохранено',
  savedOffline: 'Нет связи — отметка сохранена на телефоне и уйдёт автоматически',
  pendingSync: 'Ожидают отправки',
  syncNow: 'Отправить сейчас',
  syncFailed: 'Не удалось отправить',
  notStarted: 'Отмечать можно с начала занятия',
  cancelled: 'Отменено',
  topic: 'Тема урока',
  back: 'Назад',
  role: 'Роль',
  language: 'Язык',
  push: 'Push-уведомления',
  pushOn: 'включены',
  'push.web': 'недоступны в веб-версии',
  'push.emulator': 'недоступны на эмуляторе',
  'push.denied': 'запрещены в настройках телефона',
  'push.no-project': 'нужна сборка приложения (EAS)',
  staffUseWeb: 'Для этой роли откройте веб-версию CRM. В приложении — расписание и сообщения.',
  retry: 'Повторить',
  loading: 'Загрузка…',
  markRead: 'Прочитать все',
  offline: 'Нет связи',
  child: 'Ребёнок',
  allTasks: 'Все',
  overdue: 'Просрочено',
  returned: 'На доработку',
  resubmit: 'Пересдать',
  resubmitHint: 'Новая сдача заменит прежние файлы ответа.',
  answerText: 'Ответ текстом',
  grade: 'Оценка',
  camera: 'Камера',
  photo: 'Фото',
  file: 'Файл',
  uploading: 'Загрузка файла…',
  remove: 'Убрать',
  recordVoice: 'Записать голос',
  stop: 'Стоп',
  voiceAnswer: 'Голосовой ответ',
  noCameraAccess: 'Нет доступа к камере — разрешите его в настройках телефона',
  noMicAccess: 'Нет доступа к микрофону — разрешите его в настройках телефона',
  play: 'Слушать',
  pause: 'Пауза',
  min: 'мин',
  startTest: 'Начать тест',
  finishTest: 'Завершить тест',
  questions: 'Вопросов',
  question: 'Вопрос',
  answered: 'отвечено',
  timeLimit: 'время',
  testRules: 'Одна попытка. После начала идёт таймер; по его окончании ответы отправятся автоматически.',
  prev: 'Назад',
  next: 'Далее',
  score: 'Баллы',
  timedOut: 'Время вышло — засчитаны данные ответы',
  severalAnswers: 'Можно выбрать несколько вариантов',
  yourAnswer: 'Ваш ответ',
};
export type TKey = keyof typeof ru;
type Dict = Partial<Record<TKey, string>>;

const ky: Dict = {
  login: 'Логин',
  loginHint: 'E-mail же телефон',
  password: 'Сырсөз',
  signIn: 'Кирүү',
  logout: 'Чыгуу',
  home: 'Башкы',
  schedule: 'Жадыбал',
  progress: 'Жетишкендик',
  homework: 'Үй тапшырма',
  inbox: 'Билдирүүлөр',
  profile: 'Профиль',
  lessons: 'Сабактар',
  balance: 'Баланс',
  debt: 'Карыз',
  pay: 'Төлөө',
  subscriptions: 'Абонементтер',
  lessonsLeft: 'сабак калды',
  upcoming: 'Жакынкы сабактар',
  noLessons: 'Сабак жок',
  join: 'Сабакка кирүү',
  linkSoon: 'Шилтеме башталардан бир саат мурун пайда болот',
  attendance: 'Катышуу',
  grades: 'Баалар',
  noData: 'Азырынча маалымат жок',
  'st.present': 'Келди',
  'st.late': 'Кечикти',
  'st.excused': 'Себептүү',
  'st.absent': 'Келген жок',
  send: 'Жөнөтүү',
  today: 'Бүгүн',
  week: 'Жума',
  markAll: 'Баары келди',
  save: 'Сактоо',
  saved: 'Сакталды',
  savedOffline: 'Байланыш жок — белги телефондо сакталды, кийин автоматтык түрдө жөнөтүлөт',
  pendingSync: 'Жөнөтүүнү күтүүдө',
  language: 'Тил',
  retry: 'Кайталоо',
  loading: 'Жүктөлүүдө…',
  offline: 'Байланыш жок',
  allTasks: 'Баары',
  overdue: 'Мөөнөтү өттү',
  camera: 'Камера',
  photo: 'Сүрөт',
  file: 'Файл',
  recordVoice: 'Үн жазуу',
  stop: 'Токтотуу',
  play: 'Угуу',
  startTest: 'Тестти баштоо',
  finishTest: 'Тестти бүтүрүү',
  question: 'Суроо',
  next: 'Кийинки',
  prev: 'Артка',
  yourAnswer: 'Сиздин жооп',
};

export const LOCALES = { ru: 'Рус', ky: 'Кыр' } as const;
export type Locale = keyof typeof LOCALES;
const dicts: Record<Locale, Dict> = { ru, ky };

export function translate(locale: string, k: TKey | string) {
  const d = dicts[(locale in dicts ? locale : 'ru') as Locale];
  return (d as Record<string, string>)[k] ?? (ru as Record<string, string>)[k] ?? k;
}

export interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (k: TKey | string) => string;
}
export const I18nCtx = createContext<I18n>({ locale: 'ru', setLocale: () => {}, t: (k) => translate('ru', k) });
export const useI18n = () => useContext(I18nCtx);

const MONTHS: Record<Locale, string[]> = {
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  ky: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
};
const DAYS: Record<Locale, string[]> = {
  ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  ky: ['жш', 'дш', 'шш', 'шр', 'бш', 'жм', 'иш'],
};
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Расписание показывается во времени центра (как в веб-версии), а не в поясе телефона:
 * клиент в поездке видит то же время, что и в расписании центра.
 */
const CENTER_TZ = 'Asia/Bishkek';
let parts: ((d: Date) => { y: number; m: number; d: number; h: number; min: number; wd: number }) | null = null;
function zoned(d: Date) {
  if (!parts) {
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: CENTER_TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
      const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      parts = (x) => {
        const p = Object.fromEntries(f.formatToParts(x).map((q) => [q.type, q.value]));
        return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour % 24, min: +p.minute, wd: WD.indexOf(p.weekday) };
      };
      parts(new Date());
    } catch {
      // Нет поддержки часовых поясов в Intl — время телефона.
      parts = (x) => ({ y: x.getFullYear(), m: x.getMonth(), d: x.getDate(), h: x.getHours(), min: x.getMinutes(), wd: x.getDay() });
    }
  }
  return parts(d);
}

export function fmtDay(iso: string, locale: Locale) {
  const z = zoned(new Date(iso));
  return `${DAYS[locale][z.wd]}, ${z.d} ${MONTHS[locale][z.m]}`;
}
export const fmtTime = (iso: string) => {
  const z = zoned(new Date(iso));
  return `${pad(z.h)}:${pad(z.min)}`;
};

/** Начало «сегодня» по времени центра (для списка занятий преподавателя). */
export function centerDayStart(now = new Date()) {
  const z = zoned(now);
  const guess = Date.UTC(z.y, z.m, z.d);
  const offset = Date.UTC(z.y, z.m, z.d, z.h, z.min) - Math.floor(+now / 60000) * 60000;
  return new Date(guess - offset);
}
export const fmtMoney = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ')} сом`;
