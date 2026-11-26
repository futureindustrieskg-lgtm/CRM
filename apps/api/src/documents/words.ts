/** Сумма прописью для счетов и договоров: «Девять тысяч сомов 00 тыйынов». */

const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** Форма слова по числу: 1 сом, 2 сома, 5 сомов. */
export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function triple(n: number, feminine: boolean): string[] {
  const out: string[] = [];
  out.push(HUNDREDS[Math.floor(n / 100)]);
  const r = n % 100;
  if (r >= 10 && r < 20) out.push(TEENS[r - 10]);
  else {
    out.push(TENS[Math.floor(r / 10)]);
    out.push((feminine ? ONES_F : ONES_M)[r % 10]);
  }
  return out.filter(Boolean);
}

/** Целое число прописью (мужской род). */
export function numberToWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'ноль';
  const groups: [number, boolean, [string, string, string] | null][] = [
    [Math.floor(n / 1e9) % 1000, false, ['миллиард', 'миллиарда', 'миллиардов']],
    [Math.floor(n / 1e6) % 1000, false, ['миллион', 'миллиона', 'миллионов']],
    [Math.floor(n / 1e3) % 1000, true, ['тысяча', 'тысячи', 'тысяч']],
    [n % 1000, false, null],
  ];
  const words: string[] = [];
  for (const [g, fem, forms] of groups) {
    if (!g) continue;
    words.push(...triple(g, fem));
    if (forms) words.push(plural(g, ...forms));
  }
  return words.join(' ');
}

export function amountInWords(amount: number) {
  const som = Math.floor(Math.abs(amount));
  const tyiyn = Math.round((Math.abs(amount) - som) * 100);
  const text = `${numberToWords(som)} ${plural(som, 'сом', 'сома', 'сомов')} ${String(tyiyn).padStart(2, '0')} ${plural(tyiyn, 'тыйын', 'тыйына', 'тыйынов')}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
