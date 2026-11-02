// Run on the VM by `trema ui:install|ui:password`. Manages auth.json (mode 0600).
// Usage: node auth-cli.mjs <file> set-password <domain>   (password on stdin)
import fs from "node:fs";
import crypto from "node:crypto";
import { hashPassword, newTotpSecret, otpauthUri } from "./auth.mjs";

const [file, cmd, domain] = process.argv.slice(2);
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const write = (o) => fs.writeFileSync(file, JSON.stringify(o, null, 2), { mode: 0o600 });

if (cmd === "set-password") {
  const pw = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (pw.length < 12) { console.error("Password must be at least 12 characters."); process.exit(1); }
  const old = read();
  const totp = old?.totp ?? newTotpSecret();
  // New sessionKey invalidates every existing session.
  write({ domain: domain || old?.domain, hash: hashPassword(pw), totp, sessionKey: crypto.randomBytes(32).toString("hex") });
  if (!old?.totp) console.log(`TOTP_SECRET=${totp}\nTOTP_URI=${otpauthUri(totp, domain || old?.domain)}`);
} else { console.error("unknown command"); process.exit(1); }
