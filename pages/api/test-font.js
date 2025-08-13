import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";

export default async function handler(req, res) {
  try {
    // Load font file from /public/fonts
    const fontPath = path.join(process.cwd(), "public", "../../lib/fonts", "DejaVuSans.ttf");
    if (!fs.existsSync(fontPath)) {
      return res.status(500).json({
        ok: false,
        message: "Font file not found at public/fonts/DejaVuSans.ttf"
      });
    }

    const fontBytes = fs.readFileSync(fontPath);

    // Create PDF
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const customFont = await pdfDoc.embedFont(fontBytes);

    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const fontSize = 20;

    const hebrewText = "שלום עולם"; // "Hello World" in Hebrew
    const englishText = "Hello World (English)";

    page.drawText("Testing Hebrew Font:", {
      x: 50,
      y: 800,
      size: fontSize,
      font: customFont,
      color: rgb(0, 0, 0)
    });

    page.drawText(hebrewText, {
      x: 50,
      y: 760,
      size: fontSize,
      font: customFont,
      color: rgb(0, 0, 1) // blue
    });

    page.drawText(englishText, {
      x: 50,
      y: 720,
      size: fontSize,
      font: customFont,
      color: rgb(1, 0, 0) // red
    });

    const pdfBytes = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="font-test.pdf"`);
    return res.status(200).send(Buffer.from(pdfBytes));

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      message: "Error generating test PDF",
      error: err.message
    });
  }
}