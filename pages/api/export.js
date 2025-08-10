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
      const safeName = hostname.replace(/\./g, "_");
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
  const customFont = await pdfDoc.embedFont(fontBytes);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 40;
  const bubblePadding = 10;
  const bubbleRadius = 8;
  const fontSize = 12;
  const lineHeight = 16;

  const messages = chatText.split(/\n\s*\n/).map(block => {
    const trimmed = block.trim();
    if (/^system:/i.test(trimmed)) return { role: "system", text: trimmed.replace(/^system:\s*/i, "") };
    if (/^user:/i.test(trimmed)) return { role: "user", text: trimmed.replace(/^user:\s*/i, "") };
    if (/^assistant:/i.test(trimmed)) return { role: "assistant", text: trimmed.replace(/^assistant:\s*/i, "") };
    return { role: "assistant", text: trimmed };
  });

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  page.drawText(`Chat Export - ${sourceHost}`, {
    x: margin,
    y,
    size: 16,
    font: customFont,
    color: rgb(0, 0, 0)
  });
  y -= 30;

  for (const { role, text } of messages) {
    const isUser = role === "user";
    const isSystem = role === "system";

    const bgColor = isSystem ? rgb(1, 1, 0.85) : isUser ? rgb(0.2, 0.6, 0.95) : rgb(0.9, 0.9, 0.9);
    const textColor = isUser ? rgb(1, 1, 1) : rgb(0, 0, 0);

    const maxBubbleWidth = pageWidth * 0.65;
    const wrappedLines = wrapText(text, customFont, fontSize, maxBubbleWidth - bubblePadding * 2);
    const bubbleHeight = wrappedLines.length * lineHeight + bubblePadding * 2;

    if (y - bubbleHeight < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }

    const bubbleX = isUser ? pageWidth - margin - maxBubbleWidth : margin;
    page.drawRectangle({
      x: bubbleX,
      y: y - bubbleHeight,
      width: maxBubbleWidth,
      height: bubbleHeight,
      color: bgColor,
      borderRadius: bubbleRadius
    });

    let textY = y - bubblePadding - fontSize;
    for (const line of wrappedLines) {
      const isRTL = /[\u0590-\u05FF\u0600-\u06FF]/.test(line);
      page.drawText(line, {
        x: isRTL
          ? bubbleX + maxBubbleWidth - bubblePadding - customFont.widthOfTextAtSize(line, fontSize)
          : bubbleX + bubblePadding,
        y: textY,
        size: fontSize,
        font: customFont,
        color: textColor
      });
      textY -= lineHeight;
    }

    y -= bubbleHeight + 10;
  }

  return pdfDoc.save();
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