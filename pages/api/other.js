// NOTE: This file was auto-extracted from export.js.
// You may need to adjust relative imports to match your project structure.

// ---- error ----
function error(res, status, code, message, details = {}) {
  return res.status(status).json({ ok: false, code, message, details });
}

// ---------- Redirect resolver (expands short-links like g.co/gemini/share/*) ----------

// ---- resolveShareUrl ----
// ---------- Redirect resolver (expands short-links like g.co/gemini/share/*) ----------
async function resolveShareUrl(inputUrl, maxHops = 5) {
  let current = inputUrl;
  for (let i = 0; i < maxHops; i++) {
    const r = await fetch(current, { method: "GET", redirect: "manual" });
    const status = r.status;
    const loc = r.headers.get("location");

    // 2xx → stop (final)
    if (status >= 200 && status < 300) return { url: current, hops: i, final: true };

    // 3xx with location → follow
    if (status >= 300 && status < 400 && loc) {
      const base = new URL(current);
      const next = new URL(loc, base);
      current = next.toString();
      continue;
    }

    // Anything else → stop with partial
    return { url: current, hops: i, final: false, status, location: loc || "" };
  }
  // Max hops reached: return last seen
  return { url: current, hops: maxHops, final: false, status: 310, location: "" };
}

// ---------- Public-access preflight (relaxed for same-host redirects) ----------

// ---- checkPublicAccess ----
// ---------- Public-access preflight (relaxed for same-host redirects) ----------
async function checkPublicAccess(u) {
  try {
    const r = await fetch(u, { method: "GET", redirect: "manual" });
    const status = r.status;
    const loc = r.headers.get("location") || "";
    const target = new URL(u);
    const redir = loc ? new URL(loc, target.origin) : null;

// ---- toLogin ----
const toLogin =
      (redir && /login|signin|auth|session/i.test((redir.pathname || "") + (redir.search || ""))) ||
      (redir && /accounts\.google\.com|auth|login/i.test(redir.hostname));

    const sameHost = redir && (redir.hostname === target.hostname);

// ---- isPublic ----
const isPublic =
      (status >= 200 && status < 300) ||
      (status >= 300 && status < 400 && sameHost && !toLogin);

    if (isPublic) return { ok: true, status, location: loc || "" };

    return {
      ok: false,
      status,
      location: loc || "",
      reason: "PRIVATE_OR_BLOCKED",
      message:
        "This share link isn’t public (redirects to login or returns an error). Open it in an incognito window; if it prompts to sign in, make the share public.",
    };
  } catch (e) {
    return { ok: false, status: 0, reason: "NETWORK", message: e?.message || "Network error" };
  }
}

// ---------- Scraping ----------

// ---- stripGeminiHeader ----
function stripGeminiHeader(s) {
  const lines = s.split(/\n+/);
  const cleaned = [];
  let inHeader = true;
  for (const line of lines) {
    const L = line.trim();
    if (!inHeader) { cleaned.push(L); continue; }
    if (
      /^gemini\b/i.test(L) ||
      /^https:\/\/g\.co\/gemini\/share\//i.test(L) ||
      /^(created with|published)/i.test(L) ||
      /google search/i.test(L) ||
      /^flash\s/i.test(L)
    ) {
      continue;
    }
    inHeader = false;
    if (L) cleaned.push(L);
  }
  return cleaned.join("\n");
}

// ---------- Parsing (roles) ----------

// ---- stripLeadingLabels ----
// ---------- Parsing (roles) ----------
function stripLeadingLabels(s) {
  return s
    .replace(/^You said:\s*/i, "")
    .replace(/^User:\s*/i, "")
    .replace(/^Assistant:\s*/i, "")
    .replace(/^ChatGPT said:\s*/i, "")
    .replace(/^System:\s*/i, "")
    .trim();
}

// ---- parseMessages ----
function parseMessages(raw, sourceHost = "") {
  const isGemini = /gemini\.google\.com$/.test(sourceHost);

  // If explicit Gemini separators exist, alternate starting with user
  if (isGemini && raw.includes('---TURN---')) {
    const parts = raw.split(/\n?\s*---TURN---\s?\n?/).map(s => s.trim()).filter(Boolean);
    let role = "user";
    return parts.map(p => {
      const text = stripLeadingLabels(p);
      const m = { role, text };
      role = role === "user" ? "assistant" : "user";
      return m;
    });
  }

  // Generic marker-based parsing (ChatGPT etc.)
  const dropExact = [/^sources?$/i, /^thought for \d+s$/i];
  const dropStarts = [
    /^community\.vercel\.com/i, /^uibakery\.io/i, /^tekpon\.com/i, /^toolsforhumans\.ai/i, /^vercel\.com$/i,
    /^https:\/\/g\.co\/gemini\/share\//i, /^created with/i, /^published/i, /^google search/i, /^flash\s/i, /^gemini\b/i
  ];

  const lines = String(raw)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !dropExact.some((rx) => rx.test(s)) && !dropStarts.some((rx) => rx.test(s)));

  const paragraphs = [];
  let buf = [];
  for (const l of lines) {
    if (/^(You said:|Assistant:|ChatGPT said:|System:|User:)/i.test(l)) {
      if (buf.length) { paragraphs.push(buf.join(" ").trim()); buf = []; }
      paragraphs.push(l);
    } else {
      buf.push(l);
    }
  }
  if (buf.length) paragraphs.push(buf.join(" ").trim());

  const messages = [];
  let currentRole = "assistant";
  let currentText = [];

// ---- flush ----
const flush = () => {
    const text = currentText.join("\n").trim();
    if (text) messages.push({ role: currentRole, text: stripLeadingLabels(text) });
    currentText = [];
  };

  for (const p of paragraphs) {
    const marker =
      /^You said:/i.test(p) ? "user" :
      /^User:/i.test(p) ? "user" :
      /^(Assistant:|ChatGPT said:)/i.test(p) ? "assistant" :
      /^System:/i.test(p) ? "system" : null;

    if (marker) { flush(); currentRole = marker; }
    else { currentText.push(p); }
  }
  flush();

  // Strong Gemini fallback: alternate by paragraph if only one speaker detected
  const onlyOneSpeaker = messages.length <= 1 || messages.every(m => m.role === messages[0].role);
  if (isGemini && onlyOneSpeaker) {
    const paras = String(raw).split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    let role = "user";
    const alt = paras.map(p => {
      const m = { role, text: stripLeadingLabels(p) };
      role = role === "user" ? "assistant" : "user";
      return m;
    });
    if (alt.length >= 2) return alt;
    return [{ role: "assistant", text: stripLeadingLabels(raw) }];
  }

  return messages;
}

// Group into user/assistant pairs

// ---- safeDisconnect ----
async function safeDisconnect(browser) {
  try { await browser.disconnect(); } catch {}
}
