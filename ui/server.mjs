// Trema dashboard server. No dependencies. Binds to 127.0.0.1 only (access via SSH tunnel).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawn } from "node:child_process";
import { isValidAppName, parseEnv, applyEnvPatch, formatDeployLine, parseDeploys, parseDockerPs, appStatus, isSecretKey,
  parseNginxUrl, parseMeminfo, parseDf, parseCpuTimes, cpuPercent } from "./lib.mjs";

const HOME = process.env.TREMA_HOME || process.env.HOME;
const APPS = path.join(HOME, "apps");
const PORT = Number(process.env.PORT || 4000);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const NGINX_SITES = process.env.TREMA_NGINX_SITES || "/etc/nginx/sites-enabled";
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
const readBody = (req) =>
  new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

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
const appNames = () => (fs.existsSync(APPS) ? fs.readdirSync(APPS).filter(isValidAppName) : []);
const containersOf = (name) => cache.ps.filter((c) => c.project === name);

function listApps() {
  return appNames().map((name) => {
    const cs = containersOf(name);
    const job = lastJob(name);
    return { name, status: cache.dockerOk === false ? "unknown" : appStatus(cs), busy: job?.state === "running", url: appUrl(name) };
  });
}

// ---- Jobs: long actions run in the background, output kept in memory, streamed over SSE. ----
const jobs = new Map(); // id -> job
const lastByApp = new Map();
const lastJob = (name) => jobs.get(lastByApp.get(name));
const jobView = (j, withOutput = true) => ({ id: j.id, app: j.app, action: j.action, state: j.state, startedAt: j.startedAt, endedAt: j.endedAt, ...(withOutput ? { output: j.output } : {}) });

function startJob(name, action, argsList, { logDeploy = false } = {}) {
  const running = lastJob(name);
  if (running?.state === "running") return { error: "an action is already running for this app", job: running };
  const job = { id: Math.random().toString(36).slice(2, 10), app: name, action, state: "running", startedAt: Date.now(), endedAt: null, output: "", subs: new Set() };
  jobs.set(job.id, job); lastByApp.set(name, job.id);
  const emit = (ev, data) => job.subs.forEach((r) => r.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
  const push = (c) => { const t = String(c); job.output = (job.output + t).slice(-100_000); emit("out", t); };
  (async () => {
    let ok = true;
    for (const args of argsList) {
      ok = await new Promise((res) => {
        const p = spawn("docker", ["compose", ...args], { cwd: appDir(name) });
        p.stdout.on("data", push); p.stderr.on("data", push);
        p.on("error", (e) => { push(`error: ${e.message}\n`); res(false); });
        p.on("close", (code) => res(code === 0));
      });
      if (!ok) break;
    }
    job.state = ok ? "ok" : "failed"; job.endedAt = Date.now();
    if (logDeploy) fs.appendFileSync(path.join(appDir(name), "deploys.log"), formatDeployLine({
      date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), commit: "env", duration: Math.round((job.endedAt - job.startedAt) / 1000), result: ok ? "ok" : "failed", message: "Redéploiement (variables d'env)" }) + "\n");
    emit("done", jobView(job, false)); job.subs.forEach((r) => r.end()); job.subs.clear();
    tick();
    // keep only the 50 latest jobs
    if (jobs.size > 50) for (const id of jobs.keys()) { if (jobs.size <= 50) break; if (jobs.get(id).state !== "running") jobs.delete(id); }
  })();
  return { job };
}


const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

async function route(req, res) {
  // Anti DNS-rebinding: only accept our loopback Host.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return json(res, 403, { error: "forbidden host" });
  // Anti CSRF: mutating requests must be JSON (forces a CORS preflight) and not cross-site.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(new URL(origin).host)) return json(res, 403, { error: "forbidden origin" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json") || req.headers["x-trema"] !== "1")
      return json(res, 403, { error: "missing headers" });
  }
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return serveStatic(url.pathname, res);
  if (parts[1] === "apps" && parts.length === 2) return json(res, 200, { dockerOk: cache.dockerOk !== false, apps: listApps() });
  if (parts[1] === "system" && parts.length === 2) return json(res, 200, { ...cache.system, hostname: os.hostname(), at: cache.at, dockerOk: cache.dockerOk !== false });
  if (parts[1] === "jobs" && parts[2]) {
    const job = jobs.get(parts[2]);
    if (!job) return json(res, 404, { error: "not found" });
    if (parts[3] !== "stream") return json(res, 200, jobView(job));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`event: init\ndata: ${JSON.stringify(jobView(job))}\n\n`);
    if (job.state !== "running") return res.end();
    job.subs.add(res); req.on("close", () => job.subs.delete(res));
    return;
  }
  const name = parts[2];
  if (parts[1] !== "apps" || !isValidAppName(name) || !fs.existsSync(appDir(name))) return json(res, 404, { error: "not found" });
  const sub = parts[3];
  const envFile = path.join(appDir(name), ".env");

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
    const p = execFile("docker", ["compose", "logs", "-f", "--tail", "200", "--no-color"], { cwd: appDir(name) });
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
