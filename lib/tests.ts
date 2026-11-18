import { getPool, ensureSchema } from "@/lib/db";
import type { PoolClient } from "pg";

// CRUD for tests. A test is created draft; lifecycle = start/pause/end.

export type ChangeInput = {
  mode: "inject" | "edit" | "price" | "redirect";
  custom_css?: string | null;
  custom_js?: string | null;
  js_mode?: string | null;
  selectors?: string[] | null;
  op?: string | null;
  insert_type?: string | null;
  html?: string | null;
  variant_id?: string | null;   // price mode
  test_price?: number | null;   // price mode
  /**
   * price mode:    scope the display rewrite to one PDP.
   * redirect mode: the DESTINATION to send this arm to (same-origin path or URL).
   * Which pages a redirect fires on comes from the test's page-scope rules.
   */
  url_path?: string | null;
};
export type VariationInput = {
  name: string;
  is_control?: boolean;
  percentage: number;
  changes?: ChangeInput[];
};
export type RuleInput = { scope: "page" | "audience"; rule_group?: number; key: string; op: string; value?: string | null };
export type TestInput = {
  name: string;
  description?: string | null;
  primary_metric?: string;
  exclusion_group?: string | null;
  type?: string | null;   // 'content' (default) | 'price'
  rules?: RuleInput[];
  variations: VariationInput[];
};

export async function createTest(input: TestInput): Promise<string> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();
  // A test is a price test if any variation carries a price change (or explicitly typed).
  const isPrice =
    input.type === "price" ||
    input.variations.some((v) => (v.changes || []).some((c) => c.mode === "price"));
  try {
    await client.query("begin");
    const t = await client.query(
      `insert into split.tests (name, description, primary_metric, exclusion_group, type)
       values ($1,$2,coalesce($3,'net_revenue_per_visitor'),$4,$5) returning id`,
      [input.name, input.description ?? null, input.primary_metric ?? null,
       input.exclusion_group ?? null, isPrice ? "price" : "content"]
    );
    const testId = t.rows[0].id;
    await insertVariations(client, testId, input.variations);
    await insertRules(client, testId, input.rules || []);
    await client.query("commit");
    return testId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function insertVariations(client: PoolClient, testId: string, variations: VariationInput[]) {
  for (let i = 0; i < variations.length; i++) {
    const v = variations[i];
    const vr = await client.query(
      `insert into split.variations (test_id,name,is_control,percentage,ord) values ($1,$2,$3,$4,$5) returning id`,
      [testId, v.name, !!v.is_control, v.percentage, i]
    );
    const varId = vr.rows[0].id;
    const changes = v.changes || [];
    for (let j = 0; j < changes.length; j++) {
      const c = changes[j];
      await client.query(
        `insert into split.variation_changes
           (variation_id,mode,custom_css,custom_js,js_mode,selectors,op,insert_type,html,variant_id,test_price,url_path,ord)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [varId, c.mode, c.custom_css ?? null, c.custom_js ?? null, c.js_mode ?? "immediately",
         c.selectors ?? null, c.op ?? null, c.insert_type ?? null, c.html ?? null,
         c.variant_id ?? null, c.test_price ?? null, c.url_path ?? null, j]
      );
    }
  }
}

async function insertRules(client: PoolClient, testId: string, rules: RuleInput[]) {
  for (const r of rules) {
    await client.query(
      `insert into split.targeting_rules (test_id,scope,rule_group,key,op,value) values ($1,$2,$3,$4,$5,$6)`,
      [testId, r.scope, r.rule_group ?? 0, r.key, r.op, r.value ?? null]
    );
  }
}

export async function setStatus(id: string, action: "start" | "pause" | "end"): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  if (action === "start") {
    await pool.query(
      `update split.tests set status='running', started_at=coalesce(started_at, now()) where id=$1`,
      [id]
    );
  } else if (action === "pause") {
    await pool.query(`update split.tests set status='paused' where id=$1`, [id]);
  } else {
    await pool.query(`update split.tests set status='ended', ended_at=now() where id=$1`, [id]);
  }
}

export async function deleteTest(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`delete from split.tests where id=$1`, [id]);
}

export async function getTestFull(id: string) {
  await ensureSchema();
  const pool = getPool();
  const [t, vars, changes, rules] = await Promise.all([
    pool.query(`select * from split.tests where id=$1`, [id]),
    pool.query(`select * from split.variations where test_id=$1 order by ord`, [id]),
    pool.query(
      `select vc.* from split.variation_changes vc join split.variations v on v.id=vc.variation_id
       where v.test_id=$1 order by vc.ord`, [id]
    ),
    pool.query(`select * from split.targeting_rules where test_id=$1 order by rule_group`, [id]),
  ]);
  if (!t.rows.length) return null;
  return { test: t.rows[0], variations: vars.rows, changes: changes.rows, rules: rules.rows };
}
