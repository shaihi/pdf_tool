// NOTE: This file was auto-extracted from export.js.
// You may need to adjust relative imports to match your project structure.

// ---- scrapeChat ----
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

// ---- pushText ----
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

// ---- getSelectorsForDomain ----
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
