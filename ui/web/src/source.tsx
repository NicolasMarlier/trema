import { useEffect, useState } from "react";
import { api, appPath, ApiError, type GhRepo, type GhStatus, type Job, type Source } from "./api";
import { relativeTime } from "./format";
import { useNow, useResource } from "./useResource";
import { Card, ErrorBox, Skeleton } from "./ui";
import { useToast } from "./toast";

/** Posts the manifest to GitHub (manifest flow: GitHub needs a form POST). */
function submitManifest(action: string, manifest: unknown) {
  const f = document.createElement("form");
  f.method = "post"; f.action = action;
  const i = document.createElement("input");
  i.type = "hidden"; i.name = "manifest"; i.value = JSON.stringify(manifest);
  f.appendChild(i); document.body.appendChild(f); f.submit();
}

export function SourceTab({ app, busy, onDeploy }: { app: string; busy: boolean; onDeploy: (j: Job) => void }) {
  const toast = useToast();
  const gh = useResource<GhStatus>("gh", () => api("github/status"), 30_000);
  const src = useResource<Source | null>(`source:${app}`, () => api(appPath(app, "source")));
  const repos = useResource<GhRepo[]>(gh.data?.configured ? "gh-repos" : "gh-none", () => (gh.data?.configured ? api("github/repos") : Promise.resolve([])));
  const [form, setForm] = useState<Source>({ repo: "", branch: "", rootDir: "", autoDeploy: true, alwaysDeploy: false, installationId: null });
  const [branches, setBranches] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const now = useNow(30_000);
  useEffect(() => { if (src.data) setForm(src.data); }, [src.data]);
  useEffect(() => {
    if (!form.repo || !gh.data?.configured) return;
    api<string[]>(`github/branches?repo=${encodeURIComponent(form.repo)}`).then(setBranches).catch(() => setBranches([]));
  }, [form.repo, gh.data?.configured]);

  const call = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { toast("error", (e as Error).message); } };
  const createApp = () => call(async () => { const r = await api<{ action: string; manifest: unknown }>("github/app", { method: "POST" }); submitManifest(r.action, r.manifest); });
  const install = () => call(async () => { const r = await api<{ url: string }>("github/install", { method: "POST" }); window.location.href = r.url; });
  const pick = (repo: string) => {
    const r = repos.data?.find((x) => x.repo === repo);
    setForm({ ...form, repo, branch: r?.defaultBranch ?? "", installationId: r?.installationId ?? null });
  };
  const save = () => call(async () => {
    setSaving(true);
    try { await api(appPath(app, "source"), { method: "PUT", body: form }); toast("ok", "Source enregistrée"); src.reload(); } finally { setSaving(false); }
  });
  const deployNow = () => call(async () => {
    try {
      const r = await api<{ job: Job; queued: boolean }>(appPath(app, "source/deploy"), { method: "POST" });
      if (r.queued) toast("ok", "Mis en file : sera déployé à la fin du déploiement en cours"); else onDeploy(r.job);
    } catch (e) { throw new Error(e instanceof ApiError ? e.message : String(e)); }
  });

  if (gh.error && !gh.data) return <ErrorBox error={gh.error} onRetry={gh.reload} />;
  if (!gh.data) return <Card title="Source GitHub"><Skeleton h={80} /></Card>;
  const mine = gh.data.deliveries.filter((d) => d.results.some((r) => r.app === app));
  return (
    <>
      <Card title="Source GitHub">
        {!gh.data.configured ? <>
          <p className="mut">Une GitHub App privée, propre à ce Trema, permet de déployer à chaque push (dépôts publics ou privés). Elle se crée en un clic et ne demande que la lecture du contenu.</p>
          <button className="primary" onClick={createApp}>Créer la GitHub App</button>
        </> : <>
          <p className="mut">App : <a href={gh.data.htmlUrl ?? "#"} target="_blank" rel="noreferrer noopener">{gh.data.slug}</a> · webhook <code>{gh.data.webhookUrl}</code> · <button onClick={install}>Installer / choisir des dépôts</button></p>
          <div className="form">
            <label>Dépôt
              <select value={form.repo} onChange={(e) => pick(e.target.value)}>
                <option value="">— choisir —</option>
                {form.repo && !repos.data?.some((r) => r.repo === form.repo) && <option value={form.repo}>{form.repo}</option>}
                {repos.data?.map((r) => <option key={r.repo} value={r.repo}>{r.repo}{r.private ? " 🔒" : ""}</option>)}
              </select>
            </label>
            <label>Branche
              <select value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                {form.branch && !branches.includes(form.branch) && <option value={form.branch}>{form.branch}</option>}
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label>Dossier racine
              <input value={form.rootDir} onChange={(e) => setForm({ ...form, rootDir: e.target.value })} placeholder="(racine du dépôt) ex. backend" />
            </label>
            <label className="check"><input type="checkbox" checked={form.autoDeploy} onChange={(e) => setForm({ ...form, autoDeploy: e.target.checked })} /> Déployer automatiquement à chaque push</label>
            <label className="check"><input type="checkbox" checked={form.alwaysDeploy} disabled={!form.rootDir} onChange={(e) => setForm({ ...form, alwaysDeploy: e.target.checked })} /> Déployer même si le push ne touche pas le dossier racine</label>
            <p className="mut">Tout le dépôt est extrait ; la détection et <code>docker compose</code> (projet <code>{app}</code>) s'exécutent dans le dossier racine. Vaut aussi pour <code>git push trema</code>.</p>
            <div className="actions">
              <button disabled={!form.repo || !form.branch || saving} className="primary" onClick={save}>Enregistrer</button>
              <button disabled={!src.data || busy} onClick={deployNow}>Déployer maintenant</button>
            </div>
          </div>
        </>}
      </Card>
      {gh.data.configured && <Card title="Dernières livraisons">
        {!mine.length ? <div className="empty"><p>Aucun push reçu pour cette app depuis le démarrage de Trema.</p></div> :
          <table>
            <thead><tr><th>Quand</th><th>Branche</th><th>Commit</th><th>Résultat</th></tr></thead>
            <tbody>{mine.map((d) => { const r = d.results.find((x) => x.app === app)!; return (
              <tr key={d.date + d.commit}><td title={d.date}>{relativeTime(d.date, now)}</td><td className="mono">{d.ref.replace("refs/heads/", "")}</td><td className="mono">{d.commit}</td>
                <td><span className={`tag ${r.action === "deploy" ? "ok" : ""}`}>{r.action === "deploy" ? "acceptée" : "ignorée"}</span> {r.reason && <span className="mut">{r.reason}</span>}</td></tr>); })}</tbody>
          </table>}
      </Card>}
    </>
  );
}
