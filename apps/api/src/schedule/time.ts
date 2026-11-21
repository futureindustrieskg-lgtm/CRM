/**
 * Работа со временем расписания. Шаблон группы задаётся в местном времени филиала
 * (Branch.timezone), уроки хранятся в UTC.
 */

/** Часовой пояс центра по умолчанию — для отчётов «за месяц» и «за сегодня». */
export const CENTER_TZ = 'Asia/Bishkek';

/** Академический час, минут. */
export const ACADEMIC_HOUR_MIN = 45;

export interface ScheduleRule {
  /** Дни недели ISO: 1 — понедельник … 7 — воскресенье. */
  days: number[];
  /** Начало и конец занятия в местном времени, "HH:MM". */
  start: string;
  end: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateRule(rule: unknown): string | null {
  const r = rule as ScheduleRule;
  if (!r || !Array.isArray(r.days) || !r.days.length) return 'Укажите дни недели';
  if (r.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return 'Дни недели — числа от 1 до 7';
  if (!TIME_RE.test(r.start) || !TIME_RE.test(r.end)) return 'Время в формате ЧЧ:ММ';
  if (r.start >= r.end) return 'Конец занятия должен быть позже начала';
  return null;
}

/** Смещение часового пояса tz относительно UTC в минутах для момента ts. */
function tzOffset(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - ts) / 60_000);
}

/** Местные дата "YYYY-MM-DD" и время "HH:MM" в часовом поясе tz → момент UTC. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let ts = naive - tzOffset(naive, tz) * 60_000;
  // Повторная поправка на случай перехода на летнее время между naive и ts.
  ts = naive - tzOffset(ts, tz) * 60_000;
  return new Date(ts);
}

/** Местная календарная дата "YYYY-MM-DD" момента ts в поясе tz. */
export function localDate(ts: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

function minutes(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Сколько академических часов в одном занятии по шаблону (90 мин → 2). */
export function hoursPerLesson(rule: ScheduleRule): number {
  return Math.max(1, Math.round((minutes(rule.end) - minutes(rule.start)) / ACADEMIC_HOUR_MIN));
}

/**
 * Даты занятий по шаблону, начиная с fromDate (включительно), count штук.
 * skipDates — праздники и выходные дни центра.
 */
export function generateSlots(
  rule: ScheduleRule,
  fromDate: string,
  count: number,
  tz: string,
  skipDates: string[] = [],
): { startsAt: Date; endsAt: Date }[] {
  const skip = new Set(skipDates);
  const out: { startsAt: Date; endsAt: Date }[] = [];
  let date = fromDate;
  // Ограничитель на случай пустого шаблона: не дальше 3 лет.
  for (let i = 0; out.length < count && i < 366 * 3; i++, date = addDays(date, 1)) {
    if (!rule.days.includes(isoWeekday(date)) || skip.has(date)) continue;
    out.push({ startsAt: zonedToUtc(date, rule.start, tz), endsAt: zonedToUtc(date, rule.end, tz) });
  }
  return out;
}
