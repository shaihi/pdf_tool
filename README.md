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
