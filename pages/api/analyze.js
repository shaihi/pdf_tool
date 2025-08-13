// pages/api/analyze.js
// Next.js Pages Router API route (Node runtime)
import { analyzeChallenges } from "../../lib/challenge";

export default async function handler(req, res) {
  // CORS (optional – adjust as needed)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST with a chat payload.' });
  }

  try {
    const payload = req.body && Object.keys(req.body).length ? req.body : await readJson(req);
    const result = analyzeChallenges(payload, {});
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err?.message || 'Invalid payload' });
  }
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    try {
      let data = '';
      req.on('data', chunk => (data += chunk));
      req.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}
