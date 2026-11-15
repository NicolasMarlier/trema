import { useEffect, useRef, useState } from "react";
import { api, appPath, ApiError, type DbDump, type Job } from "./api";
import { formatBytes, relativeTime } from "./format";
import { useNow, useResource } from "./useResource";
import { Card, ErrorBox, Refreshing, Skeleton } from "./ui";
import { useToast } from "./toast";

export const MAX_UPLOAD = 100 * 1024 * 1024; // keep in sync with ui/dbdump.mjs
const ORIGIN: Record<DbDump["origin"], string> = { manual: "manuel", "pre-restore": "sécurité", upload: "envoyé" };
type Mode = "full" | "data";
type Target = { file: string; label: string; existing: boolean };

function uploadExt(name: string): string | null {
  const n = name.toLowerCase();
  return n.endsWith(".sql.gz") ? "sql.gz" : n.endsWith(".dump") ? "dump" : n.endsWith(".sql") ? "sql" : null;
}

export function DbTab({ app, busy, onJob, version = 0 }: { app: string; busy: boolean; onJob: (j: Job) => void; version?: number }) {
  const toast = useToast();
  const r = useResource<DbDump[]>(`db:${app}`, () => api(appPath(app, "db/dumps")), 30_000);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } r.reload(); }, [version]); // eslint-disable-line
  const now = useNow(30_000);
  const [target, setTarget] = useState<Target | null>(null);
  const [mode, setMode] = useState<Mode>("full");
  const [confirm, setConfirm] = useState("");
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reset = () => { setTarget(null); setConfirm(""); setMode("full"); };

  const createDump = async () => {
    setStarting(true);
    try { const j = await api<{ job: Job }>(appPath(app, "db/dumps"), { method: "POST" }); onJob(j.job); }
    catch (e) { toast("error", e instanceof ApiError && e.status === 409 ? "Une action est déjà en cours sur cette app" : (e as Error).message); }
    finally { setStarting(false); }
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!uploadExt(f.name)) return toast("error", "Extension non supportée (.dump, .sql, .sql.gz).");
    if (f.size > MAX_UPLOAD) return toast("error", `Fichier trop gros (max ${formatBytes(MAX_UPLOAD)}).`);
    setUploading(true);
    try {
      const res = await fetch(`/api/${appPath(app, "db/upload")}?name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-trema": "1" }, body: f });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setTarget({ file: body.file, label: `${f.name} · ${formatBytes(body.size)} · format détecté : ${body.format === "custom" ? "custom" : body.format === "gzip" ? "SQL compressé" : "SQL"}`, existing: false });
      setConfirm(""); r.reload();
    } catch (e) { toast("error", (e as Error).message); }
    finally { setUploading(false); if (input.current) input.current.value = ""; }
  };

  const restore = async () => {
    if (!target) return;
    setStarting(true);
    try { const j = await api<{ job: Job }>(appPath(app, "db/restore"), { method: "POST", body: { file: target.file, mode, confirm } }); onJob(j.job); reset(); }
    catch (e) { toast("error", (e as Error).message); }
    finally { setStarting(false); }
  };

  return (
    <>
      <Card title="Dumps" right={<span className="actions"><Refreshing on={r.refreshing} /><button className="primary" disabled={busy || starting} onClick={createDump}>Créer un dump</button></span>}>
        {r.error && !r.data ? <ErrorBox error={r.error} onRetry={r.reload} /> :
          r.loading ? <table><tbody>{[0, 1].map((i) => <tr key={i}><td><Skeleton w={240} /></td><td><Skeleton w={60} /></td></tr>)}</tbody></table> :
          !r.data?.length ? <div className="empty"><p>Aucun dump pour cette app.</p><p className="mut">« Créer un dump » lance un <code>pg_dump -Fc</code> complet (schéma + données).</p></div> :
          <table>
            <thead><tr><th>Fichier</th><th>Taille</th><th>Date</th><th>Origine</th><th /></tr></thead>
            <tbody>{r.data.map((d) => (
              <tr key={d.file}>
                <td className="mono">{d.file}</td><td>{formatBytes(d.size)}</td><td title={d.date}>{relativeTime(d.date, now)}</td><td><span className="tag">{ORIGIN[d.origin]}</span></td>
                <td className="actions">
                  <a href={`/api/${appPath(app, `db/dumps/${encodeURIComponent(d.file)}`)}`} download={d.file}>Télécharger</a>
                  <button disabled={busy} onClick={() => { setTarget({ file: d.file, label: d.file, existing: true }); setConfirm(""); }}>Restaurer</button>
                </td>
              </tr>
            ))}</tbody>
          </table>}
        <p className="mut">Les 10 derniers dumps par app sont conservés (purge nocturne).</p>
      </Card>

      <Card title="Restaurer">
        <input ref={input} type="file" accept=".dump,.sql,.gz" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <div className={`drop ${target ? "has" : ""}`} role="button" tabIndex={0}
          onClick={() => !busy && !uploading && input.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy && !uploading) input.current?.click(); }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (!busy && !uploading) pick(e.dataTransfer.files?.[0]); }}>
          {uploading ? "Envoi en cours…" : target ? <>{target.existing ? "Dump existant : " : "Fichier : "}<strong>{target.label}</strong></> : `Déposer un fichier .dump, .sql ou .sql.gz (max ${formatBytes(MAX_UPLOAD)}) — ou cliquer « Restaurer » sur un dump ci-dessus`}
        </div>
        {target && (
          <div className="restore">
            <div className="modes" role="radiogroup">
              <label className={mode === "full" ? "on" : ""}><input type="radio" name="mode" checked={mode === "full"} onChange={() => setMode("full")} /> <strong>Remplacer tout</strong> — schéma du dump, puis migrations<small className="mut">Pour un dump d'une autre version de l'app (<code>db:prepare</code> est joué ensuite).</small></label>
              <label className={mode === "data" ? "on" : ""}><input type="radio" name="mode" checked={mode === "data"} onChange={() => setMode("data")} /> <strong>Données seulement</strong> — schéma actuel conservé<small className="mut">Le dump doit avoir le même schéma. Tout est annulé en cas d'écart (une seule transaction).</small></label>
            </div>
            <p className="warn">⚠ La base actuelle sera remplacée (un dump de sécurité est pris avant, le web est arrêté pendant l'opération). Tapez <strong>{app}</strong> pour confirmer :</p>
            <div className="actions">
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={app} aria-label="Nom de l'app" />
              <button className="danger" disabled={busy || starting || confirm !== app} onClick={restore}>Restaurer la base</button>
              <button onClick={reset}>Annuler</button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
