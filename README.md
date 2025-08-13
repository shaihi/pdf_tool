# Chat ➜ PDF Tool (Next.js + pdf-lib)

## Quick start
1. `npm install`
2. `npm run dev` and open http://localhost:3000
3. Paste chat text, set a title, click **Download PDF**.

## Deploy to Vercel
- Go to https://vercel.com/new
- Click **Import Project → Upload** and select this folder
- Accept detected settings and **Deploy**

## Notes
- This is a minimal MVP using `pdf-lib`.
- For large chats, PDF generation happens server-side in the API route.

# Challenge Detector API Integration

# Option 2 (Node/Next.js) — Challenge Detector API

## Files
- `pages/api/analyze.js` — API route (POST) that analyzes a chat payload.
- `lib/challenge.js` — heuristic rules + scoring.

## Usage
Deploy, then POST to `/api/analyze` with one of the following JSON bodies:

### 1) Array of messages
```json
[
  {"role":"user","content":"are you sure about that?"},
  {"role":"assistant","content":"Yes."},
  {"role":"user","content":"that doesn't add up."}
]
```

### 2) OpenAI-style object
```json
{
  "messages":[
    {"role":"user","content":"why is this true?"},
    {"role":"assistant","content":"..."}
  ]
}
```

### 3) Plain text
```json
"i disagree with this result — show a source"
```

### Example fetch
```js
const res = await fetch('/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages })
});
const data = await res.json();
console.log(data);
```

## Response format
```json
{
  "ok": true,
  "challenged": true,
  "aggregateScore": 2.25,
  "messages": [
    {"index":0,"role":"user","content":"...","score":1.25,"matched":["are you sure"]}
  ],
  "threshold": 1.0
}
```

## Tuning
- Adjust `threshold` and `KEYWORD_PATTERNS` in `lib/challenge.js` to fit your data.
