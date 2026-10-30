import { useEffect, useState, type ReactNode } from "react";
import type { Status } from "./api";

const LABEL: Record<Status | "busy", string> = { up: "En ligne", degraded: "Dégradée", down: "Arrêtée", unknown: "Inconnue", busy: "En cours" };

export function StatusDot({ status, busy }: { status: Status; busy?: boolean }) {
  const k = busy ? "busy" : status;
  return <span className={`dot ${k}`} title={LABEL[k]} aria-label={LABEL[k]} />;
}
export function StatusPill({ status, busy }: { status: Status; busy?: boolean }) {
  const k = busy ? "busy" : status;
  return <span className={`pill ${k}`}><span className={`dot ${k}`} />{LABEL[k]}</span>;
}

export const Skeleton = ({ w = "100%", h = 14 }: { w?: number | string; h?: number }) => <span className="skeleton" style={{ width: w, height: h }} />;

export function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header><h3>{title}</h3>{right}</header>
      {children}
    </section>
  );
}

export const Refreshing = ({ on }: { on: boolean }) => <span className={`spin ${on ? "on" : ""}`} aria-hidden>↻</span>;

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="empty error">
      <p>{error.message}</p>
      {onRetry && <button onClick={onRetry}>Réessayer</button>}
    </div>
  );
}

export function Gauge({ label, pct, detail }: { label: string; pct: number | null; detail?: string }) {
  const p = pct ?? 0;
  return (
    <div className="gauge" title={detail}>
      <div className="row"><span>{label}</span><span className="mut">{pct == null ? "–" : `${Math.round(p)} %`}</span></div>
      <div className="bar"><div className={p > 85 ? "hot" : p > 65 ? "warm" : ""} style={{ width: `${p}%` }} /></div>
    </div>
  );
}

export function Confirm({ title, text, confirm, danger, onYes, onNo }: { title: string; text: ReactNode; confirm: string; danger?: boolean; onYes: () => void; onNo: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onNo();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onNo]);
  return (
    <div className="modal-bg" onClick={onNo}>
      <div className="modal" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="mut">{text}</div>
        <div className="actions">
          <button onClick={onNo}>Annuler</button>
          <button className={danger ? "danger" : "primary"} autoFocus onClick={onYes}>{confirm}</button>
        </div>
      </div>
    </div>
  );
}

export function useElapsed(since: number | null, until: number | null): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since == null || until != null) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [since, until]);
  return since == null ? 0 : Math.max(0, Math.round(((until ?? Date.now()) - since) / 1000));
}
