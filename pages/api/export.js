import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { htmlToText } from "html-to-text";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

function error(res, status, code, message, details = {}) {
  return res.status(status).json({
    ok: false,
    code,
    message,
    suggestions: suggest(code),
    details
  });
}

function suggest(code) {
  const common = [
    "Open the share URL in your browser to confirm it loads and is public.",
    "If the link fails, copy/paste the chat text instead."
  ];
  const map = {
    METHOD_NOT_ALLOWED: ["Use POST /api/export"],
    INVALID_INPUT: ["Paste chat text or a valid https:// URL.", ...common],
    INVALID_URL: ["URL must start with http:// or https://.", ...common],
    BROWSER_LAUNCH_FAILED: [
      "Headless browser failed to start. Retry or paste the text.",
      "If on Vercel, ensure Node 20 and sufficient memory/duration are configured."
    ],
    NAVIGATION_TIMEOUT: [
      "Timed out loading the page (slow site or blocked). Try again or paste text."
    ],
    NAVIGATION_FAILED_STATUS: [
      "The site returned a non-OK status during navigation.",
      "Ensure the link is public and not permission-gated."
    ],
    EXTRACT_EMPTY: [
      "Page loaded but no readable chat text was found.",
      "Some share pages render content dynamically; try pasting text."
    ],
    EXTRACT_ERROR: [
      "The page loaded but text extraction failed.",
      "Paste the chat text as a fallback."
    ],
    PDF_ERROR: ["PDF generation failed unexpectedly.", "Try with shorter content."]
  };
  return map[code] || common;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return error(res, 405, "METHOD_NOT_ALLOWED", "Use POST /api/export");
  }

  const { title = "Chat Export", content = "", url = "" } = req.body || {};

  // 1) Get finalText either from URL via headless browser, or from raw text
  let finalText = "";

  if (url && typeof url === "string" && url.trim()) {
    // Validate URL
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return error(res, 400, "INVALID_URL", "Provided URL is invalid.", { url });
    }

    // Launch headless Chromium suitable for Vercel/serverless
    let browser;
    try {
      const executablePath = await chromium.executablePath();
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true
      });
    } catch (e) {
      return error(
        res,
        502,
        "BROWSER_LAUNCH_FAILED",
        "Failed to start headless browser.",
        { name: e?.name, message: e?.message }
      );
    }

    try {
      const page = await browser.newPage();

      // Pretend to be a real browser
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      );
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9"
      });

      // Navigate and wait for network to be mostly idle
      const NAV_TIMEOUT = 25000;
      try {
        const resp = await page.goto(parsed.toString(), {
          waitUntil: "networkidle2",
          timeout: NAV_TIMEOUT
        });
        const status = resp?.status() || 0;
        if (status >= 400) {
          await browser.close();
          return error(
            res,
            400,
            "NAVIGATION_FAILED_STATUS",
            `Navigation failed with status ${status}.`,
            { status, url }
          );
        }
      } catch (e) {
        await browser.close();
        const isTimeout = /Timeout/i.test(e?.message || "");
        return error(
          res,
          isTimeout ? 504 : 502,
          isTimeout ? "NAVIGATION_TIMEOUT" : "BROWSER_LAUNCH_FAILED",
          isTimeout
            ? "Timed out loading the page."
            : "Failed during page navigation.",
          { url, name: e?.name, message: e?.message }
        );
      }

      // Heuristics: try 'main' first, then known app roots, then body
      // Also give the SPA a small settle delay
      await page.waitForTimeout(1000);
      let extracted = await page.evaluate(() => {
        const pick = (sel) => document.querySelector(sel)?.innerText?.trim();
        return (
          pick("main") ||
          pick("#__next") ||
          pick("#root") ||
          document.body?.innerText?.trim() ||
          ""
        );
      });

      // Extra: If it's clearly too short, try a longer wait and re-check
      if (!extracted || extracted.length < 40) {
        await page.waitForTimeout(1500);
        extracted = await page.evaluate(() => {
          const pick = (sel) => document.querySelector(sel)?.innerText?.trim();
          return (
            pick("main") ||
            pick("#__next") ||
            pick("#root") ||
            document.body?.innerText?.trim() ||
            ""
          );
        });
      }

      await browser.close();

      if (!extracted || extracted.length < 40) {
        return error(
          res,
          422,
          "EXTRACT_EMPTY",
          "Fetched the page but could not find readable chat text.",
          { url, extractedLength: extracted?.length || 0 }
        );
      }

      // Optional: light cleanup using html-to-text to normalize whitespace
      try {
        finalText = htmlToText(extracted, {
          wordwrap: false
        }).trim();
      } catch {
        // Fallback to raw extracted text
        finalText = extracted;
      }
    } catch (e) {
      try {
        if (browser) await browser.close();
      } catch {}
      return error(res, 422, "EXTRACT_ERROR", "Failed to extract text.", {
        url,
        name: e?.name,
        message: e?.message
      });
    }
  } else if (content && content.trim()) {
    finalText = String(content).trim();
  } else {
    return error(res, 400, "INVALID_INPUT", "Provide chat text or a share URL.");
  }

  // 2) Generate PDF
  try {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageMargin = 50;
    const pageWidth = 595.28;   // A4 width (pt)
    const pageHeight = 841.89;  // A4 height (pt)
    const fontSizeTitle = 18;
    const fontSizeBody = 11;
    const lineHeight = 15;

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - pageMargin;

    const titleText = String(title || "Chat Export");
    page.drawText(titleText, {
      x: pageMargin,
      y: y - fontSizeTitle,
      size: fontSizeTitle,
      font: fontBold,
      color: rgb(0, 0, 0)
    });
    y -= fontSizeTitle + 20;

    const maxWidth = pageWidth - pageMargin * 2;
    const words = finalText.replace(/\r\n/g, "\n").split(/\s+/);
    let line = "";

    const commit = (t) => {
      if (y < pageMargin + lineHeight) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - pageMargin;
      }
      page.drawText(t, { x: pageMargin, y, size: fontSizeBody, font, color: rgb(0, 0, 0) });
      y -= lineHeight;
    };

    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(test, fontSizeBody) > maxWidth) {
        commit(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) commit(line);

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(title || "chat")}.pdf"`
    );
    return res.status(200).send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("[PDF_ERROR]", err);
    return error(res, 500, "PDF_ERROR", "Failed to generate PDF.", {
      name: err?.name,
      message: err?.message
    });
  }
}