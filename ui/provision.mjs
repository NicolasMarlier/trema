// Server-side app creation (formerly `trema init`). Every step is idempotent so a failed creation can be retried.
import fs from "node:fs";
import path from "node:path";
import { nginxVhost, subdomainOf } from "./lib.mjs";

/**
 * @param {{home:string,name:string,host:string,nginxSites:string,hooksDir:string,
 *   run:(cmd:string,args:string[],opts?:object)=>Promise<boolean>,push:(s:string)=>void}} o
 * @returns {Promise<boolean>}
 */
export async function provisionApp({ home, name, host, nginxSites, hooksDir, run, push }) {
  const repo = path.join(home, "repos", name);
  const domain = `${subdomainOf(name)}.${host}`;
  const steps = [
    ["Création du repo git", async () => {
      fs.mkdirSync(path.join(home, "repos"), { recursive: true });
      if (fs.existsSync(path.join(repo, "HEAD"))) { push("repo déjà présent\n"); return true; }
      return run("git", ["init", "--initial-branch=main", "--bare", repo]);
    }],
    ["Installation du hook de déploiement", async () => {
      if (!fs.existsSync(hooksDir)) { push(`hooks introuvables (${hooksDir}) : relancez 'trema ui:install'\n`); return false; }
      fs.cpSync(hooksDir, path.join(repo, "hooks"), { recursive: true });
      fs.chmodSync(path.join(repo, "hooks", "post-receive"), 0o755);
      return true;
    }],
    ["Configuration nginx", async () => {
      const f = path.join(nginxSites, subdomainOf(name));
      if (fs.existsSync(f)) { push("vhost déjà présent\n"); return true; }
      fs.writeFileSync(f, nginxVhost(name, host));
      return true;
    }],
    ["Certificat HTTPS (certbot)", () => run("sudo", ["-n", "/usr/local/sbin/trema-cert", domain])],
    ["Rechargement nginx", () => run("sudo", ["-n", "/usr/local/sbin/trema-nginx-reload"])],
  ];
  for (const [i, [label, fn]] of steps.entries()) {
    push(`[${i + 1}/${steps.length}] ${label}\n`);
    let ok = false;
    try { ok = await fn(); } catch (e) { push(`erreur : ${e.message}\n`); }
    if (!ok) { push(`✕ Étape échouée : ${label}\n`); return false; }
  }
  push(`✓ ${name} prêt sur ${domain}\n`);
  return true;
}
