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

/** deploys.log line format: ISO_DATE<TAB>COMMIT<TAB>DURATION_S<TAB>ok|failed */
export function formatDeployLine({ date, commit, duration, result }) {
  return [date, commit, duration, result].join("\t");
}

export function parseDeploys(text) {
  return String(text)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [date, commit, duration, result] = l.split("\t");
      return { date, commit, duration: Number(duration), result };
    })
    .filter((d) => d.date && d.commit && (d.result === "ok" || d.result === "failed"))
    .reverse();
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
    .map((c) => ({ name: c.Names, state: c.State, project: parseLabel(c.Labels, "com.docker.compose.project") }));
}

function parseLabel(labels, key) {
  for (const p of String(labels ?? "").split(",")) {
    const [k, ...v] = p.split("=");
    if (k === key) return v.join("=");
  }
  return null;
}
