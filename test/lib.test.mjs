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
