import { test } from "node:test";
import assert from "node:assert/strict";
import * as a from "../ui/auth.mjs";

test("password hash verifies and rejects", () => {
  const h = a.hashPassword("correct horse battery");
  assert.ok(a.verifyPassword("correct horse battery", h));
  assert.ok(!a.verifyPassword("wrong", h));
  assert.ok(!a.verifyPassword("x", ""));
});
test("base32 round-trips", () => {
  const b = Buffer.from("hello world!");
  assert.deepEqual(a.base32Decode(a.base32Encode(b)), b);
});
test("TOTP matches RFC 6238 vector", () => {
  const secret = a.base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(a.totpAt(secret, Math.floor(59 / 30)), "287082"); // RFC: 94287082 → last 6 digits
});
test("verifyTotp accepts ±1 step, refuses replay and garbage", () => {
  const s = a.newTotpSecret(), now = 1_700_000_000_000, step = Math.floor(now / 30000);
  assert.equal(a.verifyTotp(s, a.totpAt(s, step), now), step);
  assert.equal(a.verifyTotp(s, a.totpAt(s, step - 1), now), step - 1);
  assert.equal(a.verifyTotp(s, a.totpAt(s, step - 5), now), null);
  assert.equal(a.verifyTotp(s, a.totpAt(s, step), now, step), null);
  assert.equal(a.verifyTotp(s, "abc", now), null);
});
test("sessions: valid, tampered, expired, other key, sliding renewal", () => {
  const k = "k1", now = 1e12, t = a.makeSession(k, now);
  assert.equal(a.checkSession(k, t, now + 1000).renew, false);
  assert.equal(a.checkSession(k, t, now + 2 * 3600e3).renew, true);
  assert.equal(a.checkSession("k2", t, now), null);
  assert.equal(a.checkSession(k, t.slice(0, -2) + "xx", now), null);
  assert.equal(a.checkSession(k, t, now + a.SESSION_TTL_MS + 1), null);
  assert.equal(a.checkSession(k, "", now), null);
});
test("throttle locks out exponentially after free attempts, resets on success", () => {
  const t = a.createThrottle({ free: 2, base: 1000, max: 4000 });
  t.fail("ip", 0); t.fail("ip", 0);
  assert.equal(t.wait("ip", 0), 0);
  t.fail("ip", 0);
  assert.equal(t.wait("ip", 0), 1000);
  t.fail("ip", 1000); assert.equal(t.wait("ip", 1000), 2000);
  t.fail("ip", 3000); t.fail("ip", 7000); assert.equal(t.wait("ip", 7000), 4000);
  t.ok("ip"); assert.equal(t.wait("ip", 7000), 0);
});
test("parseCookies and formatAudit", () => {
  assert.deepEqual(a.parseCookies("a=1; trema_session=x.y.z"), { a: "1", trema_session: "x.y.z" });
  assert.equal(a.formatAudit({ date: "D", ip: "1.2.3.4", event: "e", detail: "a\nb" }), "D 1.2.3.4 e a b");
});
