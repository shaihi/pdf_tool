// pages/api/extract.js
import puppeteer from "puppeteer-core";
import { htmlToText } from "html-to-text";

// ---- Config / Security ----
const ALLOWED_DOMAINS = [
  "chat.openai.com",
  "chatgpt.com",
  "gemini.google.com",
  "x.ai",
  "grok.com",
  "claude.ai",
  "lechat.mistral.ai",
];
const MAX_URL_LENGTH = 500;
const MAX_TEXT_LENGTH = 120_000;

function error(res, status, code, message, details = {}) {
  return res.status(status).json({ ok: false, code, message, details });
}

// ---------- Public-access preflight (relaxed for same-host redirects) ----------
async function checkPublicAccess(u) {
  try {
    const r = await fetch(u, { method: "GET", redirect: "manual" });
    const status = r.status;
    const loc = r.headers.get("location") || "";
    const target = new URL(u);
    const redir = loc ? new URL(loc, target.origin) : null;

    const toLogin =
      (redir && /login|signin|auth|session/i.test((redir.pathname || "") + (redir.search || ""))) ||
      (redir && /accounts\.google\.com|auth|login/i.test(redir.hostname));

    const sameHost = redir && (redir.hostname === target.hostname);
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
async function scrapeChat(url, browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Referer: new URL(url).origin + "/",
    "Upgrade-Insecure-Requests": "1",
  });

  const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 }).catch((e) => e);
  if (!resp || (typeof resp.status === "function" && resp.status() >= 400)) {
    const st = typeof resp?.status === "function" ? resp.status() : 0;
    await page.close();
    throw new Error(`Navigation failed (${st || "unknown"})`);
  }

  const hostname = new URL(url).hostname;

  // Gemini: try granular turns first
  let extracted;
  if (hostname.includes("gemini.google.com")) {
    extracted = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('c-wiz[role="list"] [role="listitem"], [role="listitem"]'));
      const blocks = items.map(el => el.innerText?.trim()).filter(Boolean);
      if (blocks.length > 0) return blocks.join("\n\n---TURN---\n\n");
      const m = document.querySelector("main");
      return m?.innerText?.trim() || "";
    });
  }

  if (!extracted || extracted.length < 60) {
    const selectors = getSelectorsForDomain(hostname);
    extracted = await page.evaluate((sels) => {
      const pile = [];
      const seen = new Set();
      const pushText = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        const t = el.innerText?.trim();
        if (t) pile.push(t);
      };
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach(pushText);
        if (pile.length > 0) break;
      }
      return pile.join("\n\n");
    }, selectors);
  }

  if (!extracted || extracted.length < 60) {
    const html = await page.content();
    extracted = htmlToText(html, { wordwrap: false }).trim();
  }

  await page.close();

  // Trim Gemini header noise
  if (hostname.includes("gemini.google.com")) {
    extracted = stripGeminiHeader(extracted);
  }

  return extracted.replace(/\n{3,}/g, "\n\n").trim();
}

function getSelectorsForDomain(hostname) {
  if (hostname.includes("gemini.google.com")) {
    return ['c-wiz[role="list"] [role="listitem"]', '[role="listitem"]', 'main'];
  }
  if (hostname.includes("chatgpt") || hostname.includes("openai")) {
    return ['[data-testid="conversation-turn"]', 'article', 'main'];
  }
  if (hostname.includes("x.ai") || hostname.includes("grok.com")) {
    return ['div[data-testid="message-bubble"]', 'main'];
  }
  if (hostname.includes("lechat.mistral.ai")) {
    return ['div[class*="conversation-turn"]', 'main'];
  }
  if (hostname.includes("claude.ai")) {
    return ['main [data-testid="message"]', 'main article', 'main'];
  }
  return ["body"];
}

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
function stripLeadingLabels(s) {
  return s
    .replace(/^You said:\s*/i, "")
    .replace(/^User:\s*/i, "")
    .replace(/^Assistant:\s*/i, "")
    .replace(/^ChatGPT said:\s*/i, "")
    .replace(/^System:\s*/i, "")
    .trim();
}

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

  // Strong Gemini fallback: if only one speaker or a single block → alternate by paragraph starting with user
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

// Group into user/assistant pairs (system messages omitted from pairs but kept in messages)
function toPairs(messages) {
  const pairs = [];
  let cur = { user: "", assistant: "" };
  let haveContent = false;

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (haveContent) { pairs.push(cur); cur = { user: "", assistant: "" }; haveContent = false; }
      cur.user = (cur.user ? cur.user + "\n\n" : "") + m.text;
      haveContent = true;
    } else if (m.role === "assistant") {
      cur.assistant = (cur.assistant ? cur.assistant + "\n\n" : "") + m.text;
      haveContent = true;
      // if both sides filled, push and reset
      if (cur.user && cur.assistant) { pairs.push(cur); cur = { user: "", assistant: "" }; haveContent = false; }
    }
  }
  if (haveContent && (cur.user || cur.assistant)) pairs.push(cur);
  return pairs;
}

// ---------- API handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return error(res, 405, "METHOD_NOT_ALLOWED", "Use POST /api/extract");
  }

  const { url, content, format = "messages" } = req.body || {};
  if (!url && !content) {
    return error(res, 400, "INVALID_INPUT", "Provide a single chat URL (url) or raw content (content).");
  }

  // Raw content path (no scraping)
  if (content?.trim() && !url) {
    const messages = parseMessages(content.trim(), "custom-content");
    const body = { ok: true, host: "custom-content", count: messages.length, messages };
    if (format === "pairs") body.pairs = toPairs(messages);
    return res.status(200).json(body);
  }

  // URL path
  let u;
  try { u = new URL(url); } catch { return error(res, 400, "BAD_URL", "Invalid URL."); }
  if (String(url).length > MAX_URL_LENGTH) {
    return error(res, 400, "URL_TOO_LONG", "URL exceeds maximum length.");
  }
  if (!ALLOWED_DOMAINS.some((d) => u.hostname.endsWith(d))) {
    return error(res, 400, "DOMAIN_NOT_ALLOWED", "This domain is not supported.", { host: u.hostname });
  }

  // Preflight for public access (catches private Claude/Gemini shares)
  const pre = await checkPublicAccess(u.toString());
  if (!pre.ok) {
    return error(res, 422, "PRIVATE_SHARE", pre.message, { status: pre.status, location: pre.location });
  }

  const BROWSERLESS_WS_URL = process.env.BROWSERLESS_WS_URL;
  if (!BROWSERLESS_WS_URL) {
    return error(res, 500, "BROWSERLESS_MISSING", "Set BROWSERLESS_WS_URL in env variables.");
  }

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: BROWSERLESS_WS_URL });
    const raw = await scrapeChat(u.toString(), browser);
    if (!raw || raw.length < 60) {
      await safeDisconnect(browser);
      return error(res, 422, "EXTRACT_EMPTY", "Could not extract enough text.");
    }
    if (raw.length > MAX_TEXT_LENGTH) {
      await safeDisconnect(browser);
      return error(res, 422, "EXTRACT_TOO_LARGE", "Extracted text is too large.");
    }

    const messages = parseMessages(raw, u.hostname);
    await safeDisconnect(browser);

    const body = { ok: true, host: u.hostname, count: messages.length, messages };
    if (format === "pairs") body.pairs = toPairs(messages);
    return res.status(200).json(body);
  } catch (e) {
    await safeDisconnect(browser);
    return error(res, 500, "SCRAPE_FAILED", "Failed to extract conversation.", { message: e?.message });
  }
}

async function safeDisconnect(browser) {
  try { await browser.disconnect(); } catch {}
}