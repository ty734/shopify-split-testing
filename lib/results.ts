import { getPool, ensureSchema } from "@/lib/db";
import { wilson, probToBeat, probBest, upliftCI, verdict, type Arm } from "@/lib/stats";

// Full Intelligems-parity results engine:
//   netRevenue = total_price - total_refunded - total_tax ; profit = netRevenue - cogs.
// Per-order revenue is winsorized at mean+3σ (outlier handling, ~ IG max_z_score=3).

export const METRICS = [
  { key: "profit_per_visitor", label: "Profit per visitor", kind: "money", primary: true },
  { key: "net_revenue_per_visitor", label: "Revenue per visitor", kind: "money" },
  { key: "conversion_rate", label: "Conversion rate", kind: "rate" },
  { key: "average_order_value", label: "Average order value", kind: "money" },
  { key: "add_to_cart_rate", label: "Add to cart rate", kind: "rate" },
  { key: "sub_per_visitor", label: "Sub enroll / visitor", kind: "rate" },
  { key: "net_revenue", label: "Net revenue", kind: "total" },
  { key: "visitors", label: "Visitors", kind: "count" },
  { key: "orders", label: "Orders", kind: "count" },
] as const;
export type MetricKey = (typeof METRICS)[number]["key"];
const STAT_METRICS: MetricKey[] = ["profit_per_visitor", "net_revenue_per_visitor", "conversion_rate", "average_order_value", "add_to_cart_rate", "sub_per_visitor"];

export type MetricStat = {
  value: number;
  ciLo: number; ciHi: number;
  upliftPct: number | null; upliftLo: number | null; upliftHi: number | null;
  probBeat: number | null; probBest: number | null;
  monthlyImpact: number | null;   // $/mo for money metrics, orders/mo for conversion_rate
};
export type VariationResult = {
  variationId: string; name: string; isControl: boolean;
  nVisitors: number; nOrders: number; nAddToCart: number; nSubOrders: number;
  metrics: Record<string, MetricStat>;
};
export type ResultGroup = { variations: VariationResult[]; cogsCoverage: number };
export type Overview = ResultGroup & {
  testId: string; name: string; status: string; primaryMetric: string;
  daysLive: number; totalVisitors: number; totalOrders: number; cogsConfigured: boolean; verdict: string;
};

const Z90 = 1.645;
const clampN = (v: number) => (Number.isFinite(v) ? v : 0);

type Raw = {
  segment: string | null; variation_id: string; name: string; is_control: boolean; ord: number;
  n_visitors: number; n_converters: number; n_atc: number; n_orders: number; n_sub_orders: number;
  rev_sum: number; rev_sqsum: number; profit_sum: number; profit_sqsum: number;
  order_rev_sqsum: number; units: number; costed_units: number;
};

// Segment expressions (trusted, not user input) computed per-visitor inside the query.
const SEGMENT_SQL: Record<string, string> = {
  overview: "null::text",
  device: "coalesce(x.device,'Unknown')",
  visitor:
    "case when exists (select 1 from attribution.orders o2 where o2.pixel_visitor_id=x.anon_id and o2.created_at < x.exposed_at and o2.test=false) then 'Returning' else 'New' end",
  channel: `case
      when pv.first_gclid is not null then 'Paid Search'
      when pv.first_fbclid is not null then 'Paid Social'
      when lower(coalesce(pv.first_utm_medium,'')) in ('cpc','ppc','paid','paidsocial','paid_social') and lower(coalesce(pv.first_utm_source,'')) ~ 'facebook|instagram|meta|fb|ig' then 'Paid Social'
      when lower(coalesce(pv.first_utm_medium,'')) in ('cpc','ppc','paid') then 'Paid Search'
      when lower(coalesce(pv.first_utm_medium,'')) ~ 'email|klaviyo|flow|campaign' then 'Email'
      when lower(coalesce(pv.first_utm_source,'')) ~ 'facebook|instagram|meta|tiktok' then 'Organic Social'
      when coalesce(pv.first_referrer,'') ~* 'google|bing|duckduckgo|yahoo|ecosia' then 'Organic Search'
      when coalesce(pv.first_referrer,'') = '' then 'Direct'
      else 'Referral' end`,
  landing:
    "coalesce(nullif(regexp_replace(split_part(coalesce(pv.first_landing_url,''),'?',1), '^https?://[^/]+', ''), ''), '/')",
};

async function rawRows(testId: string, dim: string): Promise<Raw[]> {
  const seg = SEGMENT_SQL[dim] ?? SEGMENT_SQL.overview;
  const { rows } = await getPool().query(
    `
    with exposures as (
      select distinct on (e.anon_id) e.anon_id, e.variation_id, e.ts as exposed_at, e.device
      from split.events e where e.test_id = $1 and e.name = 'exposure'
      order by e.anon_id, e.ts asc
    ),
    atc as (
      -- reuse the attribution pixel's add-to-cart capture (our runtime doesn't see
      -- the pixel's internal ATC handler). A visitor counts if they added to cart
      -- at/after their exposure.
      -- A checkout_start counts too (2026-10-12). Landing pages whose buttons are
      -- cart permalinks skip the cart entirely, so the click that IS their add to
      -- cart is recorded by the pixel as checkout_start and never as add_to_cart;
      -- a no-nav lander read ~0% ATC with real orders (a free-gift lander). Nobody
      -- starts a checkout with an empty cart, so the union only ever adds visitors
      -- whose add the pixel missed.
      select distinct x.anon_id
      from exposures x
      join attribution.pixel_events pe on pe.visitor_id = x.anon_id and pe.event_type in ('add_to_cart','checkout_start') and pe.occurred_at >= x.exposed_at
    ),
    ord as (
      select x.anon_id, x.variation_id, o.id as order_id,
             (o.total_price - o.total_refunded - o.total_tax) as net_rev,
             -- Subscription enrollment signal. attribution.orders has no selling_plan
             -- column; a first subscription order is flagged by the Shopify tag your
             -- subscription app adds (Recharge: 'Subscription First Order'). Change to suit.
             -- (source_name='subscription_contract_checkout_one' marks RECURRING orders
             -- only, so it does NOT identify enrollment.) bool_or collapses the
             -- order_items fan-out below back to one value per order.
             bool_or('Subscription First Order' = any(o.tags)) as is_sub,
             coalesce(sum(oi.quantity * uc.cost), 0) as cogs,
             coalesce(sum(oi.quantity), 0) as units,
             coalesce(sum(oi.quantity) filter (where uc.sku is not null), 0) as costed_units
      from exposures x
      join attribution.orders o on o.pixel_visitor_id = x.anon_id and o.created_at >= x.exposed_at and o.test = false and o.cancelled_at is null
      left join attribution.order_items oi on oi.order_id = o.id
      left join attribution.unit_costs uc on uc.sku = oi.sku
      group by x.anon_id, x.variation_id, o.id, o.total_price, o.total_refunded, o.total_tax
    ),
    thr as (select coalesce(avg(net_rev) + 3 * coalesce(stddev_samp(net_rev), 0), 1e12) as t from ord),
    visitor as (
      select x.anon_id, x.variation_id, (${seg}) as segment,
             (x.anon_id in (select anon_id from atc)) as added,
             -- NB: least() IGNORES nulls, so guard non-order rows to null (else every
             -- non-converter gets phantom revenue = the winsor threshold).
             coalesce(sum(case when orr.order_id is null then null else least(orr.net_rev, (select t from thr)) end), 0) as revenue,
             coalesce(sum(case when orr.order_id is null then null else power(least(orr.net_rev, (select t from thr)), 2) end), 0) as order_rev_sq,
             coalesce(sum(case when orr.order_id is null then null else least(orr.net_rev, (select t from thr)) - orr.cogs end), 0) as profit,
             count(orr.order_id) as n_orders,
             coalesce(sum(orr.is_sub::int), 0) as n_sub_orders,
             coalesce(sum(orr.units), 0) as units,
             coalesce(sum(orr.costed_units), 0) as costed_units
      from exposures x
      left join ord orr on orr.anon_id = x.anon_id
      left join attribution.pixel_visitors pv on pv.visitor_id = x.anon_id
      group by x.anon_id, x.variation_id, segment, added
    )
    select v.id as variation_id, v.name, v.is_control, v.ord, vt.segment,
           count(vt.anon_id)::int as n_visitors,
           coalesce(sum((vt.n_orders > 0)::int), 0)::int as n_converters,
           coalesce(sum(vt.added::int), 0)::int as n_atc,
           coalesce(sum(vt.n_orders), 0)::int as n_orders,
           coalesce(sum(vt.n_sub_orders), 0)::int as n_sub_orders,
           coalesce(sum(vt.revenue), 0) as rev_sum,
           coalesce(sum(power(vt.revenue, 2)), 0) as rev_sqsum,
           coalesce(sum(vt.profit), 0) as profit_sum,
           coalesce(sum(power(vt.profit, 2)), 0) as profit_sqsum,
           coalesce(sum(vt.order_rev_sq), 0) as order_rev_sqsum,
           coalesce(sum(vt.units), 0) as units,
           coalesce(sum(vt.costed_units), 0) as costed_units
    from split.variations v
    left join visitor vt on vt.variation_id = v.id
    where v.test_id = $1
    group by v.id, v.name, v.is_control, v.ord, vt.segment
    order by v.ord
    `,
    [testId]
  );
  return rows.map((r) => ({ ...r,
    n_visitors: +r.n_visitors, n_converters: +r.n_converters, n_atc: +r.n_atc, n_orders: +r.n_orders,
    n_sub_orders: +r.n_sub_orders,
    rev_sum: +r.rev_sum, rev_sqsum: +r.rev_sqsum, profit_sum: +r.profit_sum, profit_sqsum: +r.profit_sqsum,
    order_rev_sqsum: +r.order_rev_sqsum, units: +r.units, costed_units: +r.costed_units }));
}

function contArm(n: number, sum: number, sqsum: number): Arm & { value: number } {
  if (n < 1) return { mean: 0, se: 0, value: 0 };
  const mean = sum / n;
  const variance = n > 1 ? Math.max(0, (sqsum - (sum * sum) / n) / (n - 1)) : 0;
  return { mean, se: Math.sqrt(variance / n), value: mean };
}
function rateArm(k: number, n: number): Arm & { value: number } {
  if (n < 1) return { mean: 0, se: 0, value: 0 };
  // clamp: sub_per_visitor counts ORDERS over VISITORS, so k>n is theoretically
  // possible (one visitor, two subscription first orders). Unclamped that makes
  // p(1-p) negative -> se = NaN, which would poison the whole JSON payload.
  const p = Math.min(1, k / n);
  return { mean: p, se: Math.sqrt((p * (1 - p)) / n), value: p };
}
function armFor(metric: MetricKey, r: Raw): (Arm & { value: number }) | null {
  switch (metric) {
    case "net_revenue_per_visitor": return contArm(r.n_visitors, r.rev_sum, r.rev_sqsum);
    case "profit_per_visitor": return contArm(r.n_visitors, r.profit_sum, r.profit_sqsum);
    case "average_order_value": return contArm(r.n_orders, r.rev_sum, r.order_rev_sqsum);
    case "conversion_rate": return rateArm(r.n_converters, r.n_visitors);
    case "add_to_cart_rate": return rateArm(r.n_atc, r.n_visitors);
    case "sub_per_visitor": return rateArm(r.n_sub_orders, r.n_visitors);
    default: return null;
  }
}

function buildGroup(rows: Raw[], monthlyVisitors: number): ResultGroup {
  const control = rows.find((r) => r.is_control) || rows[0];
  let totalUnits = 0, totalCosted = 0;
  rows.forEach((r) => { totalUnits += r.units; totalCosted += r.costed_units; });

  // Precompute arms per stat metric for probBest across variations.
  const armsByMetric: Record<string, (Arm & { value: number } | null)[]> = {};
  for (const m of STAT_METRICS) armsByMetric[m] = rows.map((r) => armFor(m, r));
  const bestByMetric: Record<string, number[]> = {};
  for (const m of STAT_METRICS) {
    const arms = armsByMetric[m].map((a) => a || { mean: 0, se: 0 });
    bestByMetric[m] = arms.every((a) => a.se === 0 && a.mean === 0) ? arms.map(() => 0) : probBest(arms);
  }

  const variations: VariationResult[] = rows.map((r, i) => {
    const metrics: Record<string, MetricStat> = {};
    for (const m of STAT_METRICS) {
      const arm = armsByMetric[m][i];
      const cArm = armFor(m, control);
      const value = arm?.value ?? 0;
      const ci = arm ? { lo: value - Z90 * arm.se, hi: value + Z90 * arm.se } : { lo: 0, hi: 0 };
      const isC = r.is_control;
      const up = !isC && arm && cArm ? upliftCI(cArm, arm, Z90) : null;
      const beat = !isC && arm && cArm ? probToBeat(cArm as any, arm as any) : null;
      let monthly: number | null = null;
      if (!isC && arm && cArm) {
        const diff = arm.value - cArm.value;
        if (m === "profit_per_visitor" || m === "net_revenue_per_visitor") monthly = diff * monthlyVisitors;
        else if (m === "conversion_rate") monthly = diff * monthlyVisitors;
      }
      metrics[m] = {
        value, ciLo: ci.lo, ciHi: ci.hi,
        upliftPct: up ? up.uplift : null, upliftLo: up ? up.lo : null, upliftHi: up ? up.hi : null,
        probBeat: beat, probBest: isC ? bestByMetric[m][i] : bestByMetric[m][i],
        monthlyImpact: monthly,
      };
    }
    // display-only metrics
    metrics.net_revenue = blank(r.rev_sum);
    metrics.visitors = blank(r.n_visitors);
    metrics.orders = blank(r.n_orders);
    return {
      variationId: r.variation_id, name: r.name, isControl: r.is_control,
      nVisitors: r.n_visitors, nOrders: r.n_orders, nAddToCart: r.n_atc, nSubOrders: r.n_sub_orders, metrics,
    };
  });

  return { variations, cogsCoverage: totalUnits > 0 ? totalCosted / totalUnits : 0 };
}
const blank = (v: number): MetricStat => ({ value: v, ciLo: v, ciHi: v, upliftPct: null, upliftLo: null, upliftHi: null, probBeat: null, probBest: null, monthlyImpact: null });

export async function computeOverview(testId: string): Promise<Overview> {
  await ensureSchema();
  const pool = getPool();
  const { rows: meta } = await pool.query(`select name, status, primary_metric, started_at from split.tests where id=$1`, [testId]);
  if (!meta.length) throw new Error("test not found");
  const startedAt: Date | null = meta[0].started_at;
  const daysLive = startedAt ? (Date.now() - new Date(startedAt).getTime()) / 86_400_000 : 0;

  const rows = await rawRows(testId, "overview");
  const totalVisitors = rows.reduce((s, r) => s + r.n_visitors, 0);
  const totalOrders = rows.reduce((s, r) => s + r.n_orders, 0);
  const monthlyVisitors = daysLive > 0.3 ? (totalVisitors / daysLive) * 30 : 0;
  const group = buildGroup(rows, monthlyVisitors);

  const primaryMetric: string = meta[0].primary_metric;
  const control = group.variations.find((v) => v.isControl);
  const best = group.variations.filter((v) => !v.isControl)
    .sort((a, b) => (b.metrics[primaryMetric]?.probBeat || 0) - (a.metrics[primaryMetric]?.probBeat || 0))[0];
  const v = best
    ? verdict({ daysLive, ordersControl: control?.nOrders || 0, ordersVariant: best.nOrders,
        relLift: best.metrics[primaryMetric]?.upliftPct || 0, probBeat: best.metrics[primaryMetric]?.probBeat || 0.5 })
    : "not_ready";

  return {
    testId, name: meta[0].name, status: meta[0].status, primaryMetric,
    daysLive: Math.round(daysLive * 10) / 10, totalVisitors, totalOrders,
    cogsCoverage: group.cogsCoverage, cogsConfigured: group.cogsCoverage > 0,
    verdict: v, variations: group.variations,
  };
}

export async function computeSegments(testId: string, dim: string): Promise<{ dim: string; segments: { segment: string; group: ResultGroup }[] }> {
  await ensureSchema();
  if (!SEGMENT_SQL[dim] || dim === "overview") throw new Error("bad segment dimension");
  const rows = await rawRows(testId, dim);
  const segNames = [...new Set(rows.map((r) => r.segment).filter((s): s is string => s != null))]
    .sort((a, b) => segTotal(rows, b) - segTotal(rows, a));
  const segments = segNames.map((segment) => {
    const segRows = rows.filter((r) => r.segment === segment);
    // ensure every variation present in the segment (fill zeros)
    const byVar = new Map(segRows.map((r) => [r.variation_id, r]));
    const filled = rows.filter((r, i, arr) => arr.findIndex((x) => x.variation_id === r.variation_id) === i)
      .map((base) => byVar.get(base.variation_id) || zeroRow(base));
    return { segment, group: buildGroup(filled, 0) };
  });
  return { dim, segments };
}
function segTotal(rows: Raw[], seg: string): number { return rows.filter((r) => r.segment === seg).reduce((s, r) => s + r.n_visitors, 0); }
function zeroRow(base: Raw): Raw {
  return { ...base, segment: base.segment, n_visitors: 0, n_converters: 0, n_atc: 0, n_orders: 0, n_sub_orders: 0, rev_sum: 0, rev_sqsum: 0, profit_sum: 0, profit_sqsum: 0, order_rev_sqsum: 0, units: 0, costed_units: 0 };
}

export async function computeTimeseries(
  testId: string, metric: MetricKey, granularity: "hour" | "day" | "week", cumulative: boolean
): Promise<{ metric: string; granularity: string; cumulative: boolean; series: { variationId: string; name: string; isControl: boolean; points: { t: string; value: number }[] }[] }> {
  await ensureSchema();
  // The ob CTE below only carries revenue + order counts, so any metric it can't
  // build falls through to the revenue approximation at the bottom of this
  // function. That's a deliberate (documented) approximation for
  // profit_per_visitor, but for sub_per_visitor it would be plain wrong numbers
  // under the wrong label — reject it rather than chart something misleading.
  if (metric === "sub_per_visitor") throw new Error("sub_per_visitor is not available as a timeseries");
  const pool = getPool();
  const { rows } = await pool.query(
    `
    with exposures as (
      select distinct on (e.anon_id) e.anon_id, e.variation_id, e.ts as exposed_at
      from split.events e where e.test_id=$1 and e.name='exposure' order by e.anon_id, e.ts asc
    ),
    vb as (select variation_id, date_trunc($2,exposed_at) as b, count(*)::int nv from exposures group by 1,2),
    ob as (
      select x.variation_id, date_trunc($2,o.created_at) as b,
             sum(o.total_price - o.total_refunded - o.total_tax) rev, count(o.id)::int ord
      from exposures x join attribution.orders o on o.pixel_visitor_id=x.anon_id and o.created_at>=x.exposed_at and o.test=false and o.cancelled_at is null
      group by 1,2
    )
    select coalesce(vb.variation_id, ob.variation_id) variation_id,
           coalesce(vb.b, ob.b) bucket,
           coalesce(vb.nv,0)::int nv, coalesce(ob.rev,0) rev, coalesce(ob.ord,0)::int ord
    from vb full outer join ob on vb.variation_id=ob.variation_id and vb.b=ob.b
    order by bucket asc`,
    [testId, granularity]
  );
  const { rows: vars } = await pool.query(`select id, name, is_control from split.variations where test_id=$1 order by ord`, [testId]);
  const buckets = [...new Set(rows.map((r) => new Date(r.bucket).toISOString()))].sort();
  const series = vars.map((v) => {
    let cv = 0, cr = 0, co = 0;
    const points = buckets.map((t) => {
      const r = rows.find((x) => x.variation_id === v.id && new Date(x.bucket).toISOString() === t);
      const nv = r ? +r.nv : 0, rev = r ? +r.rev : 0, ord = r ? +r.ord : 0;
      cv += nv; cr += rev; co += ord;
      const V = cumulative ? cv : nv, R = cumulative ? cr : rev, O = cumulative ? co : ord;
      let value = 0;
      if (metric === "net_revenue_per_visitor") value = V ? R / V : 0;
      else if (metric === "conversion_rate") value = V ? O / V : 0;
      else if (metric === "average_order_value") value = O ? R / O : 0;
      else if (metric === "net_revenue") value = R;
      else if (metric === "orders") value = O;
      else if (metric === "visitors") value = V;
      else value = V ? R / V : 0; // profit_per_visitor approx via revenue (no per-bucket cogs yet)
      return { t, value: clampN(value) };
    });
    return { variationId: v.id, name: v.name, isControl: v.is_control, points };
  });
  return { metric, granularity, cumulative, series };
}
