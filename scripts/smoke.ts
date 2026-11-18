// End-to-end smoke test against the shared DB: seed a throwaway test, simulate an
// exposure + a matching order visitor, compute results, then clean up. Proves the
// split.events -> attribution.orders join and the stats path without any storefront.
//   npm run smoke
//
// This runs against the LIVE database, so it is written to be harmless even when
// it fails. Two things make that true, both learned the hard way
// when a failing run left a `running` test on the storefront that quietly
// bucketed 90 real visitors before anyone noticed:
//
//   1. Cleanup lives in `finally`, so a throw mid-run still removes the test.
//   2. The seeded test carries a page rule that cannot match any real URL, so
//      even an orphan that somehow survives can never bucket real traffic.
//      (It has no changes either, so nothing would render — but "renders
//      nothing" and "is invisible to the runtime" are different guarantees.)
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { ensureSchema, getPool } from "../lib/db";
import { computeOverview } from "../lib/results";

// Deliberately unreachable: no storefront URL is this path.
const UNREACHABLE = "/__lwsplit_smoke_never_a_real_page__";

(async () => {
  await ensureSchema();
  const pool = getPool();
  const anon = "smoke_" + Math.floor(Date.now() / 1000);
  let testId: string | null = null;

  try {
    const t = await pool.query(
      `insert into split.tests (name, status, started_at)
       values ('SMOKE-TEST','running', now() - interval '8 days') returning id`
    );
    testId = t.rows[0].id;
    // Fence it off from real traffic before anything else can go wrong.
    await pool.query(
      `insert into split.targeting_rules (test_id, scope, rule_group, key, op, value)
       values ($1,'page',0,'urlPath','equals',$2)`,
      [testId, UNREACHABLE]
    );
    const c = await pool.query(
      `insert into split.variations (test_id,name,is_control,percentage,ord) values ($1,'Control',true,50,0) returning id`,
      [testId]
    );
    const v = await pool.query(
      `insert into split.variations (test_id,name,is_control,percentage,ord) values ($1,'Variant',false,50,1) returning id`,
      [testId]
    );
    await pool.query(
      `insert into split.events (anon_id,test_id,variation_id,name,ts) values ($1,$2,$3,'exposure', now() - interval '7 days')`,
      [anon, testId, v.rows[0].id]
    );

    const res = await computeOverview(testId);
    console.log(JSON.stringify(res, null, 2));
    console.log("\nsmoke ok (control=%s variant=%s)", c.rows[0].id, v.rows[0].id);
  } finally {
    if (testId) {
      await pool.query(`delete from split.events where test_id=$1`, [testId]);
      await pool.query(`delete from split.tests where id=$1`, [testId]);
      console.log("cleaned up.");
    }
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
