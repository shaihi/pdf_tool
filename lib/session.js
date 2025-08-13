// lib/session.js
import { randomBytes } from "crypto";

const COOKIE = "sid";
const TTL_DAYS = 30;

export function getOrSetSession(req, res) {
  const cookies = parseCookie(req.headers.cookie || "");
  let sessionId = cookies[COOKIE];
  if (!sessionId) {
    sessionId = randomBytes(16).toString("hex");
    const expires = new Date(Date.now() + TTL_DAYS * 864e5).toUTCString();
    res.setHeader("Set-Cookie", `${COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}`);
  }
  return { sessionId, headers: req.headers };
}

function parseCookie(str) {
  const out = {};
  (str || "").split(/; */).forEach(p => {
    const idx = p.indexOf("=");
    if (idx === -1) return;
    const k = decodeURIComponent(p.slice(0, idx).trim());
    const v = decodeURIComponent(p.slice(idx + 1).trim());
    out[k] = v;
  });
  return out;
}
