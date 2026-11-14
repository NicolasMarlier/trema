import { test } from "node:test";
import assert from "node:assert/strict";
import * as f from "../ui/web/src/format.ts";
import * as d from "../ui/web/src/envDiff.ts";

test("formatDuration", () => {
  assert.equal(f.formatDuration(48), "48 s");
  assert.equal(f.formatDuration(125), "2 min 5 s");
  assert.equal(f.formatDuration(3720), "1 h 2 min");
  assert.equal(f.formatDuration(-1), "–");
});
test("relativeTime", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  assert.equal(f.relativeTime("2026-01-10T11:59:50Z", now), "à l'instant");
  assert.equal(f.relativeTime("2026-01-10T11:50:00Z", now), "il y a 10 min");
  assert.equal(f.relativeTime("2026-01-10T07:00:00Z", now), "il y a 5 h");
  assert.equal(f.relativeTime("2026-01-05T12:00:00Z", now), "il y a 5 j");
  assert.equal(f.relativeTime("2025-06-01T12:00:00Z", now), "2025-06-01");
  assert.equal(f.relativeTime("nope", now), "nope");
});
test("formatBytes / percent", () => {
  assert.equal(f.formatBytes(512), "512 o");
  assert.equal(f.formatBytes(1536), "1.5 Ko");
  assert.equal(f.formatBytes(null), "–");
  assert.equal(f.percent(1, 4), 25);
  assert.equal(f.percent(1, 0), 0);
});
test("logLevel / filterLines / tail", () => {
  assert.equal(f.logLevel("web | ERROR boom"), "error");
  assert.equal(f.logLevel("web | warning: x"), "warn");
  assert.equal(f.logLevel("web | listening"), "info");
  assert.deepEqual(f.filterLines(["A b", "c"], " B"), ["A b"]);
  assert.deepEqual(f.filterLines(["a"], ""), ["a"]);
  assert.deepEqual(f.tail([1, 2, 3], 2), [2, 3]);
});
test("hash routing", () => {
  assert.deepEqual(f.parseHash("#/blog/logs"), { app: "blog", tab: "logs" });
  assert.deepEqual(f.parseHash("#/blog/zzz"), { app: "blog", tab: "overview" });
  assert.deepEqual(f.parseHash(""), { app: null, tab: "overview" });
  assert.equal(f.buildHash({ app: "a b", tab: "env" }), "#/a%20b/env");
  assert.equal(f.buildHash({ app: null, tab: "env" }), "#/");
});
test("diffEnv + toPatch", () => {
  const c = d.diffEnv({ original: ["A", "B", "C"], edited: { A: "1", N: "2", B: "x" }, removed: ["B", "C", "ghost"] });
  assert.deepEqual(c, [
    { kind: "change", key: "A", value: "1" },
    { kind: "add", key: "N", value: "2" },
    { kind: "remove", key: "B" },
    { kind: "remove", key: "C" },
  ]);
  assert.deepEqual(d.toPatch(c), { set: { A: "1", N: "2" }, unset: ["B", "C"] });
  assert.deepEqual(d.diffEnv({ original: ["A"], edited: {}, removed: [] }), []);
});

import * as rs from "../ui/web/src/resync.ts";
test("resyncStep", () => {
  assert.deepEqual(rs.resyncStep(null), { kind: "retry" });
  assert.equal(rs.resyncStep({ id: "1", state: "running" }).kind, "reconnect");
  assert.equal(rs.resyncStep({ id: "1", state: "ok" }).kind, "done");
  assert.equal(rs.resyncStep({ id: "1", state: "failed" }).kind, "done");
});
test("resyncDelay / jobTitle", () => {
  assert.equal(rs.resyncDelay(0), 1000);
  assert.equal(rs.resyncDelay(100), 5000);
  assert.equal(rs.jobTitle("deploy"), "Déploiement");
  assert.equal(rs.jobTitle("x"), "x");
});
