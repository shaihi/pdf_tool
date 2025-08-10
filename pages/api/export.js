import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { htmlToText } from "html-to-text";

function error(res, status, code, message, details = {}) {
  return res
    .status(status)
    .json({ ok: false, code, message, suggestions: suggest(code), details });
}

function suggest(code) {
  const common = [
    "If this is a share URL, open it in your browser to confirm it loads.",
    "If the link fails repeatedly, copy/paste the chat text instead."
  ];
  const map = {
    INVALID_INPUT: [
      "Paste chat text or a valid https:// URL.",
      ...common
    ],
    INVALID_URL: [
      "Double-check the URL format (must start with http:// or https://).",
      ...common
    ],
    FETCH_TIMEOUT: [
      "The remote site took too long to respond.",
      "Try again later or paste the chat text.",
    ],
    FETCH_FAILED_STATUS: [
      "The site returned a non-OK status (e.g., 403/404).",
      "Ensure the link is publicly accessible (not private).",
      ...common
    ],
    FETCH_ERROR: [
      "A network/DNS error occurred while fetching the page.",
      ...common
    ],
    EXTRACT_EMPTY: [
      "The page loaded but no readable chat text was found.",
      "Some share pages render content dynamically; paste the text instead.",
    ],
    PDF_ERROR: [
      "PDF generation failed unexpectedly.",
      "Try with shorter content or paste plain text.",
    ],
  };
  return map[code] || common;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return error(res, 405, "METHOD_NOT_ALLOWED", "Use POST /api/export");
  }

  try {
    const { title = "Chat Export", content = "", url = "" } = req.body || {};
    const pageMargin = 50;
    const pageWidth = 595.28;   // A4 width (pt)
    const pageHeight = 841.89;  // A4 height (pt)

    // 1) Get text either from URL or raw content
    let finalText = "";

    if (url && typeof url === "string") {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return error(res, 400, "INVALID_URL", "Provided URL is invalid.", { url });
      }

      // Abort after 15s
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      try {
        const resp = await fetch(parsed.toString(), {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            // Use a realistic UA; some sites respond differently to “generic” agents.
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        clearTimeout(timer);

        if (!resp.ok) {
          return error(
            res,
            400,
            "FETCH_FAILED_STATUS",
            `Fetch failed with status ${resp.status}.`,
            { status: resp.status, statusText: resp.statusText, url }
          );
        }

        const contentType = resp.headers.get("content-type") || "";
        const html = await resp.text();

        // Convert HTML → text
        finalText = htmlToText(html, {
          selectors: [{ selector: "script,style,nav,footer,header", format: "skip" }],
          wordwrap: false,
          // Try to bias toward main content if present:
          // (html-to-text supports CSS-like selectors)
          baseElements: { selectors: ["main", "#__next", "body"] },
        }).trim();

        if (!finalText || finalText.length < 40) {
          return error(
            res,
            422,
            "EXTRACT_EMPTY",
            "Fetched page but could not extract readable chat text.",
            { url, contentType, extractedLength: finalText.length }
          );
        }
      } catch (err) {
        clearTimeout(timer);
        if (err?.name === "AbortError") {
          return error(res, 504, "FETCH_TIMEOUT", "Timed out fetching the URL.", { url });
        }
        return error(res, 502, "FETCH_ERROR", "Network error while fetching the URL.", {
          url,
          name: err?.name,
          message: err?.message,
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
        color: rgb(0, 0, 0),
      });
      y -= fontSizeTitle + 20;

      // Simple word-wrap
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
        message: err?.message,
      });
    }
  } catch (err) {
    console.error("[UNEXPECTED]", err);
    return error(res, 500, "UNEXPECTED", "Unexpected server error.", {
      name: err?.name,
      message: err?.message,
    });
  }
}