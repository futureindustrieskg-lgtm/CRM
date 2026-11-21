/**
 * Типы вопросов теста (ТЗ 3.6) и автопроверка.
 *
 * choice   — выбор ответа:      data { options: string[], correct: number[] }  ответ: number[]
 * article  — артикль der/die/das: data { noun: string, correct: 'der'|'die'|'das' } ответ: string
 * matching — сопоставление:      data { pairs: { left, right }[] }              ответ: number[] — для каждой
 *            левой части индекс правой части в перемешанном списке, который получил участник
 * text     — вписать слово:      data { answers: string[] }                     ответ: string
 * Аудирование — любой вопрос с прикреплённым аудиофайлом.
 */
import { createHash } from 'crypto';

export const QUESTION_TYPES = ['choice', 'article', 'matching', 'text'] as const;
export const ARTICLES = ['der', 'die', 'das'];
export const PLACEMENT_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
/** Уровень входного теста засчитывается, если по его вопросам набрано не меньше 60 %. */
export const PLACEMENT_PASS = 0.6;

type Q = { id: string; type: string; points: number; data: any; level?: string | null };

export function validateQuestion(q: { type: string; data: any; prompt?: string }): string | null {
  const d = q.data ?? {};
  if (!q.prompt?.trim() && q.type !== 'article') return 'Укажите текст вопроса';
  switch (q.type) {
    case 'choice':
      if (!Array.isArray(d.options) || d.options.length < 2 || d.options.some((o: unknown) => typeof o !== 'string' || !o.trim())) {
        return 'Нужно минимум 2 варианта ответа';
      }
      if (!Array.isArray(d.correct) || !d.correct.length || d.correct.some((i: number) => !Number.isInteger(i) || i < 0 || i >= d.options.length)) {
        return 'Отметьте правильный вариант';
      }
      return null;
    case 'article':
      if (typeof d.noun !== 'string' || !d.noun.trim()) return 'Укажите существительное';
      return ARTICLES.includes(d.correct) ? null : 'Правильный артикль: der, die или das';
    case 'matching':
      if (!Array.isArray(d.pairs) || d.pairs.length < 2 || d.pairs.some((p: any) => !p?.left?.trim() || !p?.right?.trim())) {
        return 'Нужно минимум 2 пары';
      }
      return null;
    case 'text':
      if (!Array.isArray(d.answers) || !d.answers.some((a: unknown) => typeof a === 'string' && a.trim())) return 'Укажите правильный ответ';
      return null;
    default:
      return 'Неизвестный тип вопроса';
  }
}

/** Детерминированное перемешивание (одно и то же для одной попытки). */
export function shuffled<T>(items: T[], seed: string): { item: T; index: number }[] {
  return items
    .map((item, index) => ({ item, index, k: createHash('sha256').update(`${seed}:${index}`).digest('hex') }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .map(({ item, index }) => ({ item, index }));
}

/** Вопрос без правильных ответов — для участника. */
export function forTaker(q: Q & { prompt: string; files?: { id: string; name: string; mime: string }[] }, seed: string) {
  const base = { id: q.id, type: q.type, prompt: q.prompt, points: q.points, files: q.files ?? [] };
  const d = q.data ?? {};
  switch (q.type) {
    case 'choice':
      return { ...base, options: d.options, multiple: d.correct.length > 1 };
    case 'article':
      return { ...base, noun: d.noun, options: ARTICLES };
    case 'matching':
      return {
        ...base,
        left: d.pairs.map((p: any) => p.left),
        right: shuffled(d.pairs.map((p: any) => p.right as string), `${seed}:${q.id}`).map((x) => x.item),
      };
    default:
      return base;
  }
}

const norm = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '');

/** Баллы за ответ: доля от points (сопоставление — частично). */
export function score(q: Q, answer: unknown, seed: string): number {
  const d = q.data ?? {};
  switch (q.type) {
    case 'choice': {
      const a = Array.isArray(answer) ? [...new Set(answer as number[])].sort() : [];
      const c = [...d.correct].sort();
      return a.length === c.length && a.every((x, i) => x === c[i]) ? q.points : 0;
    }
    case 'article':
      return norm(answer) === d.correct ? q.points : 0;
    case 'matching': {
      if (!Array.isArray(answer)) return 0;
      const order = shuffled(d.pairs.map((p: any) => p.right), `${seed}:${q.id}`);
      const right = d.pairs.filter((_: unknown, i: number) => order[(answer as number[])[i]]?.index === i).length;
      return Math.round((q.points * right * 100) / d.pairs.length) / 100;
    }
    case 'text':
      return (d.answers as string[]).some((a) => norm(a) === norm(answer)) ? q.points : 0;
    default:
      return 0;
  }
}

/** Проверка всей попытки; для входного теста — определение уровня. */
export function grade(questions: Q[], answers: Record<string, unknown>, seed: string, placement: boolean) {
  let total = 0;
  let max = 0;
  const byLevel = new Map<string, { got: number; max: number }>();
  const details = questions.map((q) => {
    const got = score(q, answers?.[q.id], seed);
    total += got;
    max += q.points;
    if (q.level) {
      const l = byLevel.get(q.level) ?? { got: 0, max: 0 };
      l.got += got;
      l.max += q.points;
      byLevel.set(q.level, l);
    }
    return { questionId: q.id, got, max: q.points };
  });
  let level: string | null = null;
  if (placement) {
    level = 'A0';
    for (const l of PLACEMENT_LEVELS) {
      const r = byLevel.get(l);
      if (!r) continue;
      if (r.got / r.max >= PLACEMENT_PASS) level = l;
      else break;
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    score: round(total),
    maxScore: max,
    percent: max ? round((total / max) * 100) : 0,
    level,
    byLevel: Object.fromEntries([...byLevel].map(([k, v]) => [k, max ? round((v.got / v.max) * 100) : 0])),
    details,
  };
}
