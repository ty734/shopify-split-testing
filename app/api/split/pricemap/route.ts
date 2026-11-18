import { NextResponse } from "next/server";
import { compilePriceMap } from "@/lib/config";

// GATED (auth middleware). Returns the AUTHORITATIVE charge-price map for the
// cart-transform Function — the JSON to write into the CartTransform's own metafield
// ($app:lwsplit / prices). Shape: { "<testId>:<variationId>": { "<variantGID>": price } }.
// The Function reads its metafield (not this URL) at checkout; this endpoint is how we
// keep that metafield in sync when a price test starts/stops. Fetch with the split API
// bearer token, then push the value via metafieldsSet on the cart transform owner.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const prices = await compilePriceMap();
    return NextResponse.json({ prices });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 });
  }
}
