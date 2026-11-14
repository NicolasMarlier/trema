import { useEffect, useMemo, useRef, useState } from "react";
import { api, appPath, ApiError, type Container, type Deploy, type EnvKey, type Job } from "./api";
import { diffEnv, toPatch, ENV_KEY_RE } from "./envDiff";
import { filterLines, logLevel, relativeTime, formatDuration, tail } from "./format";
import { useNow, useResource } from "./useResource";
import { Card, Confirm, ErrorBox, Refreshing, Skeleton } from "./ui";
import { useToast } from "./toast";

export function Overview({ app, dockerOk }: { app: string; dockerOk: boolean }) {
  const r = useResource<Container[]>(`stats:${app}`, () => api(appPath(app, "stats")), 10_000);
  return (
    <Card title="Conteneurs" right={<Refreshing on={r.refreshing} />}>
      {!dockerOk && <div className="empty error"><p>Docker est injoignable sur le serveur. Les statuts sont inconnus.</p></div>}
      {r.error && !r.data ? <ErrorBox error={r.error} onRetry={r.reload} /> :
        r.loading ? <table><tbody>{[0, 1].map((i) => <tr key={i}><td><Skeleton w={160} /></td><td><Skeleton w={60} /></td><td><Skeleton w={120} /></td></tr>)}</tbody></table> :
        !r.data?.length ? <div className="empty"><p>Aucun conteneur : cette app n'a pas encore été déployée (ou a été supprimée).</p><p className="mut">Faites un <code>git push</code> pour la déployer.</p></div> :
        <table>
          <thead><tr><th>Conteneur</th><th>État</th><th>CPU</th><th>Mémoire</th></tr></thead>
          <tbody>{r.data.map((c) => (
            <tr key={c.name}><td className="mono">{c.name}</td><td><span className={`tag ${c.state === "running" ? "ok" : "ko"}`}>{c.state}</span></td><td>{c.cpu ?? "–"}</td><td>{c.mem ?? "–"}</td></tr>
          ))}</tbody>
        </table>}
    </Card>
  );
}

export function Logs({ app }: { app: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"connecting" | "live" | "closed">("connecting");
  const pausedRef = useRef(false);
  const buffer = useRef<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  pausedRef.current = paused;

  useEffect(() => {
    setLines([]); buffer.current = []; setState("connecting");
    const es = new EventSource(`/api/${appPath(app, "logs")}`);
    es.onopen = () => setState("live");
    es.onerror = () => setState("closed");
    let pending: string[] = [];
    es.onmessage = (e) => { pending.push(e.data); };
    // batch renders: logs can be chatty
    const t = setInterval(() => {
      if (!pending.length) return;
      const batch = pending; pending = [];
      if (pausedRef.current) buffer.current = tail([...buffer.current, ...batch], 2000);
      else setLines((l) => tail([...l, ...batch], 2000));
    }, 250);
    return () => { es.close(); clearInterval(t); };
  }, [app]);

  useEffect(() => {
    if (!paused && buffer.current.length) { const b = buffer.current; buffer.current = []; setLines((l) => tail([...l, ...b], 2000)); }
  }, [paused]);
  const shown = useMemo(() => filterLines(lines, query), [lines, query]);
  useEffect(() => { if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown, paused]);

  return (
    <Card title="Logs" right={<span className="mut">{state === "live" ? "● en direct" : state === "connecting" ? "connexion…" : "○ déconnecté"}</span>}>
      <div className="toolbar">
        <input placeholder="Filtrer…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={() => setPaused(!paused)}>{paused ? "▶ Reprendre" : "⏸ Pause"}</button>
        <button onClick={() => setLines([])}>Vider</button>
      </div>
      <div className="logs" ref={box}>
        {state === "connecting" && !lines.length && <Skeleton h={14} />}
        {!shown.length && state !== "connecting" && <div className="mut">{lines.length ? "Aucune ligne ne correspond au filtre." : "Aucun log pour le moment."}</div>}
        {shown.map((l, i) => <div key={i} className={`log ${logLevel(l)}`}>{l}</div>)}
      </div>
    </Card>
  );
}

function EnvValue({ app, k, sensitive, edited, onEdit }: { app: string; k: string; sensitive: boolean; edited: string | undefined; onEdit: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const reveal = async () => {
    if (shown) { setShown(false); return; }
    if (edited === undefined) {
      setLoading(true);
      try { const r = await api<{ value: string }>(appPath(app, `env/${encodeURIComponent(k)}`)); onEdit(r.value); setShown(true); }
      catch (e) { toast("error", (e as Error).message); }
      finally { setLoading(false); }
    } else setShown(true);
  };
  return (
    <>
      <input className="mono" type={shown ? "text" : "password"} value={edited ?? "••••••••"} readOnly={edited === undefined}
        onChange={(e) => onEdit(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`Valeur de ${k}`} />
      <button onClick={reveal} disabled={loading}>{loading ? "…" : shown ? "Masquer" : "Voir"}</button>
      {sensitive && <span className="tag warn" title="Clé sensible">secret</span>}
    </>
  );
}

export function Env({ app, busy, onRedeploy }: { app: string; busy: boolean; onRedeploy: (j: Job) => void }) {
  const toast = useToast();
  const r = useResource<EnvKey[]>(`env:${app}`, () => api(appPath(app, "env")));
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [added, setAdded] = useState<{ id: number; key: string; value: string }[]>([]);
  const nextId = useRef(0);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setEdited({}); setRemoved([]); setAdded([]); }, [app]);

  const original = useMemo(() => (r.data ?? []).map((e) => e.key), [r.data]);
  // only keep entries the user really touched: values loaded via "Voir" but unchanged are not part of the diff
  const loaded = useRef<Record<string, string>>({});
  const changes = diffEnv({
    original,
    edited: {
      ...Object.fromEntries(Object.entries(edited).filter(([k, v]) => loaded.current[k] !== v)),
      ...Object.fromEntries(added.filter((a) => a.key).map((a) => [a.key, a.value])),
    },
    removed,
  });
  const invalid = added.map((a) => a.key).filter((k, i, all) => !k || !ENV_KEY_RE.test(k) || original.includes(k) || all.indexOf(k) !== i);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api<{ job: Job }>(appPath(app, "env"), { method: "PATCH", body: toPatch(changes) });
      toast("ok", "Variables enregistrées, redéploiement lancé");
      setEdited({}); setRemoved([]); setAdded([]); loaded.current = {};
      r.reload(); onRedeploy(res.job);
    } catch (e) {
      toast("error", e instanceof ApiError && e.status === 409 ? "Une action est déjà en cours sur cette app" : (e as Error).message);
    } finally { setSaving(false); setConfirm(false); }
  };

  const setVal = (k: string, v: string, fromReveal = false) => {
    if (fromReveal && loaded.current[k] === undefined) loaded.current[k] = v;
    setEdited((m) => ({ ...m, [k]: v }));
  };
  const rows: { id: string; k: string; add?: number }[] = [
    ...original.filter((k) => !removed.includes(k)).map((k) => ({ id: "o:" + k, k })),
    ...added.map((a) => ({ id: "n:" + a.id, k: a.key, add: a.id })),
  ];

  return (
    <Card title="Variables d'environnement" right={<Refreshing on={r.refreshing} />}>
      {r.error && !r.data ? <ErrorBox error={r.error} onRetry={r.reload} /> :
        r.loading ? <div className="stack">{[0, 1, 2].map((i) => <Skeleton key={i} h={32} />)}</div> : (
          <>
            {!rows.length && <div className="empty"><p>Aucune variable définie.</p></div>}
            <div className="env-grid">
              {rows.map(({ id, k, add }) => {
                const nw = add !== undefined ? added.find((a) => a.id === add) : undefined;
                const meta = r.data?.find((e) => e.key === k);
                return (
                  <div className="env-row" key={id}>
                    {nw ? <input className="mono key" placeholder="NOM" value={nw.key} onChange={(e) => {
                      const nk = e.target.value; setAdded((a) => a.map((x) => (x.id === nw.id ? { ...x, key: nk } : x)));
                    }} /> : <span className="mono key">{k}</span>}
                    {nw ? <input className="mono" placeholder="valeur" value={nw.value} onChange={(e) => { const v = e.target.value; setAdded((a) => a.map((x) => (x.id === nw.id ? { ...x, value: v } : x))); }} />
                      : <EnvValue app={app} k={k} sensitive={!!meta?.sensitive} edited={edited[k]} onEdit={(v) => setVal(k, v, edited[k] === undefined)} />}
                    <button className="ghost danger-text" title="Supprimer" onClick={() => nw ? setAdded((a) => a.filter((x) => x.id !== nw.id)) : setRemoved((l) => [...l, k])}>✕</button>
                  </div>
                );
              })}
            </div>
            <div className="toolbar">
              <button onClick={() => setAdded((a) => [...a, { id: nextId.current++, key: "", value: "" }])}>+ Variable</button>
              <span className="grow" />
              {changes.length > 0 && <button className="ghost" onClick={() => { setEdited({}); setRemoved([]); setAdded([]); }}>Annuler les changements</button>}
              <button className="primary" disabled={!changes.length || busy || saving || invalid.length > 0} onClick={() => setConfirm(true)}>
                {busy ? "Action en cours…" : `Enregistrer et redéployer${changes.length ? ` (${changes.length})` : ""}`}
              </button>
            </div>
            {invalid.length > 0 && <p className="mut error-text">Nom invalide ou déjà utilisé : {invalid.map((k) => k || "(vide)").join(", ")}</p>}
          </>
        )}
      {confirm && (
        <Confirm title="Redéployer avec ces changements ?" confirm={saving ? "…" : "Redéployer"} onNo={() => setConfirm(false)} onYes={save}
          text={<>
            <ul className="diff">{changes.map((c) => (
              <li key={c.kind + c.key} className={c.kind}><span>{c.kind === "add" ? "+" : c.kind === "change" ? "~" : "−"}</span><code>{c.key}</code>
                <em>{c.kind === "add" ? "ajoutée" : c.kind === "change" ? "modifiée" : "supprimée"}</em></li>
            ))}</ul>
            <p>Les conteneurs seront reconstruits et recréés. L'opération peut durer plusieurs minutes.</p>
          </>} />
      )}
    </Card>
  );
}

export function Deploys({ app }: { app: string }) {
  const r = useResource<Deploy[]>(`deploys:${app}`, () => api(appPath(app, "deploys")), 30_000);
  const now = useNow(30_000);
  return (
    <Card title="Déploiements" right={<Refreshing on={r.refreshing} />}>
      {r.error && !r.data ? <ErrorBox error={r.error} onRetry={r.reload} /> :
        r.loading ? <table><tbody>{[0, 1, 2].map((i) => <tr key={i}><td><Skeleton w={80} /></td><td><Skeleton w={60} /></td><td><Skeleton w={240} /></td><td><Skeleton w={40} /></td></tr>)}</tbody></table> :
        !r.data?.length ? <div className="empty"><p>Aucun déploiement enregistré.</p><p className="mut">Les déploiements apparaissent après un <code>git push</code>.</p></div> :
        <table>
          <thead><tr><th>Quand</th><th>Commit</th><th>Message</th><th>Source</th><th>Durée</th><th>Résultat</th></tr></thead>
          <tbody>{r.data.map((d) => (
            <tr key={d.date + d.commit}>
              <td title={d.date}>{relativeTime(d.date, now)}</td><td className="mono">{d.commit}</td><td className="msg">{d.message ?? <span className="mut">–</span>}</td>
              <td>{d.source ?? "push"}</td><td>{formatDuration(d.duration)}</td><td><span className={`tag ${d.result === "ok" ? "ok" : "ko"}`}>{d.result === "ok" ? "réussi" : "échoué"}</span></td>
            </tr>
          ))}</tbody>
        </table>}
    </Card>
  );
}

export function Pending({ app, busy, onRetry }: { app: string; busy: boolean; onRetry: () => void }) {
  const r = useResource<{ domain: string; commands: string[] }>(`setup:${app}`, () => api(appPath(app, "setup")));
  return (
    <Card title="En attente du premier déploiement">
      <p className="mut">Le serveur est prêt. Dans le dossier git local de l'app, lancez :</p>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : r.data ? <pre className="cmds">{r.data.commands.join("\n")}</pre> : <Skeleton h={60} />}
      <p className="mut">Si la création a échoué (DNS, certificat…), corrigez puis relancez : les étapes déjà faites sont conservées.</p>
      <button disabled={busy} onClick={onRetry}>Réessayer la configuration</button>
    </Card>
  );
}
