import { useCallback, useEffect, useState } from "react";
import { api, appPath, ApiError, type AppsResponse, type AppInfo, type System } from "./api";
import { buildHash, formatBytes, parseHash, percent, TABS, type Route, type Tab } from "./format";
import { useResource } from "./useResource";
import { Confirm, ErrorBox, Gauge, Refreshing, Skeleton, StatusDot, StatusPill } from "./ui";
import { JobBanner, useJobs } from "./jobs";
import { Deploys, Env, Logs, Overview } from "./tabs";
import { useToast } from "./toast";

const TAB_LABEL: Record<Tab, string> = { overview: "Vue d'ensemble", logs: "Logs", env: "Env", deploys: "Déploiements" };

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const h = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return [route, (r) => { location.hash = buildHash(r); }];
}

function Sidebar({ apps, selected, onSelect, system, hostname }: { apps: ReturnType<typeof useResource<AppsResponse>>; selected: string | null; onSelect: (n: string) => void; system: System | undefined; hostname?: string }) {
  return (
    <nav>
      <div className="brand">▲ Trema<small>{hostname ?? ""}</small></div>
      <div className="section">Apps <Refreshing on={apps.refreshing} /></div>
      <div className="apps">
        {apps.loading && [0, 1, 2].map((i) => <div key={i} className="app-item"><Skeleton h={16} /></div>)}
        {apps.error && !apps.data && <ErrorBox error={apps.error} onRetry={apps.reload} />}
        {apps.data?.apps.map((a) => (
          <button key={a.name} className={`app-item ${a.name === selected ? "active" : ""}`} onClick={() => onSelect(a.name)}>
            <StatusDot status={a.status} busy={a.busy} /><span>{a.name}</span>
          </button>
        ))}
        {apps.data && !apps.data.apps.length && <p className="mut pad">Aucune app. Créez-en une avec <code>trema init</code>.</p>}
      </div>
      <div className="vm">
        <div className="section">Serveur</div>
        {system ? (
          <>
            <Gauge label="CPU" pct={system.cpu} />
            <Gauge label="RAM" pct={system.mem ? percent(system.mem.used, system.mem.total) : null} detail={system.mem ? `${formatBytes(system.mem.used)} / ${formatBytes(system.mem.total)}` : undefined} />
            <Gauge label="Disque" pct={system.disk ? percent(system.disk.used, system.disk.total) : null} detail={system.disk ? `${formatBytes(system.disk.used)} / ${formatBytes(system.disk.total)}` : undefined} />
          </>
        ) : <div className="stack"><Skeleton h={22} /><Skeleton h={22} /><Skeleton h={22} /></div>}
      </div>
    </nav>
  );
}

export function App() {
  const toast = useToast();
  const [route, go] = useRoute();
  const apps = useResource<AppsResponse>("apps", () => api("apps"), 10_000);
  const sys = useResource<System>("system", () => api("system"), 10_000);
  const { jobs, track, restore, dismiss } = useJobs((j) => {
    toast(j.state === "ok" ? "ok" : "error", `${j.app} : ${j.action} ${j.state === "ok" ? "terminé" : "échoué"}`);
    apps.reload();
  });
  const [confirm, setConfirm] = useState<null | "stop" | "redeploy">(null);
  const [pending, setPending] = useState<string | null>(null);

  const app: AppInfo | undefined = apps.data?.apps.find((a) => a.name === route.app);
  useEffect(() => { if (route.app) restore(route.app); }, [route.app, restore]);
  // default to the first app
  useEffect(() => { if (!route.app && apps.data?.apps.length) go({ app: apps.data.apps[0].name, tab: "overview" }); }, [route.app, apps.data]); // eslint-disable-line

  const job = route.app ? jobs[route.app] : undefined;
  const busy = job?.state === "running" || !!app?.busy;

  const act = useCallback(async (action: "start" | "stop" | "restart" | "redeploy") => {
    if (!route.app) return;
    setPending(action);
    try {
      const r = await api<{ job: any }>(appPath(route.app, action), { method: "POST" });
      track(r.job); apps.reload();
    } catch (e) {
      toast("error", e instanceof ApiError && e.status === 409 ? "Une action est déjà en cours sur cette app" : (e as Error).message);
    } finally { setPending(null); setConfirm(null); }
  }, [route.app, track, apps, toast]);

  return (
    <div className="shell">
      <Sidebar apps={apps} selected={route.app} onSelect={(n) => go({ app: n, tab: route.tab })} system={sys.data} hostname={sys.data?.hostname} />
      <main>
        {apps.data && !apps.data.dockerOk && <div className="banner error">Docker est injoignable : les statuts et les stats ne sont pas à jour.</div>}
        {!route.app || !app ? (
          apps.loading ? <Skeleton h={40} w={300} /> : <div className="empty big"><p>{route.app ? `L'app « ${route.app} » n'existe pas.` : "Choisissez une app dans la barre latérale."}</p></div>
        ) : (
          <>
            <header className="app-head">
              <div>
                <h1>{app.name} <StatusPill status={app.status} busy={busy} /></h1>
                {app.url ? <a href={app.url} target="_blank" rel="noreferrer noopener">{app.url.replace(/^https:\/\//, "")} ↗</a> : <span className="mut">Pas d'URL publique</span>}
              </div>
              <div className="actions">
                <button disabled={busy || !!pending} onClick={() => act("start")}>{pending === "start" ? "…" : "Démarrer"}</button>
                <button disabled={busy || !!pending} onClick={() => act("restart")}>{pending === "restart" ? "…" : "Redémarrer"}</button>
                <button className="danger" disabled={busy || !!pending} onClick={() => setConfirm("stop")}>Arrêter</button>
                <button className="primary" disabled={busy || !!pending} onClick={() => setConfirm("redeploy")}>Redéployer</button>
              </div>
            </header>
            {job && <JobBanner job={job} onDismiss={() => dismiss(app.name)} />}
            <div className="tabs" role="tablist">
              {TABS.map((t) => <a key={t} role="tab" aria-selected={t === route.tab} className={t === route.tab ? "active" : ""} href={buildHash({ app: app.name, tab: t })}>{TAB_LABEL[t]}</a>)}
            </div>
            {route.tab === "overview" && <Overview app={app.name} dockerOk={apps.data?.dockerOk ?? true} />}
            {route.tab === "logs" && <Logs app={app.name} />}
            {route.tab === "env" && <Env app={app.name} busy={busy} onRedeploy={track} />}
            {route.tab === "deploys" && <Deploys app={app.name} />}
          </>
        )}
      </main>
      {confirm === "stop" && <Confirm danger title={`Arrêter ${route.app} ?`} text="L'app ne répondra plus tant qu'elle n'est pas redémarrée." confirm="Arrêter" onNo={() => setConfirm(null)} onYes={() => act("stop")} />}
      {confirm === "redeploy" && <Confirm title={`Redéployer ${route.app} ?`} text="Les conteneurs sont reconstruits et recréés avec le .env actuel (quelques minutes)." confirm="Redéployer" onNo={() => setConfirm(null)} onYes={() => act("redeploy")} />}
    </div>
  );
}
