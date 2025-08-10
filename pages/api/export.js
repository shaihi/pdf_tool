import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { htmlToText } from "html-to-text";
import puppeteer from "puppeteer-core";
import JSZip from "jszip";
import fs from "fs";
import path from "path";

const ALLOWED_DOMAINS = [
  "chat.openai.com",
  "chatgpt.com",
  "gemini.google.com",
  "x.ai",
  "grok.com",
  "lechat.mistral.ai"
];

const MAX_URL_LENGTH = 500;
const MAX_TEXT_LENGTH = 50000;

function error(res, status, code, message, details = {}) {
  return res.status(status).json({ ok: false, code, message, details });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return error(res, 405, "METHOD_NOT_ALLOWED", "Use POST /api/export");
  }

  let { title = "Chat Export", urls = [], content = "" } = req.body || {};
  if (!Array.isArray(urls)) urls = urls ? [urls] : [];

  title = String(title).replace(/[<>:"/\\|?*\x00-\x1F]/g, "").slice(0, 100) || "chat";

  if (urls.length === 0 && content?.trim()) {
    return renderSinglePdf(content.trim(), title, res);
  }

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

  for (const url of urls) {
    if (typeof url !== "string" || url.length > MAX_URL_LENGTH) continue;
    let hostname;
    try { hostname = new URL(url).hostname; } catch { continue; }
    if (!ALLOWED_DOMAINS.some(d => hostname.endsWith(d))) continue;

    try {
      const text = await scrapeChat(url, browser);
      if (text.length > MAX_TEXT_LENGTH) continue;

      const pdfBytes = await buildStyledPdf(text, hostname);
      const timestamp = Date.now();
      const safeName = `${hostname.replace(/\./g, "_")}_${timestamp}`;
      zip.file(`${safeName}.pdf`, pdfBytes);
    } catch (err) {
      console.error(`Error processing ${url}:`, err);
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

async function scrapeChat(url, browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const hostname = new URL(url).hostname;
  const selectors = getSelectorsForDomain(hostname);

  let extracted = await page.evaluate((sels) => {
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

  if (!extracted || extracted.length < 60) {
    const html = await page.content();
    extracted = htmlToText(html, { wordwrap: false }).trim();
  }

  await page.close();
  return extracted.replace(/\n{3,}/g, "\n\n").trim();
}

function getSelectorsForDomain(hostname) {
  if (hostname.includes("chatgpt") || hostname.includes("openai")) {
    return ['[data-testid="conversation-turn"]', 'article'];
  }
  if (hostname.includes("gemini.google.com")) {
    return ['c-wiz[role="list"]', 'div[role="listitem"]'];
  }
  if (hostname.includes("x.ai") || hostname.includes("grok.com")) {
    return ['div[data-testid="message-bubble"]'];
  }
  if (hostname.includes("lechat.mistral.ai")) {
    return ['div[class*="conversation-turn"]'];
  }
  return ["body"];
}

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

  // NEW: structured messages
  const messages = parseMessages(chatText);

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  // Title
  page.drawText(`Chat Export - ${sourceHost}`, {
    x: margin, y, size: 16, font, color: rgb(0, 0, 0)
  });
  y -= 26;

  for (const m of messages) {
    const isUser = m.role === "user";
    const isSystem = m.role === "system";

    // Visible colors
    const bg = isSystem ? rgb(1.00, 0.98, 0.78)       // light yellow
             : isUser  ? rgb(0.16, 0.45, 0.90)       // blue
                        : rgb(0.88, 0.90, 0.96);     // gray-blue
    const fg = isUser ? rgb(1, 1, 1) : rgb(0, 0, 0);

    const lines = wrapText(m.text, font, fontSize, maxBubbleWidth - bubblePad * 2);
    const bubbleHeight = lines.length * lineHeight + bubblePad * 2;

    if (y - bubbleHeight < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }

    const rightSide = isUser; // user → right; assistant/system → left
    const bubbleX = rightSide ? pageWidth - margin - maxBubbleWidth : margin;

    // Bubble
    page.drawRectangle({
      x: bubbleX,
      y: y - bubbleHeight,
      width: maxBubbleWidth,
      height: bubbleHeight,
      color: bg,
      borderRadius: radius
    });

    // Text (line-level RTL)
    let textY = y - bubblePad - fontSize;
    for (const line of lines) {
      const isRTL = /[\u0590-\u05FF\u0600-\u06FF]/.test(line);
      const lineWidth = font.widthOfTextAtSize(line, fontSize);
      const tx = (isRTL || rightSide)
        ? bubbleX + maxBubbleWidth - bubblePad - lineWidth
        : bubbleX + bubblePad;
      page.drawText(line, { x: tx, y: textY, size: fontSize, font, color: fg });
      textY -= lineHeight;
    }

    y -= bubbleHeight + 10;
  }

  return pdfDoc.save();
}

// NEW: parses your exported text into {role, text}[]
function parseMessages(raw) {
  // Remove obvious meta-only lines
  const dropExact = [
    /^sources$/i,
    /^source$/i,
    /^thought for \d+s$/i
  ];
  const dropStarts = [
    /^community\.vercel\.com/i, /^uibakery\.io/i, /^tekpon\.com/i, /^toolsforhumans\.ai/i,
    /^vercel\.com$/i
  ];

  const lines = String(raw)
    .split(/\n+/)
    .map(s => s.trim())
    .filter(s => s && !dropExact.some(rx => rx.test(s)) && !dropStarts.some(rx => rx.test(s)));

  // Collapse to paragraphs
  const paragraphs = [];
  let buf = [];
  for (const l of lines) {
    if (/^(You said:|Assistant:|ChatGPT said:|System:|User:|Assistant)/i.test(l)) {
      if (buf.length) { paragraphs.push(buf.join(" ").trim()); buf = []; }
      paragraphs.push(l); // keep marker as its own paragraph
    } else {
      buf.push(l);
    }
  }
  if (buf.length) paragraphs.push(buf.join(" ").trim());

  // Build messages using markers, with alternation fallback
  const messages = [];
  let currentRole = "assistant"; // start from assistant by default for shared pages
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
      /^Assistant:|^ChatGPT said:/i.test(p) ? "assistant" :
      /^System:/i.test(p) ? "system" : null;

    if (marker) {
      flush();
      currentRole = marker;
    } else {
      // No explicit marker → append to current block
      currentText.push(p);
    }
  }
  flush();

  // If everything ended up in one role, do a gentle alternation pass to improve readability
  const uniqueRoles = new Set(messages.map(m => m.role));
  if (uniqueRoles.size === 1 && messages.length > 1) {
    let alt = "assistant";
    for (const m of messages) {
      m.role = alt = (alt === "assistant" ? "user" : "assistant");
    }
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

function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(/\s+/);
  let lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? currentLine + " " + word : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

async function renderSinglePdf(content, title, res) {
  const pdfBytes = await buildStyledPdf(content, "custom-content");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${title}.pdf"`);
  return res.status(200).send(Buffer.from(pdfBytes));
}

async function safeDisconnect(browser) {
  try { await browser.disconnect(); } catch {}
}