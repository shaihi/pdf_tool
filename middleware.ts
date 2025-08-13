import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const origin = req.headers.get("origin") || "";
  const host = req.headers.get("host") || "";
  const sameOrigin = origin && origin.includes(host);

  // Allow same-origin browser calls (your own UI)
  if (sameOrigin) return NextResponse.next();

  // Otherwise require your private API key
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token && token === process.env.API_KEY) return NextResponse.next();

  return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
}

export const config = { matcher: ["/api/:path*"] };