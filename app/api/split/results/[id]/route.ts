import { NextRequest, NextResponse } from "next/server";
import { computeOverview, computeSegments, computeTimeseries, type MetricKey } from "@/lib/results";

// Gated by the auth middleware. One route serves overview, segments, and timeseries
// via ?view=.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = req.nextUrl.searchParams;
  const view = q.get("view") || "overview";
  try {
    if (view === "segments") {
      return NextResponse.json(await computeSegments(id, q.get("dim") || "device"));
    }
    if (view === "timeseries") {
      const metric = (q.get("metric") || "net_revenue_per_visitor") as MetricKey;
      const gran = (q.get("granularity") || "day") as "hour" | "day" | "week";
      const cumulative = q.get("cumulative") !== "0";
      return NextResponse.json(await computeTimeseries(id, metric, gran, cumulative));
    }
    return NextResponse.json(await computeOverview(id));
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 400 });
  }
}
