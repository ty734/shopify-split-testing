# Data contract: where revenue and profit come from

lw-split records **who saw which arm** itself (`split.events`). It does **not** collect
orders. Results come from joining those exposures to orders by a shared **visitor id**,
so whatever you use must get that id onto the order.

```
visitor lands ──► runtime buckets them by visitor id ──► exposure row in split.events
     │
     └─ same visitor id written to the cart as an attribute ──► lands on the order
                                                                    │
order sync (webhook or API pull) ──► attribution.orders.pixel_visitor_id
                                                                    │
results = exposures JOIN orders ON visitor id, orders placed AFTER first exposure
```

## The visitor id

- Stored in `localStorage` and a first-party cookie, key `_lwvid` by default
  (override with `window.__LWSPLIT_VID_KEY__`).
- In our store a separate pixel mints it. If nothing mints one within ~1.8s, the
  runtime mints its own (turn that off with `window.__LWSPLIT_MINT_ID__ = false`).
- **It has to reach the order.** We write it as a cart attribute once per session:

```js
fetch("/cart/update.js", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ attributes: { _lwvid: visitorId } }),
});
```

  Then your order sync reads `note_attributes` → `_lwvid` into
  `attribution.orders.pixel_visitor_id`.

- **Gotcha we hit:** `/cart/{variant}:{qty}` permalinks wipe all cart attributes but
  keep the same cart token. If your landing pages use permalinks, append
  `?attributes[_lwvid]=<id>` to the permalink, or re-write the attribute on every
  page load rather than once per session.

## Tables read

Full DDL in [`schema/attribution-contract.sql`](schema/attribution-contract.sql).

| Table | Columns used | Used for |
|---|---|---|
| `attribution.orders` | `id, created_at, pixel_visitor_id, total_price, total_refunded, total_tax, tags, test, cancelled_at` | conversion, revenue, AOV, new vs returning |
| `attribution.order_items` | `order_id, sku, quantity` | COGS, units |
| `attribution.unit_costs` | `sku, cost` | profit per visitor, COGS coverage % |
| `attribution.pixel_events` | `visitor_id, event_type ('add_to_cart','checkout_start'), occurred_at` | add-to-cart rate |
| `attribution.pixel_visitors` | `visitor_id, first_utm_source, first_utm_medium, first_referrer, first_landing_url, first_fbclid, first_gclid` | channel and landing-page segments |

Definitions used in results (`lib/results.ts`):

- **Net revenue** = `total_price - total_refunded - total_tax`
- **Profit** = net revenue - sum(quantity × unit cost)
- Per-order revenue is winsorized at mean + 3σ so one huge order can't decide a test.
- Cancelled and Shopify test orders are excluded.
- Subscription enrollment = an order tagged `Subscription First Order` (Recharge's tag).
  Change it in `lib/results.ts` if your subscription app tags differently.

If you'd rather not keep the schema name `attribution`, it's a find-and-replace in
`lib/results.ts` and `scripts/`.
