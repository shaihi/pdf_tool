// NOTE: This file was auto-extracted from export.js.
// You may need to adjust relative imports to match your project structure.

// ---- toPairs ----
// Group into user/assistant pairs
function toPairs(messages) {
  const pairs = [];
  let cur = { user: "", assistant: "" };
  let haveContent = false;

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (haveContent) { pairs.push(cur); cur = { user: "", assistant: "" }; haveContent = false; }
      cur.user = (cur.user ? cur.user + "\n\n" : "") + m.text;
      haveContent = true;
    } else if (m.role === "assistant") {
      cur.assistant = (cur.assistant ? cur.assistant + "\n\n" : "") + m.text;
      haveContent = true;
      if (cur.user && cur.assistant) { pairs.push(cur); cur = { user: "", assistant: "" }; haveContent = false; }
    }
  }
  if (haveContent && (cur.user || cur.assistant)) pairs.push(cur);
  return pairs;
}

// ---------- API handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return error(res, 405, "METHOD_NOT_ALLOWED", "Use POST /api/extract");
  }

  const { url, content, format = "messages" } = req.body || {};
  if (!url && !content) {
    return error(res, 400, "INVALID_INPUT", "Provide a single chat URL (url) or raw content (content).");
  }

  // Raw content path (no scraping)
  if (content?.trim() && !url) {
    const messages = parseMessages(content.trim(), "custom-content");
    const body = { ok: true, host: "custom-content", count: messages.length, messages };
    if (format === "pairs") body.pairs = toPairs(messages);
    return res.status(200).json(body);
  }

  // URL path
  let input;
  try { input = new URL(url); } catch { return error(res, 400, "BAD_URL", "Invalid URL."); }
  if (String(url).length > MAX_URL_LENGTH) {
    return error(res, 400, "URL_TOO_LONG", "URL exceeds maximum length.");
  }
  if (!ALLOWED_HOSTS.some((h) => input.hostname.endsWith(h))) {
    return error(res, 400, "DOMAIN_NOT_ALLOWED", "This domain is not supported.", { host: input.hostname });
  }
  // If g.co, restrict to /gemini/share/*
  if (input.hostname.endsWith("g.co") && !input.pathname.startsWith("/gemini/share/")) {
    return error(res, 400, "DOMAIN_NOT_ALLOWED", "Only g.co/gemini/share/* short-links are supported.", {
      host: input.hostname, path: input.pathname
    });
  }

  // Resolve short-links first (so we validate final host and scrape right URL)
  const resolved = await resolveShareUrl(input.toString());
  const finalUrl = resolved.url;
  let u;
  try { u = new URL(finalUrl); } catch { return error(res, 400, "BAD_URL", "Final URL invalid after redirect."); }

  // After resolution, validate final host (should be gemini.google.com for g.co short-links)
  if (!ALLOWED_HOSTS.some((h) => u.hostname.endsWith(h))) {
    return error(res, 400, "DOMAIN_NOT_ALLOWED", "Final URL host not allowed after redirect.", {
      finalHost: u.hostname, hops: resolved.hops, status: resolved.status || 0, location: resolved.location || ""
    });
  }

  // Preflight for public access (on the final URL)
  const pre = await checkPublicAccess(u.toString());
  if (!pre.ok) {
    return error(res, 422, "PRIVATE_SHARE", pre.message, { status: pre.status, location: pre.location });
  }

  const BROWSERLESS_WS_URL = process.env.BROWSERLESS_WS_URL;
  if (!BROWSERLESS_WS_URL) {
    return error(res, 500, "BROWSERLESS_MISSING", "Set BROWSERLESS_WS_URL in env variables.");
  }

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: BROWSERLESS_WS_URL });
    const raw = await scrapeChat(u.toString(), browser);
    if (!raw || raw.length < 60) {
      await safeDisconnect(browser);
      return error(res, 422, "EXTRACT_EMPTY", "Could not extract enough text.");
    }
    if (raw.length > MAX_TEXT_LENGTH) {
      await safeDisconnect(browser);
      return error(res, 422, "EXTRACT_TOO_LARGE", "Extracted text is too large.");
    }

    const messages = parseMessages(raw, u.hostname);
    await safeDisconnect(browser);

    const body = { ok: true, host: u.hostname, count: messages.length, messages };
    if (format === "pairs") body.pairs = toPairs(messages);
    return res.status(200).json(body);
  } catch (e) {
    await safeDisconnect(browser);
    return error(res, 500, "SCRAPE_FAILED", "Failed to extract conversation.", { message: e?.message });
  }
}
