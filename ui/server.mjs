// Trema dashboard server. No dependencies. Binds to 127.0.0.1 only (public HTTPS via nginx + login; TREMA_DEV=1 skips the login on loopback).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawn } from "node:child_process";
import { securityStatus, isValidAppName, parseEnv, applyEnvPatch, formatDeployLine, parseDeploys, parseDockerPs, appStatus, isSecretKey,
  parseNginxUrl, parseMeminfo, parseDf, parseCpuTimes, cpuPercent, validateNewAppName, mergeAppNames, localCommands } from "./lib.mjs";
import { provisionApp } from "./provision.mjs";
import { verifySignature, appJwt, appManifest, createStateStore, validateSource, selectApps, gitAuthHeader } from "./github.mjs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { MAX_UPLOAD, dumpStamp, dumpFileName, isValidDumpFile, parseDumpFile, uploadExt, detectFormat, planSteps, STEP_LABEL, MODES,
  dumpScript, dropSchemaScript, restoreScript } from "./dbdump.mjs";
import { verifyPassword, verifyTotp, makeSession, checkSession, parseCookies, createThrottle, formatAudit } from "./auth.mjs";

const HOME = process.env.TREMA_HOME || process.env.HOME;
const APPS = path.join(HOME, "apps");
const PORT = Number(process.env.PORT || 4000);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const NGINX_SITES = process.env.TREMA_NGINX_SITES || "/etc/nginx/trema.d";
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

const sh = (cmd, args, opts = {}) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { maxBuffer: 10e6, ...opts }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))),
  );

const appDir = (n) => path.join(APPS, n);
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req, max = 10e6) =>
  new Promise((r) => {
    let b = "", n = 0;
    req.on("data", (c) => { n += c.length; if (n <= max) b += c; });
    req.on("end", () => r(n > max ? null : b));
  });

// ---- Collector: polls Docker + VM every ~5 s; GET endpoints answer from memory. ----
const cache = { ps: [], stats: [], dockerOk: null, system: null, at: 0 };
let prevCpu = null;

async function collectSystem() {
  const cpuNow = parseCpuTimes(read("/proc/stat"));
  const cpu = cpuPercent(prevCpu, cpuNow);
  prevCpu = cpuNow;
  let mem = parseMeminfo(read("/proc/meminfo"));
  if (!mem) mem = { total: os.totalmem(), used: os.totalmem() - os.freemem() };
  let disk = null;
  try { disk = parseDf(await sh("df", ["-kP", "/"])); } catch {}
  return { cpu: cpu ?? Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 1000) / 10), mem, disk };
}

async function collect() {
  try {
    cache.ps = parseDockerPs(await sh("docker", ["ps", "-a", "--format", "{{json .}}"]));
    cache.dockerOk = true;
    const out = await sh("docker", ["stats", "--no-stream", "--format", "{{json .}}"]).catch(() => "");
    cache.stats = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { cache.dockerOk = false; }
  cache.system = await collectSystem().catch(() => cache.system);
  cache.at = Date.now();
}
let collecting = false;
const tick = async () => { if (collecting) return; collecting = true; try { await collect(); } finally { collecting = false; } };

function appUrl(name) {
  const sub = name.replace(/_/g, "-");
  return parseNginxUrl(read(path.join(NGINX_SITES, sub)));
}
const REPOS = path.join(HOME, "repos");
const DUMPS = process.env.TREMA_DUMPS || "/db_dumps";
const HOOKS_DIR = process.env.TREMA_HOOKS || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks");
const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter(isValidAppName) : []);
const allApps = () => mergeAppNames(dirs(REPOS), dirs(APPS));
// ---- GitHub source (T-13): per-app config in ~/trema-ui/sources/<app>.json, App credentials in github-app.json/.pem ----
const UI_DIR = path.join(HOME, "trema-ui");
const SOURCES_DIR = process.env.TREMA_SOURCES || path.join(UI_DIR, "sources");
const GH_APP_FILE = path.join(UI_DIR, "github-app.json");
const GH_PEM_FILE = path.join(UI_DIR, "github-app.pem");
const GH_API = process.env.TREMA_GITHUB_API || "https://api.github.com";
const GH_WEB = process.env.TREMA_GITHUB_WEB || "https://github.com";
const states = createStateStore();
let afterJob = () => {};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const loadSource = (name) => readJson(path.join(SOURCES_DIR, `${name}.json`));
const loadSources = () => Object.fromEntries(allApps().map(({ name }) => [name, loadSource(name)]).filter(([, v]) => v));
const loadGhApp = () => { const a = readJson(GH_APP_FILE); return a?.appId && a.webhookSecret && fs.existsSync(GH_PEM_FILE) ? a : null; };
// Directory docker compose runs in: the app's root directory (monorepo) or the app folder.
const composeDir = (name) => path.join(appDir(name), loadSource(name)?.rootDir ?? "");
const composeEnv = (name) => (loadSource(name)?.rootDir ? { ...process.env, COMPOSE_PROJECT_NAME: name } : process.env);

async function ghFetch(pathname, { method = "GET", token, body } = {}) {
  const r = await fetch(`${GH_API}${pathname}`, { method, headers: { accept: "application/vnd.github+json", "user-agent": "trema", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.message ?? `GitHub HTTP ${r.status}`);
  return data;
}
const ghAsApp = (ghApp) => appJwt(ghApp.appId, fs.readFileSync(GH_PEM_FILE, "utf8"));
const installationToken = async (ghApp, id) => (await ghFetch(`/app/installations/${id}/access_tokens`, { method: "POST", token: ghAsApp(ghApp) })).token;

async function listGhRepos(ghApp) {
  const jwt = ghAsApp(ghApp);
  const out = [];
  for (const inst of await ghFetch("/app/installations", { token: jwt })) {
    const tok = await installationToken(ghApp, inst.id);
    const r = await ghFetch("/installation/repositories?per_page=100", { token: tok });
    for (const x of r.repositories) out.push({ repo: x.full_name, private: x.private, defaultBranch: x.default_branch, installationId: inst.id, account: inst.account?.login });
  }
  return out;
}

// Deploys a GitHub branch: fetch into the existing bare repo, then run the same post-receive hook as `git push trema`.
const pendingGithub = new Map(); // app -> source label (only the latest queued push is kept, Q7)
function githubDeploy(name, source) {
  const ghApp = loadGhApp(), src = loadSource(name);
  if (!ghApp || !src) return { error: "GitHub non configuré pour cette app" };
  const r = startJob(name, "deploy", [], { task: async (push) => {
    const repoDir = path.join(REPOS, name);
    const run = (cmd, args, env = {}) => new Promise((ok) => {
      const p = spawn(cmd, args, { cwd: repoDir, env: { ...process.env, ...env } });
      p.stdout.on("data", push); p.stderr.on("data", push);
      p.on("error", (e) => { push(`error: ${e.message}\n`); ok(false); });
      p.on("close", (code) => ok(code === 0));
    });
    try {
      const tok = await installationToken(ghApp, src.installationId);
      push(`Fetching ${src.repo}@${src.branch}…\n`);
      const head = (await sh("git", ["symbolic-ref", "HEAD"], { cwd: repoDir })).trim();
      const ok = await run("git", ["-c", `http.extraHeader=${gitAuthHeader(tok)}`, "fetch", "--force", `${GH_WEB}/${src.repo}.git`, `refs/heads/${src.branch}:${head}`]);
      if (!ok) return false;
    } catch (e) { push(`error: ${e.message}\n`); return false; }
    return run("bash", [path.join(repoDir, "hooks", "post-receive")], { TREMA_SOURCE: source });
  } });
  if (r.error) { pendingGithub.set(name, source); return { queued: true, job: r.job }; }
  return r;
}
afterJob = (name) => { if (pendingGithub.has(name)) { const s = pendingGithub.get(name); pendingGithub.delete(name); githubDeploy(name, s); } };

const webhookLog = []; // last deliveries (in memory): { date, event, repo, ref, results }
async function handleGithubWebhook(req, res) {
  const raw = await readBody(req, 2e6);
  const ghApp = loadGhApp();
  if (raw === null) return json(res, 413, { error: "too large" });
  if (!ghApp || !verifySignature(ghApp.webhookSecret, raw, req.headers["x-hub-signature-256"])) return json(res, 401, { error: "bad signature" });
  const event = req.headers["x-github-event"];
  if (event === "ping") return json(res, 200, { ok: true });
  if (event !== "push") return json(res, 200, { ignored: event });
  let payload;
  try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: "bad json" }); }
  const results = selectApps(payload, loadSources()).map((d) => {
    if (d.action === "deploy") { const r = githubDeploy(d.app, "github"); return { app: d.app, action: r.error ? "ignored" : "deploy", reason: r.error ?? (r.queued ? "mis en file (déploiement en cours)" : undefined) }; }
    return d;
  });
  webhookLog.unshift({ date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), repo: payload.repository?.full_name, ref: payload.ref, commit: String(payload.after ?? "").slice(0, 7), results });
  webhookLog.length = Math.min(webhookLog.length, 50);
  return json(res, 200, { results });
}

function redirect(res, to) { res.writeHead(302, { location: to }); res.end(); }
// Public callbacks (no session: the cookie is SameSite=Strict), protected by a single-use `state`.
async function handleGithubCallback(url, res) {
  const kind = url.pathname.endsWith("/manifest") ? "manifest" : "install";
  if (!states.consume(url.searchParams.get("state"), kind)) return json(res, 400, { error: "invalid or expired state" });
  if (kind === "install") return redirect(res, "/");
  const code = url.searchParams.get("code");
  if (!/^[A-Za-z0-9_-]+$/.test(code ?? "")) return json(res, 400, { error: "bad code" });
  try {
    const a = await ghFetch(`/app-manifests/${code}/conversions`, { method: "POST" });
    fs.mkdirSync(UI_DIR, { recursive: true });
    fs.writeFileSync(GH_PEM_FILE, a.pem, { mode: 0o600 });
    fs.writeFileSync(GH_APP_FILE, JSON.stringify({ appId: a.id, slug: a.slug, webhookSecret: a.webhook_secret, htmlUrl: a.html_url }, null, 2), { mode: 0o600 });
  } catch (e) { return json(res, 502, { error: e.message }); }
  redirect(res, "/");
}

async function handleGithubApi(parts, req, res) {
  const ghApp = loadGhApp();
  if (parts[2] === "status") return json(res, 200, { configured: !!ghApp, slug: ghApp?.slug ?? null, htmlUrl: ghApp?.htmlUrl ?? null, webhookUrl: `https://trema.${serverHost()}/api/hooks/github`, deliveries: webhookLog });
  if (parts[2] === "app" && req.method === "POST") {
    if (ghApp) return json(res, 409, { error: "L'App GitHub existe déjà." });
    return json(res, 200, { action: `${GH_WEB}/settings/apps/new?state=${states.issue("manifest")}`, manifest: appManifest(serverHost()) });
  }
  if (!ghApp) return json(res, 409, { error: "GitHub App non créée" });
  if (parts[2] === "install" && req.method === "POST") return json(res, 200, { url: `${GH_WEB}/apps/${ghApp.slug}/installations/new?state=${states.issue("install")}` });
  if (parts[2] === "repos") return json(res, 200, await listGhRepos(ghApp));
  if (parts[2] === "branches") {
    const u = new URL(req.url, "http://x");
    const repo = u.searchParams.get("repo");
    const r = (await listGhRepos(ghApp)).find((x) => x.repo === repo);
    if (!r) return json(res, 404, { error: "dépôt non installé" });
    const tok = await installationToken(ghApp, r.installationId);
    return json(res, 200, (await ghFetch(`/repos/${repo}/branches?per_page=100`, { token: tok })).map((b) => b.name));
  }
  return json(res, 404, { error: "not found" });
}

const containersOf = (name) => cache.ps.filter((c) => c.project === name);

function listApps() {
  return allApps().map(({ name, deployed }) => {
    const cs = containersOf(name);
    const job = lastJob(name);
    const status = !deployed ? "pending" : cache.dockerOk === false ? "unknown" : appStatus(cs);
    return { name, status, busy: job?.state === "running", url: appUrl(name), hasDb: cs.some((c) => c.service === "db") };
  });
}

// ---- Jobs: long actions run in the background, output kept in memory, streamed over SSE. ----
const jobs = new Map(); // id -> job
const lastByApp = new Map();
const lastJob = (name) => jobs.get(lastByApp.get(name));
const jobView = (j, withOutput = true) => ({ id: j.id, app: j.app, action: j.action, state: j.state, startedAt: j.startedAt, endedAt: j.endedAt, ...(withOutput ? { output: j.output } : {}) });

function startJob(name, action, argsList, { logDeploy = false, task = null } = {}) {
  const running = lastJob(name);
  if (running?.state === "running") return { error: "an action is already running for this app", job: running };
  const job = { id: Math.random().toString(36).slice(2, 10), app: name, action, state: "running", startedAt: Date.now(), endedAt: null, output: "", subs: new Set() };
  jobs.set(job.id, job); lastByApp.set(name, job.id);
  const emit = (ev, data) => job.subs.forEach((r) => r.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
  const push = (c) => { const t = String(c); job.output = (job.output + t).slice(-100_000); emit("out", t); };
  (async () => {
    let ok = true;
    if (task) ok = await task(push);
    else for (const args of argsList) {
      ok = await new Promise((res) => {
        const p = spawn("docker", ["compose", ...args], { cwd: composeDir(name), env: composeEnv(name) });
        p.stdout.on("data", push); p.stderr.on("data", push);
        p.on("error", (e) => { push(`error: ${e.message}\n`); res(false); });
        p.on("close", (code) => res(code === 0));
      });
      if (!ok) break;
    }
    job.state = ok ? "ok" : "failed"; job.endedAt = Date.now();
    if (logDeploy && fs.existsSync(appDir(name))) fs.appendFileSync(path.join(appDir(name), "deploys.log"), formatDeployLine({
      date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), commit: "env", duration: Math.round((job.endedAt - job.startedAt) / 1000), result: ok ? "ok" : "failed", message: "Redéploiement (variables d'env)", source: "manual" }) + "\n");
    emit("done", jobView(job, false)); job.subs.forEach((r) => r.end()); job.subs.clear();
    tick();
    afterJob(name);
    // keep only the 50 latest jobs
    if (jobs.size > 50) for (const id of jobs.keys()) { if (jobs.size <= 50) break; if (jobs.get(id).state !== "running") jobs.delete(id); }
  })();
  return { job };
}


const LOOPBACK_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const AUTH_FILE = process.env.TREMA_AUTH || path.join(HOME, "trema-ui", "auth.json");
const AUDIT_FILE = process.env.TREMA_AUDIT || path.join(HOME, "trema-ui", "audit.log");
const SESSION_COOKIE = "trema_session";
const throttle = createThrottle();
const revoked = new Set();
let lastTotpStep = -1;

const loadAuth = () => {
  try { const a = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")); return a.domain && a.hash && a.totp && a.sessionKey ? a : null; } catch { return null; }
};
const audit = (ip, event, detail) => {
  try { fs.appendFileSync(AUDIT_FILE, formatAudit({ date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), ip, event, detail }) + "\n", { mode: 0o600 }); } catch {}
};
const clientIp = (req) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",")[0].trim();
// Login is required everywhere, except in explicit dev mode (TREMA_DEV=1) for direct loopback requests (not via nginx).
const DEV = process.env.TREMA_DEV === "1";
const isTunnel = (req) => DEV && LOOPBACK_HOSTS.includes(req.headers.host ?? "") && !req.headers["x-forwarded-for"] && !req.headers["x-forwarded-host"];
const setCookie = (res, value, maxAge) =>
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);

async function handleLogin(req, res, auth, ip) {
  const wait = throttle.wait(ip);
  if (wait) { audit(ip, "login_blocked"); return json(res, 429, { error: `Trop de tentatives — réessayez dans ${Math.ceil(wait / 1000)} s.` }); }
  let b = {};
  try { b = JSON.parse(await readBody(req)); } catch {}
  const pwOk = verifyPassword(b.password, auth.hash);
  const step = verifyTotp(auth.totp, b.code, Date.now(), lastTotpStep);
  await new Promise((r) => setTimeout(r, 500)); // server-side delay
  if (!pwOk || step === null) {
    throttle.fail(ip); audit(ip, "login_failed");
    return json(res, 401, { error: "Identifiants incorrects." });
  }
  lastTotpStep = step; throttle.ok(ip); audit(ip, "login_ok");
  setCookie(res, makeSession(auth.sessionKey), 7 * 24 * 3600);
  return json(res, 200, { ok: true });
}

function serverHost() {
  if (process.env.TREMA_HOST) return process.env.TREMA_HOST;
  const d = loadAuth()?.domain;
  return d ? d.replace(/^trema\./, "") : os.hostname();
}

// Read-only: who runs the service, whether root SSH login is off, which root helper scripts exist.
function security() {
  const sshd = [process.env.TREMA_SSHD_CONFIG || "/etc/ssh/sshd_config"];
  const dir = process.env.TREMA_SSHD_DIR || "/etc/ssh/sshd_config.d";
  try { sshd.unshift(...fs.readdirSync(dir).filter((f) => f.endsWith(".conf")).sort().map((f) => path.join(dir, f))); } catch {}
  const texts = sshd.map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }).filter((t) => t !== null);
  const sbin = process.env.TREMA_SBIN || "/usr/local/sbin";
  return securityStatus({
    uid: process.getuid?.() ?? 0, user: os.userInfo().username,
    sshdConfig: texts.length ? texts.join("\n") : null,
    scripts: ["trema-nginx-reload", "trema-cert"].filter((n) => fs.existsSync(path.join(sbin, n))),
  });
}

// Creates (or retries) the server side of an app: bare repo, hook, nginx vhost, certificate.
async function createApp(req, res) {
  let name;
  try { name = JSON.parse(await readBody(req)).name; } catch {}
  const err = validateNewAppName(name);
  if (err) return json(res, 400, { error: err });
  const known = allApps().find((a) => a.name === name);
  if (known?.deployed) return json(res, 409, { error: "Cette app existe déjà." });
  const run = (push) => (cmd, args) => new Promise((ok) => {
    const p = spawn(cmd, args);
    p.stdout.on("data", push); p.stderr.on("data", push);
    p.on("error", (e) => { push(`error: ${e.message}\n`); ok(false); });
    p.on("close", (code) => ok(code === 0));
  });
  const r = startJob(name, "create", [], {
    task: (push) => provisionApp({ home: HOME, name, host: serverHost(), nginxSites: NGINX_SITES, hooksDir: HOOKS_DIR, run: run(push), push }),
  });
  return r.error ? json(res, 409, { error: r.error, job: jobView(r.job, false) }) : json(res, 202, { job: jobView(r.job, false) });
}

// ---- Database dumps (T-18): pg_dump / restore run inside the app's `db` compose service; files live in DUMPS. ----
const dbRun = (push, name, script, { stdin = null, stdout = null } = {}) => new Promise((ok) => {
  const p = spawn("docker", ["compose", "exec", "-T", "db", "sh", "-c", script], { cwd: composeDir(name), env: composeEnv(name) });
  p.stdout.on("data", (c) => { if (!stdout) push(c); });
  p.stderr.on("data", push);
  p.on("error", (e) => { push(`error: ${e.message}\n`); ok(false); });
  let piped = Promise.resolve();
  if (stdout) piped = pipeline(p.stdout, stdout).catch((e) => { push(`error: ${e.message}\n`); p.kill(); });
  let inErr = null;
  if (stdin) pipeline(stdin, p.stdin).catch((e) => { inErr = e; push(`error: flux d'entrée interrompu (${e.message})\n`); p.kill(); }); else p.stdin.end();
  p.on("close", async (code) => { await piped; ok(code === 0 && !inErr); });
});
const compose = (push, name, args) => new Promise((ok) => {
  const p = spawn("docker", ["compose", ...args], { cwd: composeDir(name), env: composeEnv(name) });
  p.stdout.on("data", push); p.stderr.on("data", push);
  p.on("error", (e) => { push(`error: ${e.message}\n`); ok(false); });
  p.on("close", (code) => ok(code === 0));
});
const hasDb = (name) => containersOf(name).some((c) => c.service === "db");

function listDumps(name) {
  let files = [];
  try { files = fs.readdirSync(DUMPS); } catch {}
  return files.map((f) => ({ d: parseDumpFile(name, f), f })).filter((x) => x.d).map(({ d, f }) => {
    const st = fs.statSync(path.join(DUMPS, f));
    return { file: f, size: st.size, date: st.mtime.toISOString().replace(/\.\d+Z$/, "Z"), origin: d.origin };
  }).sort((a, b) => b.file.localeCompare(a.file));
}

function readHead(file, n = 4096) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(n); return b.subarray(0, fs.readSync(fd, b, 0, n, 0)); } finally { fs.closeSync(fd); }
}

// Unique, never-overwriting name: bump the stamp by one second until the file (and its .part) are free.
const reserved = new Set();
function freshName(app, kind = "manual", ext = "dump") {
  for (let t = Date.now(); ; t += 1000) {
    const file = dumpFileName(app, dumpStamp(new Date(t)), kind, ext), dest = path.join(DUMPS, file);
    if (reserved.has(file) || fs.existsSync(dest) || fs.existsSync(`${dest}.part`)) continue;
    reserved.add(file); setTimeout(() => reserved.delete(file), 60000).unref();
    return file;
  }
}

async function makeDump(push, name, file) {
  const dest = path.join(DUMPS, file), tmp = `${dest}.part`;
  try { fs.mkdirSync(DUMPS, { recursive: true }); } catch {}
  push(`pg_dump -Fc → ${dest}\n`);
  const ok = await dbRun(push, name, dumpScript(), { stdout: fs.createWriteStream(tmp, { mode: 0o644 }) });
  if (!ok) { fs.rmSync(tmp, { force: true }); return false; }
  if (fs.existsSync(dest)) { fs.rmSync(tmp, { force: true }); push(`error: ${file} existe déjà, refus de l'écraser\n`); return false; }
  fs.renameSync(tmp, dest);
  push(`${(fs.statSync(dest).size / 1e6).toFixed(1)} Mo écrits\n`);
  return true;
}

async function restoreDump(push, name, file, mode) {
  const src = path.join(DUMPS, file);
  const head = detectFormat(readHead(src));
  if (!head) { push("error: format de dump non reconnu\n"); return false; }
  const format = head === "custom" ? "custom" : "sql";
  const input = () => head === "gzip" ? fs.createReadStream(src).pipe(zlib.createGunzip()) : fs.createReadStream(src);
  const safety = freshName(name, "pre-restore");
  push(`Format détecté : ${head} · mode : ${mode === "full" ? "remplacer tout" : "données seulement"}\n`);
  let webStopped = false, ok = true, safetyDone = false;
  const steps = planSteps(mode);
  for (const step of steps) {
    push(`\n${STEP_LABEL[step]}\n`);
    if (step === "safety-dump") { ok = safetyDone = await makeDump(push, name, safety); }
    else if (step === "stop-web") { ok = await compose(push, name, ["stop", "web"]); webStopped = true; }
    else if (step === "drop-schema") ok = await dbRun(push, name, dropSchemaScript());
    else if (step === "restore" || step === "load-data") ok = await dbRun(push, name, restoreScript(mode, format), { stdin: input() });
    else if (step === "migrate") ok = await compose(push, name, ["run", "--rm", "web", "bin/rails", "db:prepare"]);
    else if (step === "start-web") { ok = await compose(push, name, ["start", "web"]); }
    if (!ok) break;
  }
  if (!ok) {
    // The web must come back whatever happened.
    if (webStopped) await compose(push, name, ["start", "web"]);
    push(`\n✕ Échec. ${safetyDone ? `Dump de sécurité à restaurer : ${safety}` : "Aucun dump de sécurité n'a été créé : la base n'a pas été modifiée."}\n`);
  }
  return ok;
}

async function receiveUpload(name, req, res, url) {
  const ext = uploadExt(url.searchParams.get("name"));
  if (!ext) return json(res, 400, { error: "Extension non supportée (.dump, .sql, .sql.gz)." });
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > MAX_UPLOAD) return json(res, 413, { error: `Fichier trop gros (max ${MAX_UPLOAD / 1048576} Mo).` });
  fs.mkdirSync(DUMPS, { recursive: true });
  const file = freshName(name, "upload", ext);
  const dest = path.join(DUMPS, file), tmp = `${dest}.part`;
  let n = 0;
  const limit = async function* (src) { for await (const c of src) { n += c.length; if (n > MAX_UPLOAD) throw new Error("too large"); yield c; } };
  try { await pipeline(req, limit, fs.createWriteStream(tmp, { mode: 0o644 })); }
  catch (e) { fs.rmSync(tmp, { force: true }); return json(res, e.message === "too large" ? 413 : 400, { error: e.message === "too large" ? `Fichier trop gros (max ${MAX_UPLOAD / 1048576} Mo).` : e.message }); }
  const format = n ? detectFormat(readHead(tmp)) : null;
  if (!format || (ext === "dump" && format !== "custom") || (ext === "sql.gz" && format !== "gzip") || (ext === "sql" && format !== "sql")) {
    fs.rmSync(tmp, { force: true });
    return json(res, 400, { error: "Le contenu ne correspond pas à l'extension (format non reconnu)." });
  }
  if (fs.existsSync(dest)) { fs.rmSync(tmp, { force: true }); return json(res, 409, { error: "Un dump portant ce nom existe déjà, réessayez." }); }
  fs.renameSync(tmp, dest);
  return json(res, 201, { file, size: n, format });
}

async function handleDb(name, parts, req, res, url, ip) {
  if (!hasDb(name)) return json(res, 409, { error: "Cette app n'a pas de conteneur db." });
  const what = parts[4], f = parts[5];
  if (what === "dumps" && !f && req.method === "GET") return json(res, 200, listDumps(name));
  if (what === "dumps" && !f && req.method === "POST") {
    const file = freshName(name);
    const r = startJob(name, "db-dump", [], { task: (push) => makeDump(push, name, file) });
    return r.error ? json(res, 409, { error: r.error, job: jobView(r.job, false) }) : json(res, 202, { job: jobView(r.job, false), file });
  }
  if (what === "dumps" && f && req.method === "GET") {
    if (!parseDumpFile(name, f) || !fs.existsSync(path.join(DUMPS, f))) return json(res, 404, { error: "not found" });
    audit(ip, "db_download", `${name} ${f}`);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fs.statSync(path.join(DUMPS, f)).size, "content-disposition": `attachment; filename="${f}"` });
    return fs.createReadStream(path.join(DUMPS, f)).pipe(res);
  }
  if (what === "upload" && req.method === "POST") return receiveUpload(name, req, res, url);
  if (what === "restore" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    if (!MODES.includes(b.mode)) return json(res, 400, { error: "mode inconnu" });
    if (b.confirm !== name) return json(res, 400, { error: "Confirmation incorrecte (tapez le nom de l'app)." });
    if (!parseDumpFile(name, b.file) || !fs.existsSync(path.join(DUMPS, b.file))) return json(res, 404, { error: "dump introuvable" });
    audit(ip, "db_restore", `${name} ${b.file} ${b.mode}`);
    const r = startJob(name, "db-restore", [], { task: (push) => restoreDump(push, name, b.file, b.mode) });
    return r.error ? json(res, 409, { error: r.error, job: jobView(r.job, false) }) : json(res, 202, { job: jobView(r.job, false) });
  }
  return json(res, 404, { error: "not found" });
}

async function route(req, res) {
  const auth = loadAuth();
  const ALLOWED_HOSTS = new Set(auth ? [...LOOPBACK_HOSTS, auth.domain] : LOOPBACK_HOSTS);
  // Anti DNS-rebinding: only accept loopback or the configured public domain as Host.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return json(res, 403, { error: "forbidden host" });
  const pubPath = new URL(req.url, "http://x").pathname;
  if (pubPath === "/api/hooks/github" && req.method === "POST") return handleGithubWebhook(req, res);
  const tunnel = isTunnel(req);
  const ip = tunnel ? "tunnel" : clientIp(req);
  // Anti CSRF: mutating requests must be JSON (forces a CORS preflight) and not cross-site.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(new URL(origin).host)) return json(res, 403, { error: "forbidden origin" });
    // Dump upload (T-18) is the only route accepting a binary body; it still requires X-Trema (forces a CORS preflight).
    const upload = req.method === "POST" && /^\/api\/apps\/[^/]+\/db\/upload$/.test(pubPath);
    const ctype = String(req.headers["content-type"] ?? "");
    if (!(ctype.startsWith("application/json") || (upload && ctype.startsWith("application/octet-stream"))) || req.headers["x-trema"] !== "1")
      return json(res, 403, { error: "missing headers" });
  }
  let session = null;
  if (!tunnel) {
    if (!auth || req.headers.host !== auth.domain) return json(res, 403, { error: "forbidden host" });
    session = checkSession(auth.sessionKey, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (session && revoked.has(session.id)) session = null;
    if (session?.renew) setCookie(res, makeSession(auth.sessionKey, Date.now(), session.id), 7 * 24 * 3600);
    const u = new URL(req.url, "http://x").pathname;
    if (u === "/api/login" && req.method === "POST") return handleLogin(req, res, auth, ip);
    if (u === "/api/logout" && req.method === "POST") {
      if (session) revoked.add(session.id);
      audit(ip, "logout"); setCookie(res, "", 0);
      return json(res, 200, { ok: true });
    }
    if (!session && req.method === "GET" && (u === "/api/github/callback/manifest" || u === "/api/github/callback/install")) return handleGithubCallback(new URL(req.url, "http://x"), res);
    if (!session) {
      if (u === "/" || u === "/login.html") return serveLogin(res);
      return json(res, 401, { error: "unauthorized" });
    }
  }
  const url = new URL(req.url, "http://x");
  if (req.method !== "GET" && req.method !== "HEAD") audit(ip, "action", `${req.method} ${url.pathname}`);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return serveStatic(url.pathname, res);
  if (parts[1] === "github") {
    if (req.method === "GET" && parts[2] === "callback") return handleGithubCallback(url, res); // tunnel (dev) only; public goes through the branch above
    return handleGithubApi(parts, req, res);
  }
  if (parts[1] === "me") return json(res, 200, { public: !tunnel });
  if (parts[1] === "apps" && parts.length === 2 && req.method === "GET") return json(res, 200, { dockerOk: cache.dockerOk !== false, apps: listApps() });
  if (parts[1] === "system" && parts.length === 2) return json(res, 200, { ...cache.system, hostname: os.hostname(), at: cache.at, dockerOk: cache.dockerOk !== false });
  if (parts[1] === "security" && parts.length === 2 && req.method === "GET") return json(res, 200, security());
  if (parts[1] === "jobs" && parts[2]) {
    const job = jobs.get(parts[2]);
    if (!job) return json(res, 404, { error: "not found" });
    if (parts[3] !== "stream") return json(res, 200, jobView(job));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`event: init\ndata: ${JSON.stringify(jobView(job))}\n\n`);
    if (job.state !== "running") return res.end();
    job.subs.add(res);
    // Heartbeat: keeps the stream alive through nginx (proxy_read_timeout 60 s by default).
    const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => { clearInterval(beat); job.subs.delete(res); });
    res.on("close", () => clearInterval(beat));
    return;
  }
  const name = parts[2];
  if (parts[1] === "apps" && parts.length === 2 && req.method === "POST") return createApp(req, res);
  const sub = parts[3];
  const known = parts[1] === "apps" && isValidAppName(name) && (fs.existsSync(appDir(name)) || (["setup", "job", "deploys", "stats", "source"].includes(sub) && fs.existsSync(path.join(REPOS, name))));
  if (!known) return json(res, 404, { error: "not found" });
  const envFile = path.join(composeDir(name), ".env");

  if (sub === "setup" && req.method === "GET") {
    const host = serverHost();
    return json(res, 200, { host, domain: `${name.replace(/_/g, "-")}.${host}`, commands: localCommands(name, os.userInfo().username, host) });
  }
  if (sub === "env" && !parts[4] && req.method === "GET") {
    // Values never leave the server unless requested one by one (GET /env/:key).
    return json(res, 200, parseEnv(read(envFile)).map(({ key }) => ({ key, sensitive: isSecretKey(key) })));
  }
  if (sub === "env" && parts[4] && req.method === "GET") {
    const e = parseEnv(read(envFile)).find((x) => x.key === parts[4]);
    return e ? json(res, 200, { key: e.key, value: e.value }) : json(res, 404, { error: "not found" });
  }
  if (sub === "env" && req.method === "PATCH") {
    let text, body;
    try { body = JSON.parse(await readBody(req)); text = applyEnvPatch(read(envFile), body); } catch (e) { return json(res, 400, { error: e.message }); }
    fs.writeFileSync(envFile, text);
    if (body.redeploy === false) return json(res, 200, { ok: true });
    const r = startJob(name, "redeploy", [["--env-file", ".env", "up", "--build", "--force-recreate", "-d"]], { logDeploy: true });
    return r.error ? json(res, 409, { error: r.error, job: jobView(r.job, false) }) : json(res, 202, { job: jobView(r.job, false) });
  }
  if (sub === "source") {
    if (!req.method.match(/^(GET|PUT|POST)$/)) return json(res, 405, { error: "method not allowed" });
    if (parts[4] === "deploy" && req.method === "POST") {
      const r = githubDeploy(name, "manual");
      if (r.error && !r.job) return json(res, 409, { error: r.error });
      return json(res, 202, { queued: !!r.queued, job: jobView(r.job, false) });
    }
    if (req.method === "GET") return json(res, 200, loadSource(name));
    if (req.method === "PUT") {
      let cfg;
      try { cfg = validateSource(JSON.parse(await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); }
      if (cfg.rootDir && !fs.existsSync(path.join(REPOS, name))) return json(res, 409, { error: "repo not ready" });
      fs.mkdirSync(SOURCES_DIR, { recursive: true });
      fs.writeFileSync(path.join(SOURCES_DIR, `${name}.json`), JSON.stringify(cfg, null, 2));
      // The hook reads the root directory from the bare repo, so `git push trema` honors it too.
      try { await sh("git", cfg.rootDir ? ["config", "trema.rootdir", cfg.rootDir] : ["config", "--unset-all", "trema.rootdir"], { cwd: path.join(REPOS, name) }); } catch {}
      return json(res, 200, cfg);
    }
  }
  if (sub === "db") return handleDb(name, parts, req, res, url, ip);
  if (sub === "job" && req.method === "GET") {
    const j = lastJob(name);
    return json(res, 200, j ? jobView(j) : null);
  }
  if (sub === "deploys") {
    const f = path.join(appDir(name), "deploys.log");
    return json(res, 200, parseDeploys(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""));
  }
  if (sub === "stats") {
    const mine = new Set(containersOf(name).map((c) => c.name));
    const byName = new Map(cache.stats.map((r) => [r.Name, r]));
    return json(res, 200, containersOf(name).map((c) => ({ name: c.name, state: c.state, cpu: byName.get(c.name)?.CPUPerc ?? null, mem: byName.get(c.name)?.MemUsage ?? null })).filter((c) => mine.has(c.name)));
  }
  if (sub === "logs") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const p = spawn("docker", ["compose", "logs", "-f", "--tail", "200", "--no-color"], { cwd: composeDir(name), env: composeEnv(name) });
    const send = (c) => String(c).split("\n").filter(Boolean).forEach((l) => res.write(`data: ${l}\n\n`));
    p.on("error", (e) => { res.write(`data: error: ${e.message}\n\n`); res.end(); });
    p.stdout.on("data", send); p.stderr.on("data", send);
    req.on("close", () => p.kill());
    return;
  }
  if (req.method === "POST" && ["restart", "stop", "start", "redeploy"].includes(sub)) {
    const args = sub === "redeploy" ? [["--env-file", ".env", "up", "--build", "--force-recreate", "-d"]] : [[sub]];
    const r = startJob(name, sub, args, { logDeploy: sub === "redeploy" });
    return r.error ? json(res, 409, { error: r.error, job: jobView(r.job, false) }) : json(res, 202, { job: jobView(r.job, false) });
  }
  json(res, 404, { error: "not found" });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".map": "application/json" };
function serveLogin(res) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  fs.createReadStream(path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "login.html")).pipe(res);
}

function serveStatic(p, res) {
  let f = path.join(PUBLIC, p === "/" ? "index.html" : path.normalize(p));
  if (!f.startsWith(PUBLIC)) { res.writeHead(404); return res.end("not found"); }
  // SPA fallback (hash routing, so only the root really matters) + clear message if bundle was not built.
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(503); return res.end("UI bundle missing: run 'trema ui:install' (builds ui/web)"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream", ...(f.includes("assets") ? { "cache-control": "public, max-age=31536000, immutable" } : {}) });
  fs.createReadStream(f).pipe(res);
}

http.createServer((req, res) => route(req, res).catch((e) => json(res, 500, { error: e.message })))
  .listen(PORT, "127.0.0.1", () => {
    console.log(`Trema UI on http://127.0.0.1:${PORT}`);
    tick(); setInterval(tick, 5000).unref();
  });
