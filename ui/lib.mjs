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
    if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
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
    return `${key}=${v}`;
  });
  return lines.join("\n") + (lines.length ? "\n" : "");
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
