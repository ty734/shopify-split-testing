import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE, expectedToken } from "./lib/auth";

// Gate the dashboard. PUBLIC: login, the storefront config + collect endpoints
// (no credentials from the storefront), the runtime file, and static assets.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|lw-split.js|login|api/login|api/split/config|api/split/collect).*)",
  ],
};

export async function middleware(req: NextRequest) {
  // API-token auth for programmatic access (the split-testing skill / CRO workflow).
  const authz = req.headers.get("authorization");
  const apiToken = process.env.SPLIT_API_TOKEN;
  if (apiToken && authz === `Bearer ${apiToken}`) return NextResponse.next();
  // Vercel cron jobs (vercel.json) authenticate with CRON_SECRET.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authz === `Bearer ${cronSecret}`) return NextResponse.next();

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  const expected = await expectedToken();
  if (cookie && expected && cookie === expected) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}
