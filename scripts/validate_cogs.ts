// Validate the CORRECTED revenue/profit formula (mirrors attribution/lib/summary.ts):
//   netRevenue = total_price - total_refunded - total_tax ; profit = netRevenue - cogs.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getPool } from "../lib/db";

(async () => {
  const pool = getPool();

  const cov = await pool.query(`
    with recent as (select id from attribution.orders where test=false and cancelled_at is null order by created_at desc limit 1000)
    select coalesce(sum(oi.quantity),0)::int units,
           coalesce(sum(oi.quantity) filter (where uc.sku is not null),0)::int costed_units,
           round(100.0 * sum(oi.quantity) filter (where uc.sku is not null) / nullif(sum(oi.quantity),0),1) as coverage_pct
    from attribution.order_items oi
    join recent r on r.id = oi.order_id
    left join attribution.unit_costs uc on uc.sku = oi.sku
  `);
  console.log("unit-weighted COGS coverage (last 1000 orders):", cov.rows[0]);

  const agg = await pool.query(`
    with recent as (select * from attribution.orders where test=false and cancelled_at is null order by created_at desc limit 1000),
    rev as (select coalesce(sum(total_price - total_refunded - total_tax),0) net_rev, count(*) n from recent),
    cogs as (select coalesce(sum(oi.quantity * uc.cost),0) c
             from attribution.order_items oi join recent r on r.id=oi.order_id
             left join attribution.unit_costs uc on uc.sku=oi.sku)
    select round(rev.net_rev,2) net_rev, rev.n orders, round(cogs.c,2) cogs,
           round(rev.net_rev - cogs.c,2) profit,
           round(100.0*(rev.net_rev - cogs.c)/nullif(rev.net_rev,0),1) as gross_margin_pct
    from rev, cogs
  `);
  console.log("aggregate (last 1000 orders):", agg.rows[0]);

  const sample = await pool.query(`
    with one as (
      select o.id, (o.total_price - o.total_refunded - o.total_tax) net_rev
      from attribution.orders o
      where o.test=false and o.cancelled_at is null and o.total_price > 0
      order by o.created_at desc limit 1)
    select one.id, round(one.net_rev,2) net_rev,
           round(coalesce(sum(oi.quantity*uc.cost),0),2) cogs,
           round(one.net_rev - coalesce(sum(oi.quantity*uc.cost),0),2) profit
    from one join attribution.order_items oi on oi.order_id=one.id
    left join attribution.unit_costs uc on uc.sku=oi.sku
    group by one.id, one.net_rev
  `);
  console.log("sample order:", sample.rows[0]);

  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
