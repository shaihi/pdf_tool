import puppeteer from "puppeteer-core";

export default async function handler(req, res) {
  const ws = process.env.BROWSERLESS_WS_URL;
  if (!ws) return res.status(500).json({ ok:false, error:"Missing BROWSERLESS_WS_URL" });
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws });
    await browser.disconnect();
    return res.status(200).json({ ok:true });
  } catch (e) {
    return res.status(502).json({ ok:false, error:e.message });
  }
}