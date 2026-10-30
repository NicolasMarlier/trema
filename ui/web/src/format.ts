// Pure formatting helpers (tested from /test/web.test.mjs, no DOM, no I/O).

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** "il y a 3 min" style date, relative to `now` (ms). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = Math.max(0, Math.round((now - t) / 1000));
  if (d < 45) return "à l'instant";
  if (d < 3600) return `il y a ${Math.max(1, Math.round(d / 60))} min`;
  if (d < 86400) return `il y a ${Math.round(d / 3600)} h`;
  if (d < 86400 * 30) return `il y a ${Math.round(d / 86400)} j`;
  return new Date(t).toISOString().slice(0, 10);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function percent(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

export type LogLevel = "error" | "warn" | "info";

export function logLevel(line: string): LogLevel {
  if (/\b(error|err|fatal|panic|exception|failed)\b/i.test(line)) return "error";
  if (/\b(warn|warning|deprecated)\b/i.test(line)) return "warn";
  return "info";
}

/** Filter lines by case-insensitive substring; empty query keeps everything. */
export function filterLines(lines: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
}

/** Keep the last `max` items. */
export function tail<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

export type Route = { app: string | null; tab: Tab };
export const TABS = ["overview", "logs", "env", "deploys"] as const;
export type Tab = (typeof TABS)[number];

/** Parse "#/app/tab" (unknown tab -> overview). */
export function parseHash(hash: string): Route {
  const [app, tab] = hash.replace(/^#\/?/, "").split("/");
  return { app: app ? decodeURIComponent(app) : null, tab: (TABS as readonly string[]).includes(tab) ? (tab as Tab) : "overview" };
}
export function buildHash(r: Route): string {
  return r.app ? `#/${encodeURIComponent(r.app)}/${r.tab}` : "#/";
}
