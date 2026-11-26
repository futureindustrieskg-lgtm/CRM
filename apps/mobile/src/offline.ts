/**
 * Офлайн-отметки посещаемости (ТЗ 4, сценарий S9): отметка сохраняется на телефоне с временем
 * устройства (clientTime) и отправляется, когда появится связь. На сервере побеждает более поздняя отметка,
 * поэтому повторная или запоздалая отправка не затирает свежие исправления администратора.
 */
import NetInfo from '@react-native-community/netinfo';
import { api, ApiError, NetworkError } from './api';
import { getJson, setJson } from './storage';

export type MarkStatus = 'present' | 'late' | 'excused' | 'absent';
export interface MarkItem {
  studentId: string;
  status: MarkStatus;
}
export interface QueuedMark {
  id: string;
  lessonId: string;
  /** Подпись для экрана: группа и время занятия. */
  label: string;
  items: MarkItem[];
  topic?: string;
  clientTime: string;
}
export interface SyncFailure {
  label: string;
  error: string;
}

const KEY = 'crm.attendanceQueue';
let queue: QueuedMark[] = [];
let failures: SyncFailure[] = [];
let loaded = false;
let syncing: Promise<void> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const pending = () => queue;
export const lastFailures = () => failures;

async function load() {
  if (loaded) return;
  queue = await getJson<QueuedMark[]>(KEY, []);
  loaded = true;
}
async function persist() {
  await setJson(KEY, queue);
  emit();
}

/** Отметка с телефона: сразу на сервер, без связи — в очередь. Возвращает true, если уже на сервере. */
export async function submitMarks(mark: Omit<QueuedMark, 'id' | 'clientTime'>): Promise<boolean> {
  await load();
  const entry: QueuedMark = { ...mark, id: `${mark.lessonId}:${Date.now()}`, clientTime: new Date().toISOString() };
  // Новая отметка того же занятия заменяет неотправленную старую.
  queue = queue.filter((q) => q.lessonId !== mark.lessonId);
  try {
    await send(entry);
    await persist();
    return true;
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    queue.push(entry);
    await persist();
    return false;
  }
}

const send = (q: QueuedMark) =>
  api(`/lessons/${q.lessonId}/attendance`, { method: 'PUT', body: { items: q.items, clientTime: q.clientTime, ...(q.topic ? { topic: q.topic } : {}) } });

/** Отправка очереди по порядку. Ошибка сервера (занятие отменено и т. п.) снимает отметку с очереди и показывается. */
export function sync(): Promise<void> {
  syncing ??= (async () => {
    await load();
    for (const q of [...queue]) {
      try {
        await send(q);
        queue = queue.filter((x) => x.id !== q.id);
      } catch (e) {
        if (e instanceof NetworkError) break;
        if (e instanceof ApiError && e.status === 401) break;
        queue = queue.filter((x) => x.id !== q.id);
        failures = [...failures, { label: q.label, error: e instanceof Error ? e.message : String(e) }].slice(-10);
      }
      await persist();
    }
  })().finally(() => {
    syncing = null;
    emit();
  });
  return syncing;
}

export const clearFailures = () => {
  failures = [];
  emit();
};

/** Автоматическая отправка при появлении сети. */
export function startAutoSync() {
  load().then(() => {
    emit();
    sync().catch(() => {});
  });
  return NetInfo.addEventListener((s) => {
    if (s.isConnected && s.isInternetReachable !== false && queue.length) sync().catch(() => {});
  });
}
