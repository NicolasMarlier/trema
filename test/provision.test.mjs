import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionApp } from "../ui/provision.mjs";

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trema-"));
  const hooksDir = path.join(home, "src-hooks"); fs.mkdirSync(hooksDir);
  fs.writeFileSync(path.join(hooksDir, "post-receive"), "#!/bin/bash\n");
  const nginxSites = path.join(home, "sites"); fs.mkdirSync(nginxSites);
  return { home, hooksDir, nginxSites };
}

test("provisionApp runs all steps, then is idempotent", async () => {
  const d = setup(); const calls = []; let out = "";
  const run = async (cmd, args) => { calls.push([cmd, ...args].join(" ")); if (cmd === "git") fs.mkdirSync(args.at(-1), { recursive: true }), fs.writeFileSync(path.join(args.at(-1), "HEAD"), ""); return true; };
  const o = { ...d, name: "my_app", host: "ex.fr", run, push: (s) => (out += s) };
  assert.equal(await provisionApp(o), true);
  assert.ok(fs.existsSync(path.join(d.home, "repos/my_app/hooks/post-receive")));
  assert.match(fs.readFileSync(path.join(d.nginxSites, "my-app"), "utf8"), /my-app\.ex\.fr/);
  assert.ok(calls.some((c) => c === "sudo -n certbot --nginx --non-interactive --domains my-app.ex.fr"));
  assert.equal(await provisionApp(o), true);
  assert.equal(calls.filter((c) => c.startsWith("git")).length, 1);
});

test("provisionApp stops at failing certbot and keeps earlier work", async () => {
  const d = setup(); let out = "";
  const run = async (cmd, args) => { if (cmd === "git") { fs.mkdirSync(args.at(-1), { recursive: true }); fs.writeFileSync(path.join(args.at(-1), "HEAD"), ""); return true; } return args.includes("certbot") ? false : true; };
  assert.equal(await provisionApp({ ...d, name: "blog", host: "ex.fr", run, push: (s) => (out += s) }), false);
  assert.match(out, /Étape échouée : Certificat HTTPS/);
  assert.ok(fs.existsSync(path.join(d.nginxSites, "blog")));
  assert.doesNotMatch(out, /Rechargement nginx/);
});
