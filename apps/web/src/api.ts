/** Клиент REST API: токены, автоматическое обновление сессии, активная роль. */

const KEY = 'crm.session';

export interface Session {
  accessToken: string;
  refreshToken: string;
  activeRoleId?: string;
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* приватный режим браузера — сессия только в памяти */
  }
  memory = s;
}

let memory: Session | null = getSession();
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  /** data — тело ответа об ошибке (например, список конфликтов расписания при 409). */
  constructor(public status: number, message: string, public data?: any) {
    super(message);
  }
}

async function tryRefresh(): Promise<boolean> {
  if (!memory?.refreshToken) return false;
  refreshing ??= fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: memory.refreshToken }),
  })
    .then(async (r) => {
      if (!r.ok) return false;
      const data = await r.json();
      setSession({ ...memory!, accessToken: data.accessToken, refreshToken: data.refreshToken });
      return true;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (memory?.accessToken) headers.Authorization = `Bearer ${memory.accessToken}`;
  if (memory?.activeRoleId) headers['X-Active-Role'] = memory.activeRoleId;

  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && retry && (await tryRefresh())) return api<T>(path, opts, false);
  if (res.status === 401) {
    setSession(null);
    window.dispatchEvent(new Event('crm:logout'));
  }
  if (!res.ok) {
    let msg = res.statusText;
    let data: any;
    try {
      data = await res.json();
      msg = Array.isArray(data.message) ? data.message.join('; ') : data.message ?? msg;
    } catch {
      /* пустой ответ */
    }
    throw new ApiError(res.status, msg, data);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function qs(params: Record<string, string | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
