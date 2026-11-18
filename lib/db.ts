import { Pool } from "pg";

// One pool per process (survives Next.js HMR via globalThis). lw-split owns the
// `split` schema and READS the order/pixel tables in `attribution.*` (see DATA-CONTRACT.md).
const g = globalThis as unknown as { __splitPool?: Pool };

export function getPool(): Pool {
  if (!g.__splitPool) {
    const cs = process.env.DATABASE_URL;
    if (!cs) throw new Error("DATABASE_URL is not set");
    g.__splitPool = new Pool({
      connectionString: cs,
      ssl: { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return g.__splitPool;
}

// Additive, idempotent. Creates ONLY `split.*` objects — never touches attribution.
const DDL = `
create schema if not exists split;

create table if not exists split.tests (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  status          text not null default 'draft',
  type            text not null default 'content',
  exclusion_group text,
  primary_metric  text not null default 'net_revenue_per_visitor',
  analytics_view  text not null default 'sitewide_orders',
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  ended_at        timestamptz
);
create index if not exists split_tests_status_idx on split.tests (status);

create table if not exists split.targeting_rules (
  id         uuid primary key default gen_random_uuid(),
  test_id    uuid not null references split.tests(id) on delete cascade,
  scope      text not null,
  rule_group int  not null default 0,
  key        text not null,
  op         text not null,
  value      text
);
create index if not exists split_targeting_test_idx on split.targeting_rules (test_id);

create table if not exists split.variations (
  id         uuid primary key default gen_random_uuid(),
  test_id    uuid not null references split.tests(id) on delete cascade,
  name       text not null,
  is_control boolean not null default false,
  percentage numeric not null,
  ord        int not null default 0
);
create index if not exists split_variations_test_idx on split.variations (test_id);

create table if not exists split.variation_changes (
  id           uuid primary key default gen_random_uuid(),
  variation_id uuid not null references split.variations(id) on delete cascade,
  mode         text not null,               -- 'inject' | 'edit' | 'price'
  custom_css   text,
  custom_js    text,
  js_mode      text default 'immediately',
  selectors    text[],
  op           text,
  insert_type  text,
  html         text,
  is_html      boolean default true,
  ord          int not null default 0
);
create index if not exists split_changes_variation_idx on split.variation_changes (variation_id);

-- Price-test columns (additive; null for content changes). A price change row is
-- mode='price' with a target variant + the test price + the display selectors to
-- rewrite. The DISPLAY price lives here (runtime); the authoritative CHARGE price is
-- mirrored into the cart-transform Function's own metafield (see /api/split/pricemap).
alter table split.variation_changes add column if not exists variant_id text;   -- ProductVariant GID
alter table split.variation_changes add column if not exists test_price numeric; -- store currency, major units
-- Multi-PDP price tests: scope a price change's DISPLAY rewrite to one product page so
-- N price rules (one per SKU) can live in one variation without fighting over a shared
-- selector. null = apply on any matched page. (Charge side keys by variant, needs no scope.)
alter table split.variation_changes add column if not exists url_path text;

create table if not exists split.assignments (
  anon_id      text not null,
  test_id      uuid not null references split.tests(id) on delete cascade,
  variation_id uuid not null references split.variations(id),
  assigned_at  timestamptz not null default now(),
  primary key (anon_id, test_id)
);
create index if not exists split_assign_test_idx on split.assignments (test_id, variation_id);

create table if not exists split.events (
  id           bigserial primary key,
  anon_id      text not null,
  test_id      uuid,
  variation_id uuid,
  name         text not null,
  url_path     text,
  device       text,
  source       text,
  country      text,
  order_id     bigint,
  ts           timestamptz not null default now()
);
create index if not exists split_events_test_idx on split.events (test_id, variation_id);
create index if not exists split_events_anon_idx on split.events (anon_id);
create index if not exists split_events_time_idx on split.events (ts);
`;

let ensured = false;
export async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await getPool().query(DDL);
  ensured = true;
}
