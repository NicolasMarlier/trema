// Pure helpers for the Trema dashboard (no I/O).

const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_RE = /(PASSWORD|SECRET|TOKEN|KEY|PASS|PRIVATE|CREDENTIAL|DATABASE_URL)/i;

export function isValidAppName(name) {
  return typeof name === "string" && name.length <= 100 && APP_NAME_RE.test(name);
}

/** Parse a .env file into [{key, value}] preserving order (comments/blank lines dropped). */
export function parseEnv(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    let value = line.slice(i + 1);
    value = unquote(value);
    out.push({ key, value });
  }
  return out;
}

/** Validate then serialize entries back to .env text. Throws on invalid input. */
export function serializeEnv(entries) {
  if (!Array.isArray(entries)) throw new Error("entries must be an array");
  const seen = new Set();
  const lines = entries.map(({ key, value }) => {
    if (!ENV_KEY_RE.test(key ?? "")) throw new Error(`invalid key: ${key}`);
    if (seen.has(key)) throw new Error(`duplicate key: ${key}`);
    seen.add(key);
    const v = String(value ?? "");
    if (/[\r\n]/.test(v)) throw new Error(`newline in value of ${key}`);
    return `${key}=${quoteValue(v)}`;
  });
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\([\\"$nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);
  }
  return value;
}

/** Quote a value so docker compose reads it back literally ($, #, spaces, quotes). */
export function quoteValue(v) {
  if (!/[$#\s"'\\`]/.test(v) && !/^["']/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/[\\"$]/g, "\\$&")}"`;
}

/** Rewrite an existing .env keeping comments/blank lines/order; update, drop and append keys. */
export function mergeEnv(originalText, entries) {
  serializeEnv(entries); // validate
  const map = new Map(entries.map((e) => [e.key, String(e.value ?? "")]));
  const used = new Set();
  const out = [];
  for (const raw of String(originalText).split(/\r?\n/)) {
    const t = raw.trim();
    const i = t.indexOf("=");
    const key = t && !t.startsWith("#") && i > 0 ? t.slice(0, i).trim() : null;
    if (key && ENV_KEY_RE.test(key)) {
      if (map.has(key) && !used.has(key)) { used.add(key); out.push(`${key}=${quoteValue(map.get(key))}`); }
      continue;
    }
    out.push(raw);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of map) if (!used.has(k)) out.push(`${k}=${quoteValue(v)}`);
  return out.join("\n") + (out.length ? "\n" : "");
}

export function isSecretKey(key) {
  return SECRET_RE.test(key);
}

/** Mask all values (default API output); revealed client-side only on request. */
export function maskEntries(entries) {
  return entries.map(({ key }) => ({ key, masked: true }));
}

/** deploys.log line format: ISO_DATE<TAB>COMMIT<TAB>DURATION_S<TAB>ok|failed[<TAB>MESSAGE] (message optional, legacy lines have 4 columns), then optional SOURCE (push|github|manual) */
export function formatDeployLine({ date, commit, duration, result, message, source }) {
  const cols = [date, commit, duration, result];
  if (message || source) cols.push(String(message ?? "").replace(/[\t\r\n]+/g, " ").slice(0, 200));
  if (source) cols.push(source);
  return cols.join("\t");
}

export function parseDeploys(text) {
  return String(text)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [date, commit, duration, result, message, source] = l.split("\t");
      return { date, commit, duration: Number(duration), result, message: message || null, source: source || null };
    })
    .filter((d) => d.date && d.commit && (d.result === "ok" || d.result === "failed"))
    .reverse();
}

/** Apply a {set:{K:V}, unset:[K]} patch to a .env text (comments preserved). Throws on invalid keys/values. */
export function applyEnvPatch(originalText, patch = {}) {
  const set = patch.set ?? {};
  const unset = new Set(patch.unset ?? []);
  const current = parseEnv(originalText);
  const map = new Map(current.map((e) => [e.key, e.value]));
  for (const k of unset) map.delete(k);
  for (const [k, v] of Object.entries(set)) map.set(k, String(v ?? ""));
  return mergeEnv(originalText, [...map].map(([key, value]) => ({ key, value })));
}

/** First server_name of an nginx site config -> https URL (null if none). */
export function parseNginxUrl(conf) {
  const m = /^\s*server_name\s+([^;\s]+)/m.exec(String(conf));
  return m && m[1] !== "_" ? `https://${m[1]}` : null;
}

/** Parse /proc/meminfo into {total, used} bytes. */
export function parseMeminfo(text) {
  const get = (k) => {
    const m = new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = get("MemTotal"), avail = get("MemAvailable");
  if (total == null || avail == null) return null;
  return { total, used: total - avail };
}

/** Parse `df -kP /` output into {total, used} bytes. */
export function parseDf(text) {
  const line = String(text).trim().split("\n").pop().trim().split(/\s+/);
  const total = Number(line[1]) * 1024, used = Number(line[2]) * 1024;
  return Number.isFinite(total) && Number.isFinite(used) && total > 0 ? { total, used } : null;
}

/** CPU usage % from two /proc/stat "cpu" lines snapshots. */
export function parseCpuTimes(text) {
  const l = /^cpu\s+(.+)$/m.exec(text);
  if (!l) return null;
  const n = l[1].trim().split(/\s+/).map(Number);
  const idle = (n[3] ?? 0) + (n[4] ?? 0);
  return { idle, total: n.reduce((a, b) => a + b, 0) };
}
export function cpuPercent(prev, cur) {
  if (!prev || !cur || cur.total <= prev.total) return null;
  return Math.round((1 - (cur.idle - prev.idle) / (cur.total - prev.total)) * 1000) / 10;
}

/** Map a docker container state to an app status. */
export function appStatus(containers) {
  if (!containers.length) return "unknown";
  const running = containers.filter((c) => c.state === "running").length;
  if (running === containers.length) return "up";
  if (running === 0) return "down";
  return "degraded";
}

export function parseDockerPs(text) {
  return String(text)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean)
    .map((c) => ({ name: c.Names, state: c.State, project: parseLabel(c.Labels, "com.docker.compose.project"), service: parseLabel(c.Labels, "com.docker.compose.service") }));
}

function parseLabel(labels, key) {
  for (const p of String(labels ?? "").split(",")) {
    const [k, ...v] = p.split("=");
    if (k === key) return v.join("=");
  }
  return null;
}

// ---- New app creation (T-10) ----
const NEW_APP_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const RESERVED_APP_NAMES = ["trema", "trema-ui", "www"];

/** Stricter than isValidAppName: the name is also a DNS label (underscores become hyphens). */
export function validateNewAppName(name) {
  if (typeof name !== "string" || !name) return "Nom requis.";
  if (!NEW_APP_RE.test(name)) return "Minuscules, chiffres, - et _ uniquement (1 à 40 caractères, sans - ou _ en début/fin).";
  if (RESERVED_APP_NAMES.includes(subdomainOf(name))) return "Nom réservé.";
  return null;
}

export const subdomainOf = (name) => String(name).replace(/_/g, "-");

/** Same vhost as the former `trema init` (certbot adds the TLS block). */
export function nginxVhost(name, host) {
  return `server {\n    server_name ${subdomainOf(name)}.${host};\n\n\tlocation / {\n\t\tproxy_pass http://localhost:3000;\n\t}\n}\n`;
}

/** Merge ~/repos and ~/apps names; apps without a deployed folder are "pending". */
export function mergeAppNames(repoNames, appNames) {
  const deployed = new Set(appNames);
  const all = [...new Set([...appNames, ...repoNames])].filter(isValidAppName).sort();
  return all.map((name) => ({ name, deployed: deployed.has(name) }));
}

/** Commands shown to the user to link the local folder after creation. */
export function localCommands(name, user, host) {
  return [
    `git remote add trema ${user}@${host}:repos/${name}`,
    `git push trema main`,
  ];
}

/** Value of the effective `PermitRootLogin` in sshd config text (first occurrence wins, like sshd). null = unset (OpenSSH default: prohibit-password). */
export function parsePermitRootLogin(text) {
  for (const line of String(text).split("\n")) {
    const m = line.trim().match(/^PermitRootLogin\s+(\S+)/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Read-only security summary shown in the dashboard. */
export function securityStatus({ uid, user, sshdConfig, scripts }) {
  const rootLogin = parsePermitRootLogin(sshdConfig);
  return {
    user,
    nonRoot: uid !== 0,
    rootSsh: sshdConfig === null ? "unknown" : rootLogin === "no" ? "disabled" : "enabled",
    sudoScripts: scripts,
    ok: uid !== 0 && rootLogin === "no" && scripts.length === 2,
  };
}
