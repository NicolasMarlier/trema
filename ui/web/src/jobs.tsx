import { useCallback, useEffect, useRef, useState } from "react";
import { api, appPath, type Job } from "./api";
import { formatDuration } from "./format";
import { useElapsed } from "./ui";
import { jobTitle, resyncDelay, resyncStep } from "./resync";

export type JobState = Job & { output: string; dismissed?: boolean; resyncing?: boolean };

/** Tracks the latest job per app; follows a running one over SSE (survives reloads: re-fetched on mount). */
export function useJobs(onDone: (j: JobState) => void) {
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const sources = useRef(new Map<string, EventSource>());
  const stopped = useRef(false);
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
    es.onerror = () => {
      // Stream cut (nginx restart/timeout) or closed by the server: close, then resync from GET /api/jobs/:id.
      es.close(); sources.current.delete(j.id);
      if (stopped.current) return;
      setJobs((m) => m[j.app]?.id === j.id && m[j.app].state === "running" ? { ...m, [j.app]: { ...m[j.app], resyncing: true } } : m);
      let attempt = 0;
      const poll = async () => {
        if (stopped.current) return;
        let fetched: Job | null = null;
        try { fetched = await api<Job>(`jobs/${j.id}`); } catch { /* retry */ }
        const step = resyncStep(fetched);
        if (step.kind === "retry") { setTimeout(poll, resyncDelay(attempt++)); return; }
        if (step.kind === "reconnect") {
          setJobs((m) => m[j.app]?.id === j.id ? { ...m, [j.app]: { ...m[j.app], resyncing: false } } : m);
          track(step.job); // re-opens the SSE; `init` replaces the output
          return;
        }
        const next = { ...step.job, output: step.job.output ?? "", resyncing: false };
        setJobs((m) => m[j.app]?.id === j.id ? { ...m, [j.app]: next } : m);
        doneRef.current(next);
      };
      setTimeout(poll, resyncDelay(attempt++));
    };
  }, []);

  const restore = useCallback(async (app: string) => {
    try {
      const j = await api<Job | null>(appPath(app, "job"));
      if (j && j.state === "running") track(j);
    } catch { /* ignore */ }
  }, [track]);

  const dismiss = useCallback((app: string) => setJobs((m) => (m[app] ? { ...m, [app]: { ...m[app], dismissed: true } } : m)), []);
  useEffect(() => { stopped.current = false; return () => { stopped.current = true; sources.current.forEach((e) => e.close()); }; }, []);
  return { jobs, track, restore, dismiss };
}

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
        <strong>{running ? "⟳ " : job.state === "ok" ? "✓ " : "✕ "}{jobTitle(job.action)}{running ? " en cours…" : job.state === "ok" ? " terminé" : " échoué"}</strong>
        <span className="mut">{formatDuration(secs)}</span>
        <span className="grow" />
        <button className="ghost" onClick={() => setOpen(!open)}>{open ? "Masquer la sortie" : "Voir la sortie"}</button>
        {!running && <button className="ghost" onClick={onDismiss}>Fermer</button>}
      </div>
      {running && <div className="progress"><div /></div>}
      {running && job.resyncing && <div className="mut resync">connexion interrompue, resynchronisation…</div>}
      {open && <pre ref={pre}>{job.output || "En attente de la sortie de docker compose…"}</pre>}
    </div>
  );
}
