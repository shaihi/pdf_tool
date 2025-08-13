// pages/api/user-key.js
import { kv } from "../../lib/kv";
import { getOrSetSession } from "../../lib/session";
import crypto from "crypto";

const ENC_SECRET = process.env.USER_KEY_SECRET;

function ensureSecret() {
  if (!ENC_SECRET || ENC_SECRET.length < 16) {
    throw new Error("Missing USER_KEY_SECRET (>=16 chars) in environment");
  }
}

function encrypt(text) {
  ensureSecret();
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(ENC_SECRET).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export default async function handler(req, res) {
  const { sessionId } = getOrSetSession(req, res);
  const kvKey = `userkey:${sessionId}`;

  try {
    if (req.method === "GET") {
      const v = await kv.get(kvKey);
      return res.status(200).json({ hasKey: Boolean(v) });
    }

    if (req.method === "POST") {
      const body = req.body && Object.keys(req.body).length ? req.body : await readJson(req);
      const key = (body?.key || "").trim();
      if (!key.startsWith("sk-") || key.length < 20) {
        return res.status(400).json({ error: "Invalid key format" });
      }
      const enc = encrypt(key);
      await kv.set(kvKey, enc, { ex: 60 * 60 * 24 * 7 }); // 7 days
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      await kv.del(kvKey);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "failed" });
  }
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
