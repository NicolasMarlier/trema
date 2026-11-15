import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { dumpFileName, dumpStamp, isValidDumpFile, parseDumpFile, uploadExt, detectFormat, planSteps, restoreScript, dropSchemaScript, dumpScript } from "../ui/dbdump.mjs";

test("dump file names", () => {
  assert.equal(dumpStamp(new Date(2026, 0, 2, 3, 4)), "2026-01-02T0304");
  assert.equal(dumpFileName("blog", "2026-01-02T0304"), "trema-blog-2026-01-02T0304.dump");
  assert.equal(dumpFileName("blog", "2026-01-02T0304", "pre-restore"), "trema-blog-2026-01-02T0304-pre-restore.dump");
  assert.equal(dumpFileName("blog", "2026-01-02T0304", "upload", "sql.gz"), "trema-blog-2026-01-02T0304-upload.sql.gz");
});

test("file name validation", () => {
  for (const ok of ["a.dump", "trema-x-2026-01-02T0304.sql", "b.sql.gz"]) assert.ok(isValidDumpFile(ok), ok);
  for (const ko of ["../a.dump", "a/b.dump", "a.txt", ".dump", "a..b.dump", "", null, "a.dump.sh", "-a.dump"]) assert.ok(!isValidDumpFile(ko), String(ko));
});

test("parseDumpFile only matches the app's own dumps", () => {
  assert.deepEqual(parseDumpFile("blog", "trema-blog-2026-01-02T0304-pre-restore.dump"), { file: "trema-blog-2026-01-02T0304-pre-restore.dump", stamp: "2026-01-02T0304", origin: "pre-restore", ext: "dump" });
  assert.equal(parseDumpFile("blog", "trema-blog-2026-01-02T0304.sql").origin, "manual");
  assert.equal(parseDumpFile("blog", "trema-blog-2026-01-02T0304-upload.sql.gz").origin, "upload");
  assert.equal(parseDumpFile("blog", "trema-blog-2-2026-01-02T0304.dump"), null);
  assert.equal(parseDumpFile("blog", "trema-other-2026-01-02T0304.dump"), null);
  assert.equal(parseDumpFile("b.g", "trema-blog-2026-01-02T0304.dump"), null);
});

test("uploadExt and detectFormat", () => {
  assert.equal(uploadExt("X.SQL.GZ"), "sql.gz");
  assert.equal(uploadExt("a.dump"), "dump");
  assert.equal(uploadExt("a.sql"), "sql");
  assert.equal(uploadExt("a.zip"), null);
  assert.equal(detectFormat(Buffer.from("PGDMP\x01\x0e")), "custom");
  assert.equal(detectFormat(Buffer.from([0x1f, 0x8b, 8])), "gzip");
  assert.equal(detectFormat(Buffer.from("-- PostgreSQL dump\nSET x;")), "sql");
  assert.equal(detectFormat(Buffer.from([1, 2, 0, 3])), null);
  assert.equal(detectFormat(Buffer.alloc(0)), null);
});

test("restore plan depends on the mode", () => {
  assert.deepEqual(planSteps("full"), ["safety-dump", "stop-web", "drop-schema", "restore", "migrate", "start-web"]);
  assert.deepEqual(planSteps("data"), ["safety-dump", "stop-web", "load-data", "start-web"]);
  assert.throws(() => planSteps("nope"));
});

test("generated shell scripts are valid sh", () => {
  const scripts = [dumpScript(), dropSchemaScript(), ...["full", "data"].flatMap((m) => ["custom", "sql"].map((f) => restoreScript(m, f)))];
  for (const s of scripts) execFileSync("sh", ["-n", "-c", s]);
  assert.match(restoreScript("full", "custom"), /pg_restore/);
  assert.match(restoreScript("full", "sql"), /psql/);
  assert.match(restoreScript("data", "custom"), /--single-transaction/);
  assert.match(restoreScript("data", "custom"), /TRUNCATE/);
  assert.doesNotMatch(restoreScript("full", "custom"), /TRUNCATE/);
});

test("db API: dump, upload, download, restore guards", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trema-db-"));
  const bin = path.join(home, "bin"); fs.mkdirSync(bin);
  const dumps = path.join(home, "dumps"); fs.mkdirSync(dumps);
  fs.mkdirSync(path.join(home, "apps", "blog"), { recursive: true });
  const calls = path.join(home, "calls.log");
  // fake docker: `ps` lists a blog db container, `compose exec … sh -c <script>` logs the script and emits a fake dump (or eats stdin)
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh
if [ "$1" = ps ]; then echo '{"Names":"blog-db-1","State":"running","Labels":"com.docker.compose.project=blog,com.docker.compose.service=db"}'; exit 0; fi
if [ "$1" = compose ] && [ "$2" = exec ]; then
  case "$7" in *pg_dump*) printf 'PGDMPfake'; exit 0;; esac
  echo "$7" >> "${calls}"; cat > /dev/null; exit 0
fi
if [ "$1" = compose ]; then echo "$@" >> "${calls}"; fi
exit 0
`, { mode: 0o755 });
  const port = 4800 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, [path.resolve("ui/server.mjs")], {
    env: { ...process.env, PORT: String(port), TREMA_DEV: "1", TREMA_HOME: home, TREMA_DUMPS: dumps, TREMA_HOST: "ex.fr", PATH: `${bin}:${process.env.PATH}` },
    stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${port}/api/apps/blog`;
    const h = { "content-type": "application/json", "x-trema": "1" };
    let hasDb = false;
    for (let i = 0; i < 60 && !hasDb; i++) {
      try { hasDb = (await (await fetch(`http://127.0.0.1:${port}/api/apps`)).json()).apps.find((a) => a.name === "blog")?.hasDb; } catch {}
      if (!hasDb) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(hasDb, "hasDb exposed");
    const waitJob = async (id) => { for (let i = 0; i < 100; i++) { const j = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`)).json(); if (j.state !== "running") return j; await new Promise((r) => setTimeout(r, 50)); } };

    // create a dump
    const r = await fetch(`${base}/db/dumps`, { method: "POST", headers: h, body: "{}" });
    assert.equal(r.status, 202);
    const { job, file } = await r.json();
    assert.equal((await waitJob(job.id)).state, "ok");
    assert.equal(fs.readFileSync(path.join(dumps, file), "utf8"), "PGDMPfake");
    let list = await (await fetch(`${base}/db/dumps`)).json();
    assert.equal(list[0].file, file); assert.equal(list[0].origin, "manual");

    // download
    const dl = await fetch(`${base}/db/dumps/${file}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition"), /attachment/);
    assert.equal(await dl.text(), "PGDMPfake");
    assert.equal((await fetch(`${base}/db/dumps/..%2Fetc%2Fpasswd`)).status, 404);
    assert.equal((await fetch(`${base}/db/dumps/trema-other-2026-01-01T0000.dump`)).status, 404);

    // upload: octet-stream needs X-Trema; extension and content are checked
    const up = (name, body, headers = { "content-type": "application/octet-stream", "x-trema": "1" }) => fetch(`${base}/db/upload?name=${name}`, { method: "POST", headers, body });
    assert.equal((await up("a.dump", "PGDMPx", { "content-type": "application/octet-stream" })).status, 403);
    assert.equal((await up("a.zip", "x")).status, 400);
    assert.equal((await up("a.dump", "not a custom dump")).status, 400);
    const ok = await up("a.dump", "PGDMPupload");
    assert.equal(ok.status, 201);
    const uploaded = (await ok.json()).file;
    assert.match(uploaded, /-upload\.dump$/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/apps/blog/jobs`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-trema": "1" }, body: "x" })).status, 403);

    // restore guards
    const rs = (body) => fetch(`${base}/db/restore`, { method: "POST", headers: h, body: JSON.stringify(body) });
    assert.equal((await rs({ file: uploaded, mode: "full", confirm: "nope" })).status, 400);
    assert.equal((await rs({ file: uploaded, mode: "zzz", confirm: "blog" })).status, 400);
    assert.equal((await rs({ file: "../x.dump", mode: "full", confirm: "blog" })).status, 404);

    // full restore: safety dump, web stopped, schema dropped, restored, migrated, web restarted
    const go = await rs({ file: uploaded, mode: "full", confirm: "blog" });
    assert.equal(go.status, 202);
    const done = await waitJob((await go.json()).job.id);
    assert.equal(done.state, "ok");
    assert.ok(fs.readdirSync(dumps).some((f) => f.endsWith("-pre-restore.dump")), "safety dump");
    const log = fs.readFileSync(calls, "utf8");
    assert.ok(log.indexOf("stop web") < log.indexOf("DROP SCHEMA") && log.indexOf("DROP SCHEMA") < log.indexOf("pg_restore") && log.indexOf("pg_restore") < log.indexOf("db:prepare") && log.indexOf("db:prepare") < log.indexOf("start web"), log);
  } finally { srv.kill(); }
});
