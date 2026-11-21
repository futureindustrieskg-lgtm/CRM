/**
 * Часовой пояс центра. Расписание показывается и вводится в местном времени филиала
 * (Branch.timezone), а не в поясе компьютера пользователя.
 */
let TZ = 'Asia/Bishkek';

export function setTimezone(tz: string | undefined | null) {
  if (tz) TZ = tz;
}
export const timezone = () => TZ;

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(): Intl.DateTimeFormat {
  let f = cache.get(TZ);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    cache.set(TZ, f);
  }
  return f;
}

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Составные части момента в поясе центра. */
export function zparts(d: Date | string) {
  const p = Object.fromEntries(fmt().formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    wd: WD[p.weekday],
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" в поясе центра. */
export const zDate = (d: Date | string) => {
  const p = zparts(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};
/** "HH:MM" в поясе центра. */
export const zTime = (d: Date | string) => {
  const p = zparts(d);
  return `${pad(p.h)}:${pad(p.min)}`;
};

/** Местные дата и время центра → момент (UTC). */
export function zonedToUtc(date: string, time = '00:00'): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (ts: number) => {
    const p = zparts(new Date(ts));
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ts / 60_000) * 60_000;
  };
  let ts = naive - offset(naive);
  ts = naive - offset(ts);
  return new Date(ts);
}

// Календарная арифметика над строками "YYYY-MM-DD" (без часовых поясов).
const asUtc = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const addDays = (s: string, n: number) => {
  const d = asUtc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const weekday = (s: string) => ((asUtc(s).getUTCDay() + 6) % 7) + 1;
export const mondayOf = (s: string) => addDays(s, 1 - weekday(s));
export const dayOfMonth = (s: string) => Number(s.slice(8, 10));
export const monthOf = (s: string) => s.slice(0, 7);
export const addMonths = (s: string, n: number) => {
  const d = asUtc(`${s.slice(0, 7)}-01`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
/** Подпись даты на языке интерфейса (дата без времени, без сдвига пояса). */
export const labelDate = (s: string, locale: string, opts: Intl.DateTimeFormatOptions) =>
  asUtc(s).toLocaleDateString(locale, { ...opts, timeZone: 'UTC' });
