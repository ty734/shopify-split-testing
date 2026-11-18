import { NextRequest, NextResponse } from "next/server";
import { createTest, type TestInput } from "@/lib/tests";
import { getPool, ensureSchema } from "@/lib/db";

// Gated by auth middleware.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List tests (optionally ?status=running). Used by the split-testing skill.
export async function GET(req: NextRequest) {
  await ensureSchema();
  const status = req.nextUrl.searchParams.get("status");
  const { rows } = await getPool().query(
    `select t.id, t.name, t.status, t.type, t.primary_metric, t.started_at, t.ended_at,
            (select count(*) from split.variations v where v.test_id=t.id)::int as variations,
            (select count(distinct anon_id) from split.events e where e.test_id=t.id and e.name='exposure')::int as visitors
       from split.tests t
      ${status ? "where t.status = $1" : ""}
      order by case t.status when 'running' then 0 when 'paused' then 1 when 'draft' then 2 else 3 end, t.created_at desc`,
    status ? [status] : []
  );
  return NextResponse.json({ tests: rows });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TestInput;
    if (!body?.name || !Array.isArray(body.variations) || body.variations.length < 2) {
      return NextResponse.json({ error: "name and >=2 variations required" }, { status: 400 });
    }
    // Each allocation must be a finite, strictly positive share <= 100. Without
    // this, invalid pairs like -50% and 150% still sum to 100 and get accepted,
    // and the runtime never routes traffic to the negative arm.
    if (body.variations.some((v) => { const p = Number(v.percentage); return !Number.isFinite(p) || p <= 0 || p > 100; })) {
      return NextResponse.json({ error: "each variation percentage must be a number > 0 and <= 100" }, { status: 400 });
    }
    const total = body.variations.reduce((s, v) => s + Number(v.percentage || 0), 0);
    if (Math.round(total) !== 100) {
      return NextResponse.json({ error: `variation percentages must sum to 100 (got ${total})` }, { status: 400 });
    }
    if (!body.variations.some((v) => v.is_control)) body.variations[0].is_control = true;
    const id = await createTest(body);
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 400 });
  }
}
