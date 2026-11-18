-- The tables lw-split READS but does not own.
--
-- In our setup these are filled by a separate first-party attribution app (a pixel on
-- the storefront plus a Shopify order sync). lw-split never writes to them. You need
-- something that fills the same columns; the rest of each table can be whatever you like.
-- See DATA-CONTRACT.md for what each column means and how the visitor id gets onto orders.
--
-- `npm run schema` creates only the `split.*` tables. Run this file yourself if you
-- don't already have equivalents.

create schema if not exists attribution;

-- One row per Shopify order.
create table if not exists attribution.orders (
  id               bigint primary key,            -- Shopify order id
  created_at       timestamptz not null,
  pixel_visitor_id text,                          -- the visitor id the order carried (cart attribute)
  total_price      numeric not null default 0,    -- order total incl. tax + shipping
  total_refunded   numeric not null default 0,
  total_tax        numeric not null default 0,
  tags             text[] not null default '{}',  -- used to flag first subscription orders
  test             boolean not null default false,-- Shopify test orders, excluded everywhere
  cancelled_at     timestamptz
);
create index if not exists attribution_orders_vid_idx on attribution.orders (pixel_visitor_id, created_at);

-- Line items, for COGS / profit per visitor.
create table if not exists attribution.order_items (
  order_id bigint not null references attribution.orders(id) on delete cascade,
  sku      text,
  quantity int not null default 1
);
create index if not exists attribution_order_items_order_idx on attribution.order_items (order_id);

-- Unit cost per SKU. Results show "COGS coverage" = share of units with a cost here.
create table if not exists attribution.unit_costs (
  sku  text primary key,
  cost numeric not null
);

-- Pixel events. Only add_to_cart and checkout_start are read (add-to-cart rate).
create table if not exists attribution.pixel_events (
  visitor_id  text not null,
  event_type  text not null,
  occurred_at timestamptz not null default now()
);
create index if not exists attribution_pixel_events_vid_idx on attribution.pixel_events (visitor_id, event_type, occurred_at);

-- First-touch info per visitor, for the channel and landing-page segments.
create table if not exists attribution.pixel_visitors (
  visitor_id        text primary key,
  first_utm_source  text,
  first_utm_medium  text,
  first_referrer    text,
  first_landing_url text,
  first_fbclid      text,
  first_gclid       text
);
