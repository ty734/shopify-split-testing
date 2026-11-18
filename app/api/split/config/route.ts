import { NextRequest, NextResponse } from "next/server";
import { compileConfig } from "@/lib/config";
import { verifyPreviewKey } from "@/lib/preview";

// PUBLIC (excluded from auth middleware). The storefront runtime fetches this
// when the theme embed hasn't inlined window.__LWSPLIT_CONFIG__. Cached at the
// edge briefly so a spike of pageviews doesn't hammer the DB; the compiled config
// only changes when a test is started/edited.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "public, max-age=30, s-maxage=30, stale-while-revalidate=120",
});

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

export async function GET(req: NextRequest) {
  const headers = cors(req.headers.get("origin"));
  try {
    // Draft preview: ?test=<id>&key=<per-test key> additionally compiles that one
    // non-running test (see lib/preview.ts). A bad/missing key is NOT an error — we
    // quietly serve the normal public config and flag it, so a stale QA link can
    // never break the storefront. Keyed responses are never cached.
    const wantTest = req.nextUrl.searchParams.get("test");
    const key = req.nextUrl.searchParams.get("key");
    const ok = wantTest ? await verifyPreviewKey(wantTest, key) : false;

    const cfg = await compileConfig({ includeTestId: ok ? wantTest : null });
    const body = wantTest && !ok ? { ...cfg, preview_rejected: true } : cfg;

    return new NextResponse(JSON.stringify(body), {
      status: 200,
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(wantTest ? { "Cache-Control": "private, no-store" } : {}),
      },
    });
  } catch {
    // Never break the storefront — return an empty config on error.
    return new NextResponse(JSON.stringify({ tests: [], selectors: [] }), {
      status: 200,
      headers: { ...headers, "content-type": "application/json" },
    });
  }
}
