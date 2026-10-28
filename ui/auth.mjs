// Auth helpers for public access: scrypt password, TOTP (RFC 6238), signed sessions, throttling. No dependencies.
import crypto from "node:crypto";

export const SESSION_TTL_MS = 7 * 24 * 3600e3;
const RENEW_AFTER_MS = 3600e3;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function hashPassword(pw, salt = crypto.randomBytes(16)) {
  return `${salt.toString("hex")}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  const [s, h] = String(stored ?? "").split(":");
  if (!s || !h) return false;
  const a = crypto.scryptSync(String(pw), Buffer.from(s, "hex"), 64), b = Buffer.from(h, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function base32Encode(buf) {
  let bits = 0, v = 0, out = "";
  for (const byte of buf) { v = (v << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(v << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  let bits = 0, v = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/[=\s]/g, "")) {
    const i = B32.indexOf(c); if (i < 0) throw new Error("invalid base32");
    v = (v << 5) | i; bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export const otpauthUri = (secret, account) =>
  `otpauth://totp/Trema:${encodeURIComponent(account)}?secret=${secret}&issuer=Trema`;

export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
/** Returns the matched time step (±1 window) or null. Use lastStep to refuse replays. */
export function verifyTotp(secret, code, now = Date.now(), lastStep = -1) {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(now / 30000);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (step > lastStep && crypto.timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

const sign = (key, data) => crypto.createHmac("sha256", key).update(data).digest("base64url");
/** Token = id.expiry.signature. */
export function makeSession(key, now = Date.now(), id = crypto.randomBytes(12).toString("base64url")) {
  const p = `${id}.${now + SESSION_TTL_MS}`;
  return `${p}.${sign(key, p)}`;
}
/** Returns {id, renew} if valid, else null. renew=true when a fresh token should be issued (sliding window). */
export function checkSession(key, token, now = Date.now()) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const p = `${parts[0]}.${parts[1]}`, exp = Number(parts[1]);
  const a = Buffer.from(sign(key, p)), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || !(exp > now)) return null;
  return { id: parts[0], renew: exp - now < SESSION_TTL_MS - RENEW_AFTER_MS };
}

export function parseCookies(h) {
  const o = {};
  for (const p of String(h ?? "").split(";")) { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return o;
}

/** Per-key failure throttle: after N failures, exponential lockout (capped). */
export function createThrottle({ free = 2, base = 5000, max = 15 * 60e3 } = {}) {
  const m = new Map();
  return {
    wait(key, now = Date.now()) { const e = m.get(key); return e && e.until > now ? e.until - now : 0; },
    fail(key, now = Date.now()) {
      const n = (m.get(key)?.n ?? 0) + 1;
      m.set(key, { n, until: n > free ? now + Math.min(max, base * 2 ** (n - free - 1)) : 0 });
    },
    ok(key) { m.delete(key); },
  };
}

export function formatAudit({ date, ip, event, detail = "" }) {
  return [date, ip, event, String(detail).replace(/[\r\n]+/g, " ")].join(" ").trim();
}
