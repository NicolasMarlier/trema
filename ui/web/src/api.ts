export type Status = "up" | "degraded" | "down" | "unknown" | "pending";
export type AppInfo = { name: string; status: Status; busy: boolean; url: string | null };
export type AppsResponse = { dockerOk: boolean; apps: AppInfo[] };
export type System = { cpu: number | null; mem: { total: number; used: number } | null; disk: { total: number; used: number } | null; hostname: string; dockerOk: boolean; at: number };
export type Container = { name: string; state: string; cpu: string | null; mem: string | null };
export type Deploy = { date: string; commit: string; duration: number; result: "ok" | "failed"; message: string | null; source?: "push" | "github" | "manual" | null };
export type EnvKey = { key: string; sensitive: boolean };
export type Job = { id: string; app: string; action: string; state: "running" | "ok" | "failed"; startedAt: number; endedAt: number | null; output?: string };

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body?: unknown) { super(message); this.status = status; this.body = body; }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const mutating = !!init?.method && init.method !== "GET";
  const r = await fetch(`/api/${path}`, mutating
    ? { method: init!.method, headers: { "content-type": "application/json", "x-trema": "1" }, body: JSON.stringify(init!.body ?? {}) }
    : undefined);
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(body?.error ?? `HTTP ${r.status}`, r.status, body);
  return body as T;
}

export const appPath = (name: string, sub = "") => `apps/${encodeURIComponent(name)}${sub ? `/${sub}` : ""}`;

export type Source = { repo: string; branch: string; rootDir: string; autoDeploy: boolean; alwaysDeploy: boolean; installationId: number | null };
export type GhRepo = { repo: string; private: boolean; defaultBranch: string; installationId: number; account?: string };
export type GhStatus = { configured: boolean; slug: string | null; htmlUrl: string | null; webhookUrl: string; deliveries: { date: string; repo: string; ref: string; commit: string; results: { app: string; action: string; reason?: string }[] }[] };
