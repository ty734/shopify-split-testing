import { getPool, ensureSchema } from "@/lib/db";

// Compile every RUNNING test into the compact JSON the storefront runtime needs.
// This is what GET /api/split/config returns and what the theme embed inlines as
// window.__LWSPLIT_CONFIG__ (zero network on the assignment path).

export type CompiledChange = {
  mode: "inject" | "edit" | "price";
  custom_css?: string | null;
  custom_js?: string | null;
  js_mode?: string | null;
  selectors?: string[] | null;
  op?: string | null;
  insert_type?: string | null;
  html?: string | null;
  variant_id?: string | null;   // price mode: target ProductVariant GID
  test_price?: number | null;   // price mode: display price (major units, store currency)
  url_path?: string | null;     // price mode: scope the DISPLAY rewrite to one PDP (multi-SKU tests)
};
export type CompiledVariation = {
  id: string;
  is_control: boolean;
  percentage: number;
  changes: CompiledChange[];
};
export type CompiledRule = { scope: string; rule_group: number; key: string; op: string; value: string | null };
export type CompiledTest = {
  id: string;
  name: string;                 // QA only: labels the ?lwsplit_preview badge in the runtime
  status: string;               // always 'running' except a keyed preview of a draft test
  exclusion_group: string | null;
  rules: CompiledRule[];
  variations: CompiledVariation[];
};

// `includeTestId` additionally compiles ONE non-running test so it can be previewed
// before launch. Only ever set from a key-verified request (see lib/preview.ts) — the
// public config must never carry draft content, and the runtime refuses to apply a
// non-running test unless that test is the one being forced.
export async function compileConfig(
  opts: { includeTestId?: string | null } = {}
): Promise<{ tests: CompiledTest[]; selectors: string[] }> {
  await ensureSchema();
  const pool = getPool();
  const extra = opts.includeTestId || null;

  const { rows: tests } = await pool.query(
    `select id, name, status, exclusion_group from split.tests
      where status = 'running' or ($1::uuid is not null and id = $1::uuid)`,
    [extra]
  );
  if (!tests.length) return { tests: [], selectors: [] };
  const ids = tests.map((t) => t.id);

  const [{ rows: rules }, { rows: vars }, { rows: changes }] = await Promise.all([
    pool.query(`select test_id, scope, rule_group, key, op, value from split.targeting_rules where test_id = any($1)`, [ids]),
    pool.query(`select id, test_id, is_control, percentage from split.variations where test_id = any($1) order by ord`, [ids]),
    pool.query(
      `select vc.variation_id, vc.mode, vc.custom_css, vc.custom_js, vc.js_mode,
              vc.selectors, vc.op, vc.insert_type, vc.html, vc.variant_id, vc.test_price, vc.url_path
         from split.variation_changes vc
         join split.variations v on v.id = vc.variation_id
        where v.test_id = any($1) order by vc.ord`,
      [ids]
    ),
  ]);

  const changesByVar = new Map<string, CompiledChange[]>();
  for (const c of changes) {
    const list = changesByVar.get(c.variation_id) || [];
    list.push({
      mode: c.mode,
      custom_css: c.custom_css,
      custom_js: c.custom_js,
      js_mode: c.js_mode,
      selectors: c.selectors,
      op: c.op,
      insert_type: c.insert_type,
      html: c.html,
      variant_id: c.variant_id ?? null,
      test_price: c.test_price == null ? null : Number(c.test_price),
      url_path: c.url_path ?? null,
    });
    changesByVar.set(c.variation_id, list);
  }

  const selectorSet = new Set<string>(); // powers the anti-flicker hide list
  const compiled: CompiledTest[] = tests.map((t) => {
    const variations: CompiledVariation[] = vars
      .filter((v) => v.test_id === t.id)
      .map((v) => {
        const ch = changesByVar.get(v.id) || [];
        // Anti-flicker: only hide anchors we MODIFY (replace/remove). Inserts add
        // new content, so there's nothing to hide — hiding the anchor would flash-
        // hide existing content (e.g. the product title) for no reason.
        for (const c of ch) {
          if (c.mode === "edit" && (c.op === "replace" || c.op === "remove")) {
            (c.selectors || []).forEach((s) => selectorSet.add(s));
          }
          // Price changes rewrite existing price text → hide until rewritten so the
          // original price never flashes (only for non-control variants that carry a
          // test price; control keeps the real price, no rewrite, nothing to hide).
          if (c.mode === "price" && !v.is_control && c.test_price != null) {
            (c.selectors || []).forEach((s) => selectorSet.add(s));
          }
        }
        return { id: v.id, is_control: v.is_control, percentage: Number(v.percentage), changes: ch };
      });
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      exclusion_group: t.exclusion_group,
      rules: rules
        .filter((r) => r.test_id === t.id)
        .map((r) => ({ scope: r.scope, rule_group: r.rule_group, key: r.key, op: r.op, value: r.value })),
      variations,
    };
  });

  return { tests: compiled, selectors: [...selectorSet] };
}

// The AUTHORITATIVE charge-price map for the cart-transform Function. This is the
// JSON written to the CartTransform's own metafield ($app:lwsplit / prices) — the
// Function reads it via its input query and NEVER trusts a client-supplied price.
// Shape: { "<testId>:<variationId>": { "<variantGID>": <price major units> } }.
// Only RUNNING tests, only non-control variations that carry a variant + test price.
export async function compilePriceMap(): Promise<Record<string, Record<string, number>>> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `select v.test_id, vc.variation_id, vc.variant_id, vc.test_price
       from split.variation_changes vc
       join split.variations v on v.id = vc.variation_id
       join split.tests t on t.id = v.test_id
      where t.status = 'running' and t.type = 'price'
        and vc.mode = 'price' and v.is_control = false
        and vc.variant_id is not null and vc.test_price > 0`
  );
  const map: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const key = `${r.test_id}:${r.variation_id}`;
    (map[key] = map[key] || {})[r.variant_id] = Number(r.test_price);
  }
  return map;
}
