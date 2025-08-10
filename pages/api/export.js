import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const { title = "Chat Export", content = "" } = req.body || {};
    if (!content || !content.trim()) {
      return res.status(400).send("No content provided.");
    }

    const pdfDoc = await PDFDocument.create();
    const pageMargin = 50;
    const pageWidth = 595.28;   // A4 width in points
    const pageHeight = 841.89;  // A4 height in points
    const fontSizeTitle = 18;
    const fontSizeBody = 11;
    const lineHeight = 15;

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - pageMargin;

    // Draw title
    const titleText = String(title || "Chat Export");
    const titleWidth = fontBold.widthOfTextAtSize(titleText, fontSizeTitle);
    page.drawText(titleText, {
      x: pageMargin,
      y: y - fontSizeTitle,
      size: fontSizeTitle,
      font: fontBold,
      color: rgb(0, 0, 0)
    });
    y -= (fontSizeTitle + 20);

    // Word-wrap function
    const maxWidth = pageWidth - pageMargin * 2;
    const words = String(content).replace(/\r\n/g, "\n").split(/\s+/);
    let line = "";

    function commitLine(lineText) {
      if (y < pageMargin + lineHeight) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - pageMargin;
      }
      page.drawText(lineText, {
        x: pageMargin,
        y,
        size: fontSizeBody,
        font,
        color: rgb(0, 0, 0)
      });
      y -= lineHeight;
    }

    for (let i = 0; i < words.length; i++) {
      const testLine = line ? line + " " + words[i] : words[i];
      const w = font.widthOfTextAtSize(testLine, fontSizeBody);
      if (w > maxWidth) {
        commitLine(line);
        line = words[i];
      } else {
        line = testLine;
      }
    }
    if (line) commitLine(line);

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(title || "chat")}.pdf"`);
    return res.status(200).send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to generate PDF.");
  }
}
