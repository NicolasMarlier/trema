import { useCallback, useEffect, useRef, useState } from "react";

// Stale-while-revalidate: cached data is shown immediately, refreshed in the background.
const cache = new Map<string, unknown>();

export type Resource<T> = { data: T | undefined; error: Error | null; loading: boolean; refreshing: boolean; reload: () => void };

export function useResource<T>(key: string | null, fetcher: () => Promise<T>, intervalMs = 0): Resource<T> {
  const [data, setData] = useState<T | undefined>(key ? (cache.get(key) as T | undefined) : undefined);
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const seq = useRef(0);

  const run = useCallback(async () => {
    if (!key) return;
    const id = ++seq.current;
    setRefreshing(true);
    try {
      const d = await fetchRef.current();
      if (id !== seq.current) return;
      cache.set(key, d); setData(d); setError(null);
    } catch (e) {
      if (id === seq.current) setError(e as Error);
    } finally {
      if (id === seq.current) setRefreshing(false);
    }
  }, [key]);

  useEffect(() => {
    setData(key ? (cache.get(key) as T | undefined) : undefined);
    setError(null);
    run();
    if (!intervalMs) return;
    const t = setInterval(() => { if (!document.hidden) run(); }, intervalMs);
    return () => { clearInterval(t); seq.current++; };
  }, [key, intervalMs, run]);

  return { data, error, loading: data === undefined && error === null, refreshing, reload: run };
}

export function useNow(ms = 1000): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return n;
}
