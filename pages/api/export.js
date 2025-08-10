import { PDFDocument, rgb } from "pdf-lib";
import { htmlToText } from "html-to-text";
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import fontkit from "fontkit";

function error(res, status, code, message, details = {}) {
  return res.status(status).json({ ok: false, code, message, details });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return error(res, 405, "METHOD_NOT_ALLOWED", "Use POST /api/export");
  }

  const { title = "Chat Export", content = "", url = "" } = req.body || {};

  if (!url || !/^https?:\/\//i.test(url)) {
    if (!content?.trim()) return error(res, 400, "INVALID_INPUT", "Provide chat text or a share URL.");
    return renderPdf(content.trim(), title, res);
  }

  try { new URL(url); } catch { return error(res, 400, "INVALID_URL", "Invalid URL.", { url }); }

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

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => e);
    if (!resp || (typeof resp.status === "function" && resp.status() >= 400)) {
      const status = typeof resp?.status === "function" ? resp.status() : 0;
      await safeDisconnect(browser);
      return error(res, 400, "NAVIGATION_FAILED_STATUS",
        `Navigation failed with status ${status || "unknown"}.`, { url, status });
    }

    await safeClickByText(page, ["Accept", "I agree", "Got it", "Continue"]);
    await sleep(800);

    const candidateSelectors = [
      '[data-testid="conversation-turn"]',
      '[data-message-author]',
      '[data-message-id]',
      'article',
      'main [class*="conversation"]',
      'main',
      '#__next'
    ];

    try { await page.waitForSelector(candidateSelectors.join(","), { timeout: 8000 }); } catch {}
    await sleep(1200);
    await safeClickByText(page, ["Show more", "Expand", "See more"]);
    await sleep(500);

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
        if (pile.length > 0 && (sel.includes("[data-") || sel === "article")) break;
      }
      if (pile.length === 0) {
        const t = document.body?.innerText?.trim();
        if (t) pile.push(t);
      }
      return pile.join("\n\n");
    }, candidateSelectors);

    if (!extracted || extracted.length < 60) {
      const html = await page.content();
      try {
        extracted = htmlToText(html, {
          selectors: [
            { selector: "script", format: "skip" },
            { selector: "style",  format: "skip" },
            { selector: "nav",    format: "skip" },
            { selector: "footer", format: "skip" },
            { selector: "header", format: "skip" }
          ],
          baseElements: { selectors: ["main", "#__next", "body"] },
          wordwrap: false
        }).trim();
      } catch {}
    }

    await safeDisconnect(browser);

    if (!extracted || extracted.length < 60) {
      return error(res, 422, "EXTRACT_EMPTY",
        "Fetched the page but could not find readable chat text.",
        { url, extractedLength: extracted?.length || 0 });
    }

    const finalText = extracted.replace(/\n{3,}/g, "\n\n").trim();
    return renderPdf(finalText, title, res);
  } catch (e) {
    await safeDisconnect(browser);
    return error(res, 422, "EXTRACT_ERROR", "Failed to extract text from the page.", {
      url, name: e?.name, message: e?.message
    });
  }
}

async function safeClickByText(page, labels) {
  try {
    await page.evaluate((texts) => {
      const findBtn = (t) => {
        const xpath = `//button[normalize-space(text())='${t}'] | //*[self::button or self::a or self::div][contains(@role,'button')][normalize-space(text())='${t}']`;
        const r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        if (r.snapshotLength > 0) { (r.snapshotItem(0)).click(); return true; }
        return false;
      };
      for (const t of texts) if (findBtn(t)) break;
    }, labels);
  } catch {}
}

async function safeDisconnect(browser) {
  try { await browser.disconnect(); } catch {}
}

async function renderPdf(finalText, title, res) {
  try {
    // Strip/replace unsupported characters (keep ASCII only)
    const sanitizedText = String(finalText).replace(/[^\x00-\x7F]/g, '?');

    const pdfDoc = await PDFDocument.create();
    const customFont = await pdfDoc.embedFont(PDFDocument.PDFFonts.Helvetica); // built-in font

    const pageMargin = 50, pageWidth = 595.28, pageHeight = 841.89;
    const fontSizeTitle = 18, fontSizeBody = 11, lineHeight = 15;

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - pageMargin;

    page.drawText(String(title || "Chat Export"), {
      x: pageMargin, y: y - fontSizeTitle, size: fontSizeTitle, font: customFont, color: rgb(0,0,0)
    });
    y -= fontSizeTitle + 20;

    const maxWidth = pageWidth - pageMargin * 2;
    const words = sanitizedText.replace(/\r\n/g, "\n").split(/\s+/);
    let line = "";
    const commit = (t) => {
      if (y < pageMargin + lineHeight) { page = pdfDoc.addPage([pageWidth, pageHeight]); y = pageHeight - pageMargin; }
      page.drawText(t, { x: pageMargin, y, size: fontSizeBody, font: customFont, color: rgb(0,0,0) });
      y -= lineHeight;
    };
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (customFont.widthOfTextAtSize(test, fontSizeBody) > maxWidth) { commit(line); line = w; } else { line = test; }
    }
    if (line) commit(line);

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(title || "chat")}.pdf"`);
    return res.status(200).send(Buffer.from(pdfBytes));
  } catch (err) {
    return error(res, 500, "PDF_ERROR", "Failed to generate PDF.", { name: err?.name, message: err?.message });
  }
}