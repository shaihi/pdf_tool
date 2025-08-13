// pages/api/export.js
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { htmlToText } from "html-to-text";
import puppeteer from "puppeteer-core";
import JSZip from "jszip";
import fs from "fs";
import path from "path";

// ---- Config / Security ----
const BLOCKED_DOMAINS = []; // none blocked now
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// NEW: preflight public-access checker (detects login redirects / 4xx/5xx)
// replace checkPublicAccess with this
async function checkPublicAccess(u) {
  try {
    const r = await fetch(u, { method: "GET", redirect: "manual" });
    const status = r.status;
    const loc = r.headers.get("location") || "";
    const target = new URL(u);
    const redir = loc ? new URL(loc, target.origin) : null;

    const toLogin =
      (redir && /login|signin|auth|session/i.test(redir.pathname + redir.search)) ||
      (redir && /accounts\.google\.com|auth|login/i.test(redir.hostname));

    // OK if:
    // - 200, OR
    // - 3xx redirect that stays within claude.ai (or same host) AND not to a login/auth path
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

// ---- Handler ----
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return error(res, 405, "METHOD_NOT_ALLOWED", "Use POST /api/export");
  }

  let { title = "Chat Export", urls = [], url = "", content = "" } = req.body || {};
  if (!Array.isArray(urls)) urls = typeof urls === "string" ? urls.split(/\s+/).filter(Boolean) : [];
  if (urls.length === 0 && typeof url === "string" && url.trim()) {
    urls = url.split(/\s+/).map((u) => u.trim()).filter(Boolean);
  }

  // Title sanitize
  title = String(title).replace(/[<>:"/\\|?*\x00-\x1F]/g, "").slice(0, 100) || "chat";

  // Content-only single PDF
  if (urls.length === 0 && content?.trim()) {
    try {
      const pdfBytes = await buildStyledPdf(content.trim(), "custom-content");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${title}_${Date.now()}.pdf"`);
      return res.status(200).send(Buffer.from(pdfBytes));
    } catch (e) {
      return error(res, 500, "PDF_ERROR", "Failed to generate PDF.", { message: e?.message });
    }
  }

  if (urls.length === 0) {
    return error(res, 400, "INVALID_INPUT", "Provide at least one chat URL or some chat text.");
  }

  // Validate URLs & domains
  const cleaned = [];
  for (const raw of urls) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_URL_LENGTH) continue;
    let u;
    try { u = new URL(raw); } catch { continue; }
    const host = u.hostname.toLowerCase();

    if (BLOCKED_DOMAINS.some((d) => host.endsWith(d))) {
      return error(res, 400, "DOMAIN_BLOCKED", "This domain is not supported.", { url: raw, domain: host });
    }
    if (!ALLOWED_DOMAINS.some((d) => host.endsWith(d))) continue;
    cleaned.push(u);
  }
  if (cleaned.length === 0) {
    return error(res, 400, "NO_ALLOWED_URLS", "No URLs with allowed domains were provided.");
  }

  // Single URL → return a single PDF (per-row Download PDF)
  if (cleaned.length === 1) {
    const u = cleaned[0];

    // NEW: preflight public access (helps with Claude private shares)
    const pre = await checkPublicAccess(u.toString());
    if (!pre.ok) {
      return error(
        res,
        422,
        "PRIVATE_SHARE",
        pre.message,
        { url: u.toString(), status: pre.status, location: pre.location }
      );
    }

    const BROWSERLESS_WS_URL = process.env.BROWSERLESS_WS_URL;
    if (!BROWSERLESS_WS_URL) {
      return error(res, 500, "BROWSERLESS_MISSING", "Set BROWSERLESS_WS_URL in env variables.");
    }

    let browser;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: BROWSERLESS_WS_URL });
      const text = await scrapeChat(u.toString(), browser);
      if (!text || text.length < 60 || text.length > MAX_TEXT_LENGTH) {
        await safeDisconnect(browser);
        return error(res, 422, "EXTRACT_EMPTY", "Could not extract enough text.", {
          url: u.toString(),
          length: text?.length || 0,
        });
      }
      const pdfBytes = await buildStyledPdf(text, u.hostname);
      await safeDisconnect(browser);

      const base = u.hostname.replace(/\./g, "_");
      const unique = Date.now();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${base}_${unique}.pdf"`);
      return res.status(200).send(Buffer.from(pdfBytes));
    } catch (e) {
      await safeDisconnect(browser);
      return error(res, 422, "SINGLE_URL_ERROR", "Failed to export this URL.", {
        url: u.toString(),
        message: e?.message,
      });
    }
  }

  // Multi URL → build a ZIP
  const BROWSERLESS_WS_URL = process.env.BROWSERLESS_WS_URL;
  if (!BROWSERLESS_WS_URL) {
    return error(res, 500, "BROWSERLESS_MISSING", "Set BROWSERLESS_WS_URL in env variables.");
  }

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: BROWSERLESS_WS_URL });
  } catch (e) {
    return error(res, 502, "BROWSER_CONNECT_FAILED", "Could not connect to Browserless.", {
      name: e?.name, message: e?.message
    });
  }

  const zip = new JSZip();
  let index = 0;

  for (const u of cleaned) {
    try {
      const pre = await checkPublicAccess(u.toString());
      if (!pre.ok) {
        console.warn("Skipping private/blocked:", u.toString(), pre.status, pre.location);
        continue;
      }

      const text = await scrapeChat(u.toString(), browser);
      if (!text || text.length < 60 || text.length > MAX_TEXT_LENGTH) continue;

      const pdfBytes = await buildStyledPdf(text, u.hostname);
      const base = u.hostname.replace(/\./g, "_");
      const unique = `${Date.now()}_${index++}`;
      zip.file(`${base}_${unique}.pdf`, pdfBytes);
    } catch (e) {
      console.error("Export error:", u.toString(), e?.message || e);
    }
  }

  await safeDisconnect(browser);

  if (Object.keys(zip.files).length === 0) {
    return error(res, 422, "NO_VALID_PDFS", "No valid PDFs could be generated.");
  }

  const zipBytes = await zip.generateAsync({ type: "nodebuffer" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${title}.zip"`);
  return res.status(200).send(zipBytes);
}

// ---- Scraping ----
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

  // Prefer granular extraction for Gemini: each listitem is a turn
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

  // Remove Gemini header noise so first "turn" is the user question
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

// Strip Gemini page header block
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

// Force proper bidi for mixed Hebrew/Latin/nums using isolates
function shapeBidi(line) {
  const hasRTL = /[\u0590-\u05FF\u0600-\u06FF]/.test(line);
  if (!hasRTL) return line;
  return line
    .replace(/([A-Za-z0-9@.#:_/+-]+)/g, '\u2066$1\u2069') // LRI … PDI around Latin/nums
    .replace(/\u2066\u2069/g, ""); // clean empties
}

// Role parsing (ChatGPT markers + Gemini fallbacks)
function parseMessages(raw, sourceHost = "") {
  const isGemini = /gemini\.google\.com$/.test(sourceHost);

  if (isGemini && raw.includes('---TURN---')) {
    const parts = raw.split(/\n?\s*---TURN---\s?\n?/).map(s => s.trim()).filter(Boolean);
    let role = "user";
    return parts.map(p => {
      const text = p.replace(/^(You said:|User:|Assistant:|ChatGPT said:|System:)\s*/i, "").trim();
      const m = { role, text };
      role = role === "user" ? "assistant" : "user";
      return m;
    });
  }

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
  let currentRole = isGemini ? "assistant" : "assistant";
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

  // Strong Gemini fallback: no markers or one speaker → alternate by paragraph starting with USER
  const onlyOneSpeaker = messages.length <= 1 || messages.every(m => m.role === messages[0].role);
  if (isGemini && onlyOneSpeaker) {
    const paras = String(raw)
      .split(/\n{2,}/)
      .map(s => s.trim())
      .filter(Boolean);
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

function stripLeadingLabels(s) {
  return s
    .replace(/^You said:\s*/i, "")
    .replace(/^User:\s*/i, "")
    .replace(/^Assistant:\s*/i, "")
    .replace(/^ChatGPT said:\s*/i, "")
    .replace(/^System:\s*/i, "")
    .trim();
}

// ---- PDF building (chat bubbles, no labels, RTL-aware) ----
async function buildStyledPdf(chatText, sourceHost) {
  const fontPath = path.join(process.cwd(), "public", "fonts", "DejaVuSans.ttf");
  const fontBytes = fs.readFileSync(fontPath);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fontBytes);

  const pageWidth = 595.28, pageHeight = 841.89;
  const margin = 36;
  const maxBubbleWidth = Math.floor((pageWidth - margin * 2) * 0.70);
  const bubblePad = 10;
  const radius = 10;
  const fontSize = 12;
  const lineHeight = 16;

  const messages = parseMessages(chatText, sourceHost);

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  page.drawText(`Chat Export - ${sourceHost}`, { x: margin, y, size: 16, font, color: rgb(0,0,0) });
  y -= 26;

  for (const m of messages) {
    const isUser = m.role === "user";
    const isSystem = m.role === "system";
    const bg = isSystem ? rgb(1.00, 0.98, 0.78) : isUser ? rgb(0.16, 0.45, 0.90) : rgb(0.88, 0.90, 0.96);
    const fg = isUser ? rgb(1,1,1) : rgb(0,0,0);

    const lines = wrapText(m.text, font, fontSize, maxBubbleWidth - bubblePad * 2);
    const bubbleHeight = lines.length * lineHeight + bubblePad * 2;
    if (y - bubbleHeight < margin) { page = pdfDoc.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }

    const rightSide = isUser;
    const bubbleX = rightSide ? pageWidth - margin - maxBubbleWidth : margin;

    page.drawRectangle({ x: bubbleX, y: y - bubbleHeight, width: maxBubbleWidth, height: bubbleHeight, color: bg, borderRadius: radius });

    let textY = y - bubblePad - fontSize;
    for (const rawLine of lines) {
      const shaped = shapeBidi(rawLine);
      const logicalWidth = font.widthOfTextAtSize(rawLine, fontSize);
      const tx = (/\u0590-\u05FF|\u0600-\u06FF/.test(rawLine) || rightSide)
        ? bubbleX + maxBubbleWidth - bubblePad - logicalWidth
        : bubbleX + bubblePad;
      page.drawText(shaped, { x: tx, y: textY, size: fontSize, font, color: fg });
      textY -= lineHeight;
    }

    y -= bubbleHeight + 10;
  }

  return pdfDoc.save();
}

// ---- Helpers ----
function wrapText(text, font, fontSize, maxWidth) {
  const words = String(text).split(/\s+/);
  let lines = [], line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(test, fontSize) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function safeDisconnect(browser) {
  try { await browser.disconnect(); } catch {}
}

async function clickByText(page, labels) {
  try {
    await page.evaluate((texts) => {
      const tryClick = (t) => {
        const xp = `//button[normalize-space(text())='${t}'] | //*[self::button or self::a or self::div][contains(@role,'button')][normalize-space(text())='${t}']`;
        const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        if (r.snapshotLength > 0) { (r.snapshotItem(0)).click(); return true; }
        return false;
      };
      for (const t of texts) if (tryClick(t)) break;
    }, labels);
  } catch {}
}