import { NextRequest, NextResponse } from "next/server";
import { getPool, ensureSchema } from "@/lib/db";

// PUBLIC split-test event sink. The storefront runtime beacons exposures + funnel
// events here. Stateless, always 204, never throws to the storefront. Mirrors the
// attribution collector's discipline.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
});

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v.slice(0, 512) : null);

type Exposure = { test_id?: unknown; variation_id?: unknown };

export async function POST(req: NextRequest) {
  const headers = cors(req.headers.get("origin"));
  try {
    const text = await req.text();
    const body = text ? JSON.parse(text) : {};
    const anonId = s(body.anon_id);
    const name = s(body.name) || "exposure";
    const ctx = (body.ctx || {}) as Record<string, unknown>;
    const exposures: Exposure[] = Array.isArray(body.exposures) ? body.exposures : [];
    if (!anonId || !exposures.length) return new NextResponse(null, { status: 204, headers });

    await ensureSchema();
    const pool = getPool();

    // One event row per (test, variation) the visitor is in, for this signal.
    const values: unknown[] = [];
    const rowsSql = exposures.slice(0, 25).map((e, i) => {
      const b = i * 8;
      values.push(
        anonId, s(e.test_id), s(e.variation_id), name,
        s(ctx.urlPath), s(ctx.device), s(ctx.source ?? null), s(ctx.country ?? null)
      );
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
    });
    await pool.query(
      `insert into split.events (anon_id, test_id, variation_id, name, url_path, device, source, country)
       values ${rowsSql.join(",")}`,
      values
    );

    // Record sticky assignment on first exposure (idempotent).
    if (name === "exposure") {
      for (const e of exposures.slice(0, 25)) {
        if (!s(e.test_id) || !s(e.variation_id)) continue;
        await pool.query(
          `insert into split.assignments (anon_id, test_id, variation_id)
           values ($1,$2,$3) on conflict (anon_id, test_id) do nothing`,
          [anonId, e.test_id, e.variation_id]
        );
      }
    }

    return new NextResponse(null, { status: 204, headers });
  } catch {
    return new NextResponse(null, { status: 204, headers });
  }
}
