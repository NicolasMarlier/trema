import { useCallback, useEffect, useRef, useState } from "react";
import { api, appPath, type Job } from "./api";
import { formatDuration } from "./format";
import { useElapsed } from "./ui";

export type JobState = Job & { output: string; dismissed?: boolean };

/** Tracks the latest job per app; follows a running one over SSE (survives reloads: re-fetched on mount). */
export function useJobs(onDone: (j: JobState) => void) {
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const sources = useRef(new Map<string, EventSource>());
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const track = useCallback((j: Job) => {
    setJobs((m) => ({ ...m, [j.app]: { ...j, output: j.output ?? "" } }));
    if (j.state !== "running" || sources.current.has(j.id)) return;
    const es = new EventSource(`/api/jobs/${j.id}/stream`);
    sources.current.set(j.id, es);
    es.addEventListener("init", (e) => {
      const v = JSON.parse((e as MessageEvent).data);
      const next = { ...v, output: v.output ?? "" };
      setJobs((m) => ({ ...m, [j.app]: next }));
      if (v.state !== "running") { es.close(); sources.current.delete(j.id); doneRef.current(next); }
    });
    es.addEventListener("out", (e) => { const t = JSON.parse((e as MessageEvent).data) as string; setJobs((m) => m[j.app]?.id === j.id ? { ...m, [j.app]: { ...m[j.app], output: (m[j.app].output + t).slice(-50_000) } } : m); });
    es.addEventListener("done", (e) => {
      const v = JSON.parse((e as MessageEvent).data);
      es.close(); sources.current.delete(j.id);
      setJobs((m) => { const next = { ...m[j.app], ...v }; doneRef.current(next); return { ...m, [j.app]: next }; });
    });
    es.onerror = () => { /* server closes the stream at the end; EventSource would retry, so close */ es.close(); sources.current.delete(j.id); };
  }, []);

  const restore = useCallback(async (app: string) => {
    try {
      const j = await api<Job | null>(appPath(app, "job"));
      if (j && j.state === "running") track(j);
    } catch { /* ignore */ }
  }, [track]);

  const dismiss = useCallback((app: string) => setJobs((m) => (m[app] ? { ...m, [app]: { ...m[app], dismissed: true } } : m)), []);
  useEffect(() => () => sources.current.forEach((e) => e.close()), []);
  return { jobs, track, restore, dismiss };
}

const TITLE: Record<string, string> = { restart: "Redémarrage", stop: "Arrêt", start: "Démarrage", redeploy: "Redéploiement" };

export function JobBanner({ job, onDismiss }: { job: JobState; onDismiss: () => void }) {
  const running = job.state === "running";
  const secs = useElapsed(job.startedAt, job.endedAt);
  const [open, setOpen] = useState(true);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [job.output, open]);
  if (job.dismissed && !running) return null;
  return (
    <div className={`job ${job.state}`}>
      <div className="row">
        <strong>{running ? "⟳ " : job.state === "ok" ? "✓ " : "✕ "}{TITLE[job.action] ?? job.action}{running ? " en cours…" : job.state === "ok" ? " terminé" : " échoué"}</strong>
        <span className="mut">{formatDuration(secs)}</span>
        <span className="grow" />
        <button className="ghost" onClick={() => setOpen(!open)}>{open ? "Masquer la sortie" : "Voir la sortie"}</button>
        {!running && <button className="ghost" onClick={onDismiss}>Fermer</button>}
      </div>
      {running && <div className="progress"><div /></div>}
      {open && <pre ref={pre}>{job.output || "En attente de la sortie de docker compose…"}</pre>}
    </div>
  );
}
