/**
 * Загрузка данных экрана с кэшем на телефоне: без связи показывается последняя полученная версия.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NetworkError } from './api';
import { getJson, setJson } from './storage';

export function useLoad<T>(cacheKey: string | null, fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fn();
      if (!alive.current) return;
      setData(d);
      setError(null);
      setStale(false);
      if (cacheKey) setJson(`cache:${cacheKey}`, d);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof NetworkError && cacheKey) {
        const cached = await getJson<T | null>(`cache:${cacheKey}`, null);
        if (cached) {
          setData(cached);
          setStale(true);
          setError(null);
          return;
        }
      }
      setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, ...deps]);

  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  return { data, error, loading, stale, reload };
}
