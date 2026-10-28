// Trema dashboard server. No dependencies. Binds to 127.0.0.1 only (SSH tunnel; optional public HTTPS via nginx + login, see auth.mjs).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyPassword, verifyTotp, makeSession, checkSession, parseCookies, createThrottle, formatAudit } from "./auth.mjs";
import { isValidAppName, parseEnv, mergeEnv, formatDeployLine, parseDeploys, parseDockerPs, appStatus } from "./lib.mjs";

const HOME = process.env.TREMA_HOME || process.env.HOME;
const APPS = path.join(HOME, "apps");
const PORT = Number(process.env.PORT || 4000);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

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

async function listApps() {
  const names = fs.existsSync(APPS) ? fs.readdirSync(APPS).filter(isValidAppName) : [];
  let ps = [];
  try { ps = parseDockerPs(await sh("docker", ["ps", "-a", "--format", "{{json .}}"])); } catch {}
  return names.map((name) => ({ name, status: appStatus(ps.filter((c) => c.project === name)) }));
}

const compose = (name, args) => sh("docker", ["compose", ...args], { cwd: appDir(name) });

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
// Requests through nginx carry X-Forwarded-For; only direct loopback requests (SSH tunnel) skip the login.
const isTunnel = (req) => LOOPBACK_HOSTS.includes(req.headers.host ?? "") && !req.headers["x-forwarded-for"] && !req.headers["x-forwarded-host"];
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

async function route(req, res) {
  const auth = loadAuth();
  const ALLOWED_HOSTS = new Set(auth ? [...LOOPBACK_HOSTS, auth.domain] : LOOPBACK_HOSTS);
  // Anti DNS-rebinding: only accept loopback or the configured public domain as Host.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return json(res, 403, { error: "forbidden host" });
  const tunnel = isTunnel(req);
  const ip = tunnel ? "tunnel" : clientIp(req);
  // Anti CSRF: mutating requests must be JSON (forces a CORS preflight) and not cross-site.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(new URL(origin).host)) return json(res, 403, { error: "forbidden origin" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json") || req.headers["x-trema"] !== "1")
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
    if (!session) {
      if (u === "/" || u === "/login.html") return serveStatic("/login.html", res);
      return json(res, 401, { error: "unauthorized" });
    }
  }
  const url = new URL(req.url, "http://x");
  if (req.method !== "GET" && req.method !== "HEAD") audit(ip, "action", `${req.method} ${url.pathname}`);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return serveStatic(url.pathname, res);
  if (parts[1] === "me") return json(res, 200, { public: !tunnel });
  if (parts[1] === "apps" && parts.length === 2) return json(res, 200, await listApps());
  const name = parts[2];
  if (parts[1] !== "apps" || !isValidAppName(name) || !fs.existsSync(appDir(name))) return json(res, 404, { error: "not found" });
  const sub = parts[3];
  const envFile = path.join(appDir(name), ".env");

  if (sub === "env" && req.method === "GET") {
    return json(res, 200, parseEnv(fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : ""));
  }
  if (sub === "env" && req.method === "PUT") {
    let text;
    const old = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    try { text = mergeEnv(old, JSON.parse(await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); }
    fs.writeFileSync(envFile, text);
    const start = Date.now();
    let result = "ok", err;
    try { await compose(name, ["--env-file", ".env", "up", "--build", "--force-recreate", "-d"]); } catch (e) { result = "failed"; err = e; }
    fs.appendFileSync(path.join(appDir(name), "deploys.log"), formatDeployLine({
      date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), commit: "env", duration: Math.round((Date.now() - start) / 1000), result }) + "\n");
    if (err) return json(res, 500, { error: err.message });
    return json(res, 200, { ok: true });
  }
  if (sub === "deploys") {
    const f = path.join(appDir(name), "deploys.log");
    return json(res, 200, parseDeploys(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""));
  }
  if (sub === "stats") {
    let mine = new Set();
    try { mine = new Set(parseDockerPs(await sh("docker", ["ps", "-a", "--format", "{{json .}}"])).filter((c) => c.project === name).map((c) => c.name)); } catch {}
    const out = await sh("docker", ["stats", "--no-stream", "--format", "{{json .}}"]).catch(() => "");
    const rows = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => mine.has(r.Name));
    return json(res, 200, rows.map((r) => ({ name: r.Name, cpu: r.CPUPerc, mem: r.MemUsage })));
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
  if (req.method === "POST" && ["restart", "stop", "start"].includes(sub)) {
    await compose(name, [sub]);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "not found" });
}

function serveStatic(p, res) {
  const f = path.join(PUBLIC, p === "/" ? "index.html" : path.normalize(p));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : "text/plain" });
  fs.createReadStream(f).pipe(res);
}

http.createServer((req, res) => route(req, res).catch((e) => json(res, 500, { error: e.message })))
  .listen(PORT, "127.0.0.1", () => console.log(`Trema UI on http://127.0.0.1:${PORT}`));
