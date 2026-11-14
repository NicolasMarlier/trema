// Pure helpers for the GitHub integration (T-13): signatures, App JWT, push -> apps matching. No I/O.
import crypto from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64url");

/** Verify GitHub's X-Hub-Signature-256 header against the raw body. */
export function verifySignature(secret, body, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const want = crypto.createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(header.slice(7), "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** GitHub App JWT (RS256, 9 min, clock skew tolerated). */
export function appJwt(appId, pem, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), pem);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Manifest for the "create the GitHub App in one click" flow (private app, push events, contents:read only). */
export function appManifest(host) {
  const base = `https://trema.${host}`;
  return {
    name: `Trema ${host}`.slice(0, 34),
    url: base,
    hook_attributes: { url: `${base}/api/hooks/github`, active: true },
    redirect_url: `${base}/api/github/callback/manifest`,
    setup_url: `${base}/api/github/callback/install`,
    public: false,
    default_events: ["push"],
    default_permissions: { contents: "read", metadata: "read" },
  };
}

/** Single-use, short-lived `state` values (the session cookie is SameSite=Strict, so callbacks can't rely on it). */
export function createStateStore(ttlMs = 10 * 60_000) {
  const m = new Map();
  return {
    issue(kind, now = Date.now()) {
      const s = crypto.randomBytes(16).toString("hex");
      m.set(s, { kind, exp: now + ttlMs });
      for (const [k, v] of m) if (v.exp < now) m.delete(k);
      return s;
    },
    consume(state, kind, now = Date.now()) {
      const v = m.get(state);
      m.delete(state);
      return !!v && v.kind === kind && v.exp >= now;
    },
  };
}

/** "", "/", "." -> "" ; "backend/" -> "backend". Throws on absolute paths, "..", backslashes, odd characters. */
export function normalizeRootDir(input) {
  const s = String(input ?? "").trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (s === "" || s === ".") return "";
  if (!/^[A-Za-z0-9._ @+-]+(\/[A-Za-z0-9._ @+-]+)*$/.test(s) || s.split("/").some((x) => x === ".." || x === ".")) throw new Error("Dossier racine invalide (chemin relatif au dépôt, sans « .. »).");
  return s;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^(?!\/|.*(\.\.|\/\/|@\{|\\))[^\s~^:?*[]+(?<![/.])$/;

/** Validate a per-app source config. */
export function validateSource(b = {}) {
  if (!REPO_RE.test(b.repo ?? "")) throw new Error("Dépôt invalide (owner/nom).");
  if (!BRANCH_RE.test(b.branch ?? "")) throw new Error("Branche invalide.");
  const installationId = Number(b.installationId);
  return {
    repo: b.repo, branch: b.branch, rootDir: normalizeRootDir(b.rootDir),
    autoDeploy: b.autoDeploy !== false, alwaysDeploy: b.alwaysDeploy === true,
    installationId: Number.isInteger(installationId) && installationId > 0 ? installationId : null,
  };
}

/** Union of files touched by a push payload. null if GitHub did not list them (too many commits / empty). */
export function pushedFiles(payload) {
  const commits = payload?.commits;
  if (!Array.isArray(commits) || commits.length === 0 || commits.length >= 20) return null;
  const set = new Set();
  for (const c of commits) for (const k of ["added", "modified", "removed"]) for (const f of c[k] ?? []) set.add(f);
  return [...set];
}

export const touchesRoot = (files, rootDir) => !rootDir || files.some((f) => f === rootDir || f.startsWith(rootDir + "/"));

/**
 * For a push payload, decide per app: deploy or ignore (with reason).
 * sources: { appName: sourceConfig }. Returns [{ app, action: "deploy"|"ignored", reason? }].
 */
export function selectApps(payload, sources) {
  const repo = String(payload?.repository?.full_name ?? "").toLowerCase();
  const ref = String(payload?.ref ?? "");
  const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : null;
  const files = pushedFiles(payload);
  const out = [];
  for (const [app, s] of Object.entries(sources)) {
    if (String(s.repo).toLowerCase() !== repo) continue;
    if (branch !== s.branch) { out.push({ app, action: "ignored", reason: `branche ${branch ?? ref} ≠ ${s.branch}` }); continue; }
    if (payload.deleted) { out.push({ app, action: "ignored", reason: "branche supprimée" }); continue; }
    if (!s.autoDeploy) { out.push({ app, action: "ignored", reason: "déploiement automatique désactivé" }); continue; }
    if (s.rootDir && !s.alwaysDeploy && files && !touchesRoot(files, s.rootDir)) { out.push({ app, action: "ignored", reason: `aucun fichier dans ${s.rootDir}/` }); continue; }
    out.push({ app, action: "deploy" });
  }
  return out;
}

/** Authorization header value for `git -c http.extraHeader=...` (keeps the token out of URLs and logs). */
export const gitAuthHeader = (token) => `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
