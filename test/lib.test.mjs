import { test } from "node:test";
import assert from "node:assert/strict";
import * as l from "../ui/lib.mjs";

test("parseEnv ignores comments and strips quotes", () => {
  assert.deepEqual(l.parseEnv('# c\nA=1\n\nB="x y"\nbad line\nC=a=b'), [
    { key: "A", value: "1" }, { key: "B", value: "x y" }, { key: "C", value: "a=b" },
  ]);
});
test("serializeEnv round-trips", () => {
  const e = [{ key: "A", value: "1" }, { key: "B", value: "x" }];
  assert.deepEqual(l.parseEnv(l.serializeEnv(e)), e);
});
test("serializeEnv rejects invalid input", () => {
  assert.throws(() => l.serializeEnv([{ key: "1A", value: "x" }]));
  assert.throws(() => l.serializeEnv([{ key: "A", value: "x\ny" }]));
  assert.throws(() => l.serializeEnv([{ key: "A", value: "1" }, { key: "A", value: "2" }]));
});
test("maskEntries hides values", () => {
  assert.deepEqual(l.maskEntries([{ key: "A", value: "s" }]), [{ key: "A", masked: true }]);
  assert.ok(l.isSecretKey("POSTGRES_PASSWORD"));
  assert.ok(!l.isSecretKey("LANG"));
});
test("isValidAppName blocks path traversal", () => {
  assert.ok(l.isValidAppName("my_app-1"));
  for (const n of ["..", "a/b", "", ".x", "a b"]) assert.ok(!l.isValidAppName(n));
});
test("deploys log format/parse, newest first", () => {
  const a = l.formatDeployLine({ date: "2026-01-01T00:00:00Z", commit: "abc", duration: 12, result: "ok" });
  const b = l.formatDeployLine({ date: "2026-01-02T00:00:00Z", commit: "def", duration: 3, result: "failed" });
  const r = l.parseDeploys(a + "\n" + b + "\ngarbage\n");
  assert.equal(r.length, 2);
  assert.equal(r[0].commit, "def");
  assert.equal(r[1].duration, 12);
});
test("appStatus", () => {
  assert.equal(l.appStatus([]), "unknown");
  assert.equal(l.appStatus([{ state: "running" }]), "up");
  assert.equal(l.appStatus([{ state: "exited" }]), "down");
  assert.equal(l.appStatus([{ state: "running" }, { state: "exited" }]), "degraded");
});
test("parseDockerPs extracts compose project", () => {
  const line = JSON.stringify({ Names: "blog-web-1", State: "running", Labels: "a=b,com.docker.compose.project=blog" });
  assert.deepEqual(l.parseDockerPs(line + "\nnotjson"), [{ name: "blog-web-1", state: "running", project: "blog" }]);
});
test("env values with $ # spaces and quotes round-trip", () => {
  for (const value of ["pa$word", "a #b", "it's", `q"$x`, "plain", " lead"]) {
    const e = [{ key: "A", value }];
    assert.deepEqual(l.parseEnv(l.serializeEnv(e)), e);
  }
  assert.equal(l.serializeEnv([{ key: "A", value: "pa$word" }]), "A='pa$word'\n");
});
test("mergeEnv keeps comments and order", () => {
  const out = l.mergeEnv("# hi\nA=1\n\nB=2\n", [{ key: "B", value: "x y" }, { key: "C", value: "3" }]);
  assert.equal(out, "# hi\n\nB='x y'\nC=3\n");
});

test("deploys log: optional commit message, legacy lines still parsed", () => {
  const l1 = "2026-01-01T00:00:00Z\tabc\t5\tok";
  const l2 = l.formatDeployLine({ date: "2026-01-02T00:00:00Z", commit: "def", duration: 3, result: "ok", message: "fix: a\tb" });
  const r = l.parseDeploys(l1 + "\n" + l2 + "\n");
  assert.equal(r[0].message, "fix: a b");
  assert.equal(r[1].message, null);
});
test("applyEnvPatch sets, overrides and unsets while keeping comments", () => {
  const out = l.applyEnvPatch("# hi\nA=1\nB=2\n", { set: { A: "x y", C: "3" }, unset: ["B"] });
  assert.equal(out, "# hi\nA='x y'\nC=3\n");
  assert.throws(() => l.applyEnvPatch("", { set: { "1x": "a" } }));
});
test("parseNginxUrl", () => {
  assert.equal(l.parseNginxUrl("server {\n  server_name blog.example.fr;\n}"), "https://blog.example.fr");
  assert.equal(l.parseNginxUrl("server { listen 80; }"), null);
});
test("system parsers", () => {
  assert.deepEqual(l.parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 400 kB\n"), { total: 1024000, used: 614400 });
  assert.deepEqual(l.parseDf("Filesystem 1K-blocks Used Available Use% Mounted\n/dev/x 1000 250 750 25% /"), { total: 1024000, used: 256000 });
  const a = l.parseCpuTimes("cpu 10 0 10 80 0 0 0 0"), b = l.parseCpuTimes("cpu 30 0 30 140 0 0 0 0");
  assert.equal(l.cpuPercent(a, b), 40);
  assert.equal(l.cpuPercent(null, b), null);
});

test("validateNewAppName", () => {
  assert.equal(l.validateNewAppName("my-app_2"), null);
  assert.equal(l.validateNewAppName("a"), null);
  for (const bad of ["", "My", "-a", "a-", "a.b", "a b", "x".repeat(41), "trema", "trema_ui", "www"]) assert.ok(l.validateNewAppName(bad), bad);
});
test("nginxVhost uses sanitized subdomain", () => {
  assert.match(l.nginxVhost("my_app", "ex.fr"), /server_name my-app\.ex\.fr;/);
});
test("mergeAppNames unions repos and apps", () => {
  assert.deepEqual(l.mergeAppNames(["b", "a"], ["a", "c"]), [
    { name: "a", deployed: true }, { name: "b", deployed: false }, { name: "c", deployed: true }]);
});
test("localCommands", () => {
  const c = l.localCommands("blog", "u", "h.fr");
  assert.equal(c[0], "git remote add trema u@h.fr:repos/blog");
  assert.match(c[1], /TREMA_PROJECT_NAME=blog/);
});
