import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

test("POST /api/apps creates a pending app", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trema-srv-"));
  const bin = path.join(home, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "sudo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const sites = path.join(home, "sites"); fs.mkdirSync(sites);
  const port = 4300 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, [path.resolve("ui/server.mjs")], {
    env: { ...process.env, PORT: String(port), TREMA_DEV: "1", TREMA_HOME: home, TREMA_NGINX_SITES: sites, TREMA_HOST: "ex.fr", PATH: `${bin}:${process.env.PATH}` },
    stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${port}/api/apps`;
    const h = { "content-type": "application/json", "x-trema": "1" };
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { await fetch(base); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(up, "server up");
    const r = await fetch(base, { method: "POST", headers: h, body: JSON.stringify({ name: "demo-t10" }) });
    assert.equal(r.status, 202);
    assert.ok((await r.json()).job);
    let found;
    for (let i = 0; i < 50 && !found; i++) {
      found = (await (await fetch(base)).json()).apps.find((a) => a.name === "demo-t10");
      if (!found) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(found?.status, "pending");
  } finally { srv.kill(); }
});
