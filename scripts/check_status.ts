import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getPool } from "../lib/db";

// npm run status -- <testId>
const TEST = process.argv[2];
if (!TEST) { console.error("usage: npm run status -- <testId>"); process.exit(1); }

(async () => {
  const pool = getPool();
  const t = await pool.query(`select name, status, started_at from split.tests where id=$1`, [TEST]);
  console.log("TEST:", t.rows[0]);

  const ev = await pool.query(`select name, count(*)::int n from split.events where test_id=$1 group by name order by n desc`, [TEST]);
  console.log("EVENTS by type:", ev.rows);

  const vis = await pool.query(
    `select v.name, count(distinct e.anon_id)::int visitors
     from split.variations v
     left join split.events e on e.variation_id=v.id and e.name='exposure'
     where v.test_id=$1 group by v.name, v.ord order by v.ord`, [TEST]);
  console.log("EXPOSED VISITORS by variation:", vis.rows);

  const dev = await pool.query(
    `select coalesce(device,'(null)') device, count(distinct anon_id)::int visitors
     from split.events where test_id=$1 and name='exposure' group by device`, [TEST]);
  console.log("DEVICE captured on exposures:", dev.rows);

  const ord = await pool.query(
    `select count(distinct o.id)::int stitched_orders
     from split.events e join attribution.orders o on o.pixel_visitor_id=e.anon_id
     where e.test_id=$1 and e.name='exposure' and o.created_at >= e.ts`, [TEST]);
  console.log("STITCHED ORDERS so far:", ord.rows[0]);

  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
