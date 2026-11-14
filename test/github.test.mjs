import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as g from "../ui/github.mjs";
import { formatDeployLine, parseDeploys } from "../ui/lib.mjs";

test("verifySignature", () => {
  const body = '{"a":1}';
  const sig = "sha256=" + crypto.createHmac("sha256", "s3").update(body).digest("hex");
  assert.ok(g.verifySignature("s3", body, sig));
  assert.ok(!g.verifySignature("other", body, sig));
  assert.ok(!g.verifySignature("s3", body + " ", sig));
  assert.ok(!g.verifySignature("s3", body, "sha256=zz"));
  assert.ok(!g.verifySignature("s3", body, undefined));
  assert.ok(!g.verifySignature("", body, sig));
});

test("appJwt is a valid RS256 token", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const now = 1_700_000_000_000;
  const [h, p, s] = g.appJwt(42, pem, now).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  const body = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(body.iss, "42");
  assert.ok(body.exp - body.iat <= 600);
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")));
});

test("state store is single use, typed and expiring", () => {
  const st = g.createStateStore(1000);
  const a = st.issue("manifest", 0);
  assert.ok(!st.consume(a, "install", 10));
  assert.ok(!st.consume(a, "manifest", 10), "consumed even on wrong kind");
  const b = st.issue("manifest", 0);
  assert.ok(st.consume(b, "manifest", 10));
  assert.ok(!st.consume(b, "manifest", 10));
  assert.ok(!st.consume(st.issue("install", 0), "install", 5000));
  assert.ok(!st.consume("nope", "install"));
});

test("normalizeRootDir", () => {
  assert.equal(g.normalizeRootDir(""), "");
  assert.equal(g.normalizeRootDir("./"), "");
  assert.equal(g.normalizeRootDir("backend/"), "backend");
  assert.equal(g.normalizeRootDir("/apps/api"), "apps/api");
  for (const bad of ["..", "../x", "a/../b", "a\\b", "a;b", "$(x)"]) assert.throws(() => g.normalizeRootDir(bad), bad);
});

test("validateSource", () => {
  const s = g.validateSource({ repo: "acme/shop", branch: "main", rootDir: "backend/", installationId: 7 });
  assert.deepEqual(s, { repo: "acme/shop", branch: "main", rootDir: "backend", autoDeploy: true, alwaysDeploy: false, installationId: 7 });
  assert.throws(() => g.validateSource({ repo: "nope", branch: "main" }));
  assert.throws(() => g.validateSource({ repo: "a/b", branch: "x y" }));
  assert.throws(() => g.validateSource({ repo: "a/b", branch: "main", rootDir: ".." }));
  assert.equal(g.validateSource({ repo: "a/b", branch: "feature/x" }).branch, "feature/x");
});

const push = (files, over = {}) => ({ ref: "refs/heads/main", repository: { full_name: "Acme/Shop" }, commits: [{ added: [], modified: files, removed: [] }], ...over });
const src = (o) => ({ repo: "acme/shop", branch: "main", rootDir: "", autoDeploy: true, alwaysDeploy: false, ...o });

test("selectApps: monorepo routing", () => {
  const sources = { front: src({ rootDir: "frontend" }), back: src({ rootDir: "backend" }), all: src({}), other: src({ repo: "x/y" }) };
  const r = Object.fromEntries(g.selectApps(push(["backend/app.rb"]), sources).map((d) => [d.app, d]));
  assert.equal(r.back.action, "deploy");
  assert.equal(r.front.action, "ignored");
  assert.match(r.front.reason, /frontend/);
  assert.equal(r.all.action, "deploy");
  assert.equal(r.other, undefined);
});

test("selectApps: branch, flags, unknown file list", () => {
  const s = { a: src({ rootDir: "backend" }) };
  assert.equal(g.selectApps(push(["x"], { ref: "refs/heads/dev" }), s)[0].action, "ignored");
  assert.equal(g.selectApps(push(["x"], { ref: "refs/tags/v1" }), s)[0].action, "ignored");
  assert.equal(g.selectApps(push(["x"], { deleted: true }), s)[0].action, "ignored");
  assert.equal(g.selectApps(push(["x"]), { a: src({ rootDir: "backend", alwaysDeploy: true }) })[0].action, "deploy");
  assert.equal(g.selectApps(push(["x"]), { a: src({ autoDeploy: false }) })[0].action, "ignored");
  assert.equal(g.selectApps(push([], { commits: [] }), s)[0].action, "deploy", "no file list -> deploy");
  assert.equal(g.selectApps(push(["backendish/x"]), s)[0].action, "ignored", "prefix must match a whole directory");
});

test("deploys.log keeps legacy lines readable and carries the source", () => {
  const legacy = "2026-01-01T00:00:00Z\tabc\t3\tok\n2026-01-02T00:00:00Z\tdef\t4\tok\tmsg\n";
  const l = formatDeployLine({ date: "2026-01-03T00:00:00Z", commit: "ghi", duration: 5, result: "failed", message: "m", source: "github" });
  assert.equal(l, "2026-01-03T00:00:00Z\tghi\t5\tfailed\tm\tgithub");
  const [a, b, c] = parseDeploys(legacy + l + "\n").reverse();
  assert.equal(a.source, null); assert.equal(a.message, null);
  assert.equal(b.message, "msg"); assert.equal(b.source, null);
  assert.equal(c.source, "github");
});

test("webhook endpoint: signature, ignored vs deploy, source API", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trema-gh-"));
  for (const d of ["repos/shop-back", "repos/shop-front", "apps/shop-back", "apps/shop-front", "trema-ui"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  for (const a of ["shop-back", "shop-front"]) { const r = path.join(home, "repos", a); await new Promise((ok) => spawn("git", ["init", "-q", "--bare", r]).on("close", ok)); }
  fs.writeFileSync(path.join(home, "trema-ui/github-app.json"), JSON.stringify({ appId: 1, slug: "t", webhookSecret: "sec" }));
  fs.writeFileSync(path.join(home, "trema-ui/github-app.pem"), crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const port = 4800 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, [path.resolve("ui/server.mjs")], { env: { ...process.env, PORT: String(port), TREMA_DEV: "1", TREMA_HOME: home, TREMA_HOST: "ex.fr", TREMA_GITHUB_API: "http://127.0.0.1:1" }, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const h = { "content-type": "application/json", "x-trema": "1" };
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { await fetch(base + "/me"); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(up);
    for (const [a, root] of [["shop-back", "backend/"], ["shop-front", "frontend"]]) {
      const r = await fetch(`${base}/apps/${a}/source`, { method: "PUT", headers: h, body: JSON.stringify({ repo: "acme/shop", branch: "main", rootDir: root, installationId: 9 }) });
      assert.equal(r.status, 200);
    }
    assert.equal((await (await fetch(`${base}/apps/shop-back/source`)).json()).rootDir, "backend");
    const cfg = await new Promise((ok) => { let o = ""; const p = spawn("git", ["config", "trema.rootdir"], { cwd: path.join(home, "repos/shop-back") }); p.stdout.on("data", (c) => (o += c)); p.on("close", () => ok(o.trim())); });
    assert.equal(cfg, "backend");
    assert.equal((await fetch(`${base}/apps/shop-back/source`, { method: "PUT", headers: h, body: JSON.stringify({ repo: "a/b", branch: "main", rootDir: "../x" }) })).status, 400);

    const body = JSON.stringify(push(["frontend/a.ts"]));
    const post = (b, sig) => fetch(`${base}/hooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sig }, body: b });
    assert.equal((await post(body, "sha256=00")).status, 401);
    const ok = await post(body, "sha256=" + crypto.createHmac("sha256", "sec").update(body).digest("hex"));
    assert.equal(ok.status, 200);
    const { results } = await ok.json();
    assert.equal(results.find((x) => x.app === "shop-back").action, "ignored");
    assert.equal(results.find((x) => x.app === "shop-front").action, "deploy");
    const st = await (await fetch(`${base}/github/status`)).json();
    assert.equal(st.configured, true);
    assert.equal(st.deliveries.length, 1);
    // callbacks need a valid state, no session otherwise
    assert.equal((await fetch(`${base}/github/callback/install?state=bad`)).status, 400);
  } finally { srv.kill(); }
});
