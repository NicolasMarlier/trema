// Trema dashboard server. No dependencies. Binds to 127.0.0.1 only (access via SSH tunnel).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isValidAppName, parseEnv, serializeEnv, parseDeploys, parseDockerPs, appStatus } from "./lib.mjs";

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

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return serveStatic(url.pathname, res);
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
    try { text = serializeEnv(JSON.parse(await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); }
    fs.writeFileSync(envFile, text);
    await compose(name, ["--env-file", ".env", "up", "--build", "--force-recreate", "-d"]);
    return json(res, 200, { ok: true });
  }
  if (sub === "deploys") {
    const f = path.join(appDir(name), "deploys.log");
    return json(res, 200, parseDeploys(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""));
  }
  if (sub === "stats") {
    const out = await sh("docker", ["stats", "--no-stream", "--format", "{{json .}}"]).catch(() => "");
    const rows = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.Name.startsWith(name + "-"));
    return json(res, 200, rows.map((r) => ({ name: r.Name, cpu: r.CPUPerc, mem: r.MemUsage })));
  }
  if (sub === "logs") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const p = execFile("docker", ["compose", "logs", "-f", "--tail", "200", "--no-color"], { cwd: appDir(name) });
    const send = (c) => String(c).split("\n").filter(Boolean).forEach((l) => res.write(`data: ${l}\n\n`));
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
