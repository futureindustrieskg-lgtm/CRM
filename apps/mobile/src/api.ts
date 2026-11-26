/** Клиент REST API: токены, обновление сессии, активная роль (X-Active-Role). */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getSecure, setSecure } from './storage';

/**
 * Адрес API: EXPO_PUBLIC_API_URL при сборке, иначе extra.apiUrl из app.json.
 * Эмулятор Android видит компьютер разработчика по адресу 10.0.2.2.
 */
function apiBase() {
  const configured = process.env.EXPO_PUBLIC_API_URL || (Constants.expoConfig?.extra?.apiUrl as string | undefined) || 'http://localhost:3000/api/v1';
  return Platform.OS === 'android' ? configured.replace('://localhost', '://10.0.2.2') : configured;
}
export const API_URL = apiBase().replace(/\/$/, '');

const KEY = 'crm.session';

export interface Role {
  id: string;
  code: string;
  name: string;
  permissions: string[];
  branchName: string | null;
}
export interface Profile {
  id: string;
  firstName: string;
  lastName: string;
  locale: string;
  roles: Role[];
}
export interface Session {
  accessToken: string;
  refreshToken: string;
  activeRoleId?: string;
}

let memory: Session | null = null;
let refreshing: Promise<boolean> | null = null;
let onLogout: () => void = () => {};

export const setLogoutHandler = (fn: () => void) => (onLogout = fn);

export async function loadSession() {
  const raw = await getSecure(KEY);
  try {
    memory = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    memory = null;
  }
  return memory;
}

export async function saveSession(s: Session | null) {
  memory = s;
  await setSecure(KEY, s ? JSON.stringify(s) : null);
}

export const currentSession = () => memory;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Нет связи с сервером (а не ошибка сервера): отметка уходит в офлайн-очередь. */
export class NetworkError extends Error {}

async function tryRefresh(): Promise<boolean> {
  if (!memory?.refreshToken) return false;
  refreshing ??= fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: memory.refreshToken }),
  })
    .then(async (r) => {
      if (!r.ok) return false;
      const d = await r.json();
      await saveSession({ ...memory!, accessToken: d.accessToken, refreshToken: d.refreshToken });
      return true;
    })
    .catch(() => false)
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (memory?.accessToken) headers.Authorization = `Bearer ${memory.accessToken}`;
  if (memory?.activeRoleId) headers['X-Active-Role'] = memory.activeRoleId;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new NetworkError('Нет связи с сервером');
  }
  if (res.status === 401 && retry && memory?.refreshToken && (await tryRefresh())) return api<T>(path, opts, false);
  if (res.status === 401 && memory) {
    await saveSession(null);
    onLogout();
  }
  if (!res.ok) {
    let msg = res.statusText || `Ошибка ${res.status}`;
    try {
      const d = await res.json();
      msg = Array.isArray(d.message) ? d.message.join('; ') : d.message ?? msg;
    } catch {
      /* пустой ответ */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size?: number;
}

/** Файл с телефона: uri (камера, галерея, документ, запись) или Blob в веб-сборке. */
export interface LocalFile {
  uri: string;
  name: string;
  mime: string;
  blob?: Blob;
}

/** Загрузка файла (до 20 МБ) — возвращает id для прикрепления к сдаче ДЗ. */
export async function uploadFile(f: LocalFile, retry = true): Promise<FileRef> {
  const fd = new FormData();
  if (Platform.OS === 'web') {
    const blob = f.blob ?? (await (await fetch(f.uri)).blob());
    fd.append('file', blob, f.name);
  } else {
    // React Native: файл передаётся объектом { uri, name, type } — читается с диска при отправке.
    fd.append('file', { uri: f.uri, name: f.name, type: f.mime } as unknown as Blob);
  }
  const headers: Record<string, string> = {};
  if (memory?.accessToken) headers.Authorization = `Bearer ${memory.accessToken}`;
  if (memory?.activeRoleId) headers['X-Active-Role'] = memory.activeRoleId;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/files`, { method: 'POST', headers, body: fd });
  } catch {
    throw new NetworkError('Нет связи с сервером');
  }
  if (res.status === 401 && retry && (await tryRefresh())) return uploadFile(f, false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? res.statusText);
  return data as FileRef;
}

/**
 * Источник для защищённого файла (фото, аудио задания): на телефоне — uri с заголовком авторизации,
 * в веб-сборке — временная ссылка на скачанный Blob (браузер не передаёт заголовки в <img>/<audio>).
 */
export async function fileSource(id: string): Promise<{ uri: string; headers?: Record<string, string> }> {
  const headers: Record<string, string> = {};
  if (memory?.accessToken) headers.Authorization = `Bearer ${memory.accessToken}`;
  if (memory?.activeRoleId) headers['X-Active-Role'] = memory.activeRoleId;
  if (Platform.OS !== 'web') return { uri: `${API_URL}/files/${id}`, headers };
  const res = await fetch(`${API_URL}/files/${id}`, { headers });
  if (!res.ok) throw new ApiError(res.status, 'Файл недоступен');
  return { uri: URL.createObjectURL(await res.blob()) };
}

/** Медиа вопроса теста: доступ по токену попытки, без входа. */
export const testFileUri = (id: string, token: string) => `${API_URL}/public/files/${id}?a=${encodeURIComponent(token)}`;

export async function login(loginValue: string, password: string): Promise<Profile> {
  const d = await api<{ accessToken: string; refreshToken: string; user: Profile }>('/auth/login', { method: 'POST', body: { login: loginValue, password } }, false);
  const role = pickRole(d.user.roles);
  await saveSession({ accessToken: d.accessToken, refreshToken: d.refreshToken, activeRoleId: role?.id });
  return d.user;
}

export async function logout() {
  const s = memory;
  await saveSession(null);
  if (s?.refreshToken) fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) }).catch(() => {});
}

/** Роль по умолчанию в приложении: сначала «клиентские» и преподаватель — для них приложение и сделано. */
const ROLE_ORDER = ['student', 'parent', 'teacher'];
export function pickRole(roles: Role[]) {
  return [...roles].sort((a, b) => rank(a.code) - rank(b.code))[0];
}
const rank = (c: string) => (ROLE_ORDER.indexOf(c) === -1 ? 99 : ROLE_ORDER.indexOf(c));

export async function setActiveRole(roleId: string) {
  if (memory) await saveSession({ ...memory, activeRoleId: roleId });
}
